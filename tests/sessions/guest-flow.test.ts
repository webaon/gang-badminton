/**
 * WO-2.5 DoD — guest flow
 *
 *   · `guest_access_token_hash` ถูก generate · คืน plaintext ครั้งเดียว · เก็บแค่ hash
 *   · guest ใช้ token ข้าม session ไม่ได้
 *   · ห้ามมี plaintext token ใน `event_logs`
 *   · E2E: ลงชื่อจนเต็ม → waitlist → ยกเลิก → คนหัวคิวถูกเลื่อนอัตโนมัติ
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, registrationsOf } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`g-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วน + นัดที่เปิดรับสมัครแล้ว */
async function openSession(maxPlayers = 2) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(
    `insert into public.gang_pricing_plans (gang_id, name, type, params)
     values ($1, 'เหมาจ่าย', 'flat_rate', '{"amount_per_person": "200.00"}'::jsonb)`,
    [gang.id],
  );

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, allow_guests, snapshot, created_by)
     values ($1, 'ซ้อม', now() + interval '2 days', now() + interval '2 days 2 hours', $2, true,
             '{"snapshot_version": 1, "cancellation_policy": {"cutoff_hours": 12, "allow_cancel_after_cutoff": true, "penalty_type": "full_share"}}'::jsonb,
             $3)
     returning id`,
    [gang.id, maxPlayers, owner],
  );

  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  return { owner, gangId: gang.id, sessionId: session.id };
}

async function createInvite(sessionId: string, actorId: string, maxUses = 20) {
  const {
    rows: [row],
  } = await pool.query<{ id: string; token: string }>(
    `select * from public.create_session_invite($1, null, $2, $3)`,
    [sessionId, maxUses, actorId],
  );
  return row;
}

describe('WO-2.5 — ลิงก์เชิญ', () => {
  it('สร้างลิงก์แล้วได้ plaintext ครั้งเดียว · ฐานข้อมูลเก็บแค่ hash', async () => {
    const { sessionId, owner } = await openSession();
    const invite = await createInvite(sessionId, owner);

    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const {
      rows: [stored],
    } = await pool.query<{ token_hash: Buffer; matches: boolean }>(
      `select token_hash, token_hash = extensions.digest($2, 'sha256') as matches
         from public.session_invite_tokens where id = $1`,
      [invite.id, invite.token],
    );

    expect(stored.matches).toBe(true);
    // 🔴 ไม่มีคอลัมน์ไหนเก็บ plaintext
    expect(stored.token_hash.toString('utf8')).not.toContain(invite.token);
  });

  it('🔴 ไม่มี plaintext token ใน event_logs', async () => {
    const { sessionId, owner } = await openSession();
    const invite = await createInvite(sessionId, owner);

    const { rows } = await pool.query<{ payload: unknown }>(
      `select payload from public.event_logs
        where session_id = $1 and event_type = 'session.invite_created'`,
      [sessionId],
    );

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].payload)).not.toContain(invite.token);
  });

  it('หา session จาก token ได้ · token ผิด/หมดอายุ/ใช้ครบ → ไม่คืนอะไร', async () => {
    const { sessionId, owner } = await openSession();
    const invite = await createInvite(sessionId, owner, 1);

    const found = await pool.query(`select * from public.session_by_invite_token($1)`, [
      invite.token,
    ]);
    expect(found.rows).toHaveLength(1);

    const wrong = await pool.query(`select * from public.session_by_invite_token($1)`, [
      'token-มั่ว',
    ]);
    expect(wrong.rows).toHaveLength(0);

    // ใช้ครบโควต้าแล้วต้องหาไม่เจอ
    await pool.query(`select * from public.register_guest($1, $2, null, $3)`, [
      sessionId,
      'แขก',
      invite.token,
    ]);
    const exhausted = await pool.query(`select * from public.session_by_invite_token($1)`, [
      invite.token,
    ]);
    expect(exhausted.rows).toHaveLength(0);
  });

  it('ลิงก์ที่ถูก revoke หรือหมดอายุ ใช้ไม่ได้', async () => {
    const { sessionId, owner } = await openSession();

    const expired = await createInvite(sessionId, owner);
    await pool.query(
      `update public.session_invite_tokens set expires_at = now() - interval '1 day' where id = $1`,
      [expired.id],
    );
    expect(
      (await pool.query(`select * from public.session_by_invite_token($1)`, [expired.token])).rows,
    ).toHaveLength(0);

    const revoked = await createInvite(sessionId, owner);
    await pool.query(`update public.session_invite_tokens set revoked_at = now() where id = $1`, [
      revoked.id,
    ]);
    expect(
      (await pool.query(`select * from public.session_by_invite_token($1)`, [revoked.token])).rows,
    ).toHaveLength(0);
  });
});

describe('WO-2.5 — guest access token', () => {
  it('ลงชื่อแล้วได้ token ดูสถานะเอง · ฐานข้อมูลเก็บแค่ hash', async () => {
    const { sessionId, owner } = await openSession();
    const invite = await createInvite(sessionId, owner);

    const {
      rows: [guest],
    } = await pool.query<{ registration_id: string; status: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขกคนที่หนึ่ง', invite.token],
    );

    expect(guest.status).toBe('confirmed');
    expect(guest.guest_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const {
      rows: [stored],
    } = await pool.query<{ matches: boolean }>(
      `select guest_access_token_hash = extensions.digest($2, 'sha256') as matches
         from public.session_registrations where id = $1`,
      [guest.registration_id, guest.guest_token],
    );
    expect(stored.matches).toBe(true);
  });

  it('ดูสถานะด้วย token ที่ถูกต้องได้ · token ผิด → GUEST_ACCESS_DENIED', async () => {
    const { sessionId, owner } = await openSession();
    const invite = await createInvite(sessionId, owner);
    const {
      rows: [guest],
    } = await pool.query<{ registration_id: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขก', invite.token],
    );

    const ok = await pool.query(`select * from public.guest_registration($1, $2)`, [
      guest.registration_id,
      guest.guest_token,
    ]);
    expect(ok.rows).toHaveLength(1);

    await expect(
      pool.query(`select * from public.guest_registration($1, $2)`, [
        guest.registration_id,
        'token-ผิด',
      ]),
    ).rejects.toThrow(/GUEST_ACCESS_DENIED/);
  });

  it('🔴 token ของ guest คนหนึ่ง ใช้ดู/ยกเลิกของอีกคนไม่ได้', async () => {
    const { sessionId, owner } = await openSession(4);
    const invite = await createInvite(sessionId, owner);

    const {
      rows: [a],
    } = await pool.query<{ registration_id: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขก A', invite.token],
    );
    const {
      rows: [b],
    } = await pool.query<{ registration_id: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขก B', invite.token],
    );

    await expect(
      pool.query(`select * from public.guest_registration($1, $2)`, [
        b.registration_id,
        a.guest_token,
      ]),
    ).rejects.toThrow(/GUEST_ACCESS_DENIED/);

    await expect(
      pool.query(`select * from public.cancel_registration_as_guest($1, $2)`, [
        b.registration_id,
        a.guest_token,
      ]),
    ).rejects.toThrow(/GUEST_ACCESS_DENIED/);
  });

  it('guest ยกเลิกเองได้ด้วย token ของตัวเอง', async () => {
    const { sessionId, owner } = await openSession();
    const invite = await createInvite(sessionId, owner);
    const {
      rows: [guest],
    } = await pool.query<{ registration_id: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขก', invite.token],
    );

    const {
      rows: [cancelled],
    } = await pool.query<{ status: string }>(
      `select * from public.cancel_registration_as_guest($1, $2)`,
      [guest.registration_id, guest.guest_token],
    );

    expect(cancelled.status).toBe('cancelled');
  });
});

describe('WO-2.5 E2E — ลงชื่อจนเต็ม → waitlist → ยกเลิก → เลื่อนคิวอัตโนมัติ', () => {
  it('เส้นเต็มทำงานถูกต้อง', async () => {
    const { sessionId, owner } = await openSession(2);
    const invite = await createInvite(sessionId, owner);

    // สมาชิกสองคนแรกได้ที่
    const m1 = await newUser();
    const m2 = await newUser();
    for (const u of [m1, m2]) {
      await pool.query(`insert into public.gang_members (gang_id, user_id, role)
                        select gang_id, $2, 'member' from public.sessions where id = $1`, [
        sessionId,
        u,
      ]);
      await pool.query(`select public.register_to_session($1, $2)`, [sessionId, u]);
    }

    // guest มาทีหลัง → เข้าคิวรอ
    const {
      rows: [guest],
    } = await pool.query<{ registration_id: string; status: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขกมาช้า', invite.token],
    );
    expect(guest.status).toBe('waitlist');

    // คนที่ได้ที่ยกเลิก → guest ถูกเลื่อนขึ้นอัตโนมัติ (อยู่ใน cancel_registration)
    const before = await registrationsOf(sessionId);
    const firstConfirmed = before.find((r) => r.user_id === m1)!;
    await pool.query(`select public.cancel_registration($1, $2)`, [firstConfirmed.id, m1]);

    const after = await registrationsOf(sessionId);
    const guestRow = after.find((r) => r.id === guest.registration_id)!;
    expect(guestRow.status).toBe('confirmed');

    // ไม่เกินโควต้า
    expect(after.filter((r) => ['confirmed', 'checked_in'].includes(r.status))).toHaveLength(2);

    // guest ยังใช้ token เดิมดูสถานะได้หลังถูกเลื่อนคิว
    const {
      rows: [view],
    } = await pool.query<{ status: string }>(`select * from public.guest_registration($1, $2)`, [
      guest.registration_id,
      guest.guest_token,
    ]);
    expect(view.status).toBe('confirmed');
  });

  it('guest ลงชื่อตอน features.guests ปิด → ถูกปฏิเสธแม้มีลิงก์ที่ถูกต้อง', async () => {
    const { sessionId, owner, gangId } = await openSession(4);
    const invite = await createInvite(sessionId, owner);

    await pool.query(
      `update public.gangs set features = features || '{"guests": false}'::jsonb where id = $1`,
      [gangId],
    );

    await expect(
      pool.query(`select * from public.register_guest($1, $2, null, $3)`, [
        sessionId,
        'แขก',
        invite.token,
      ]),
    ).rejects.toThrow(/FEATURE_DISABLED/);
  });
});
