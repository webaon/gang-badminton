/**
 * WO-2.5-F DoD — QR เช็คอิน
 *
 *   · 🔴 **QR ของนัดหนึ่งใช้เช็คอินอีกนัดไม่ได้**
 *   · QR หมดอายุตามนัด (ปิดรอบ/ยกเลิกแล้วสแกนไม่ได้)
 *   · สแกนซ้ำไม่เปลี่ยนอะไร (idempotent)
 *   · token เก็บเป็น hash เท่านั้น · ❌ ไม่มี plaintext ใน `event_logs`
 *   · ❌ เช็คอินจาก `waitlist` ตรงไม่ได้
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`qr-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** นัดที่เปิดรับ + สมาชิก n คนลงชื่อ (เกินโควต้าตกไป waitlist) */
async function openSession(n: number, maxPlayers = n) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'สแกนเช็คอิน', now(), now() + interval '3 hours', $2,
             '{"snapshot_version":1}'::jsonb, $3)
     returning id`,
    [gang.id, maxPlayers, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const registrations: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, u],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      u,
    ]);
    registrations.push(reg.id);
  }

  return { owner, gangId: gang.id, sessionId: session.id, registrations };
}

async function issue(registrationId: string, actor: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ issue_checkin_token: string }>(
    `select public.issue_checkin_token($1, $2)`,
    [registrationId, actor],
  );
  return row.issue_checkin_token;
}

async function scan(sessionId: string, token: string, actor: string) {
  const {
    rows: [row],
  } = await pool.query<{
    registration_id: string;
    display_name: string;
    status: string;
    already: boolean;
  }>(`select * from public.check_in_by_token($1, $2, $3)`, [sessionId, token, actor]);
  return row;
}

describe('WO-2.5-F — ออก QR', () => {
  it('token เป็น base64url 43 ตัว · ฐานข้อมูลเก็บแค่ hash', async () => {
    const { registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const {
      rows: [stored],
    } = await pool.query<{ matches: boolean; raw: Buffer }>(
      `select checkin_token_hash = extensions.digest($2, 'sha256') as matches,
              checkin_token_hash as raw
         from public.session_registrations where id = $1`,
      [registrations[0], token],
    );

    expect(stored.matches).toBe(true);
    expect(stored.raw.toString('utf8')).not.toContain(token);
  });

  it('🔴 ไม่มี plaintext token ใน event_logs', async () => {
    const { registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    const { rows } = await pool.query<{ payload: unknown }>(
      `select payload from public.event_logs
        where aggregate_id = $1 and event_type = 'registration.checkin_token_issued'`,
      [registrations[0]],
    );

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].payload)).not.toContain(token);
  });

  it('ขอใหม่ = ของเดิมใช้ไม่ได้ทันที', async () => {
    const { sessionId, registrations, owner } = await openSession(1);
    const first = await issue(registrations[0], owner);
    const second = await issue(registrations[0], owner);

    expect(second).not.toBe(first);

    await expect(scan(sessionId, first, owner)).rejects.toThrow(/CHECKIN_TOKEN_INVALID/);
    await expect(scan(sessionId, second, owner)).resolves.toMatchObject({ already: false });
  });

  it('🔴 คนที่อยู่ waitlist ขอ QR ไม่ได้ (กันลัดคิว)', async () => {
    const { registrations, owner } = await openSession(3, 2);

    await expect(issue(registrations[2], owner)).rejects.toThrow(
      /INVALID_REGISTRATION_TRANSITION/,
    );
  });
});

describe('WO-2.5-F DoD — สแกนแล้วเช็คอิน', () => {
  it('confirmed → checked_in พร้อม event เหมือนกดจากคอนโซล', async () => {
    const { sessionId, registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    const result = await scan(sessionId, token, owner);
    expect(result).toMatchObject({ status: 'checked_in', already: false });

    const { rows } = await pool.query(
      `select 1 from public.event_logs
        where aggregate_id = $1 and event_type = 'registration.checked_in'`,
      [registrations[0]],
    );
    expect(rows).toHaveLength(1);
  });

  it('🔴 สแกนซ้ำ → already = true และไม่เกิด event ซ้ำ', async () => {
    const { sessionId, registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    await scan(sessionId, token, owner);
    const again = await scan(sessionId, token, owner);

    expect(again.already).toBe(true);

    const { rows } = await pool.query(
      `select 1 from public.event_logs
        where aggregate_id = $1 and event_type = 'registration.checked_in'`,
      [registrations[0]],
    );
    expect(rows).toHaveLength(1);
  });

  it('🔴 QR ของนัดหนึ่ง ใช้เช็คอินอีกนัดไม่ได้', async () => {
    const a = await openSession(1);
    const b = await openSession(1);

    const token = await issue(a.registrations[0], a.owner);

    await expect(scan(b.sessionId, token, b.owner)).rejects.toThrow(/CHECKIN_TOKEN_INVALID/);

    // ของนัดตัวเองยังใช้ได้ตามปกติ
    await expect(scan(a.sessionId, token, a.owner)).resolves.toMatchObject({ already: false });
  });

  it('token มั่ว → CHECKIN_TOKEN_INVALID (ไม่บอกว่าเป็นของนัดอื่นหรือไม่มีอยู่)', async () => {
    const { sessionId, owner } = await openSession(1);

    await expect(scan(sessionId, 'token-มั่ว', owner)).rejects.toThrow(/CHECKIN_TOKEN_INVALID/);
  });

  it('🔴 QR หมดอายุตามนัด — ปิดรอบแล้วสแกนไม่ได้', async () => {
    const { sessionId, registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    await pool.query(`select public.transition_session($1, 'in_play', $2)`, [sessionId, owner]);
    await pool.query(`select public.transition_session($1, 'billing', $2)`, [sessionId, owner]);

    await expect(scan(sessionId, token, owner)).rejects.toThrow(/SESSION_NOT_OPEN/);
  });

  it('นัดที่ยกเลิกแล้วสแกนไม่ได้', async () => {
    const { sessionId, registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    await pool.query(`select public.transition_session($1, 'cancelled', $2)`, [sessionId, owner]);

    await expect(scan(sessionId, token, owner)).rejects.toThrow(/SESSION_NOT_OPEN/);
  });

  it('🔴 ผู้ใช้ที่ล็อกอินอยู่เรียกฟังก์ชันตรงๆ ไม่ได้ (service_role เท่านั้น)', async () => {
    const { sessionId, registrations, owner } = await openSession(1);
    const token = await issue(registrations[0], owner);

    // ⚠️ แยกคนละ transaction — query แรกที่พังจะทำให้ transaction abort
    //    แล้ว query ถัดไปจะได้ error "transaction is aborted" แทนของจริง
    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select * from public.check_in_by_token($1, $2, $3)`, [sessionId, token, owner]),
      ).rejects.toThrow(/permission denied/i);
    });

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select public.issue_checkin_token($1, $2)`, [registrations[0], owner]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
