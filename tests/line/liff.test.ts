/**
 * WO-4.E DoD — หน้า LIFF
 *
 *   · 🔴 ไม่มี endpoint พิเศษของ LIFF — ปุ่มเรียก server action ตัวเดียวกับหน้าเว็บปกติ
 *   · 🔴 ยอดค้างอ่านผ่าน ledger + `moneyFromDb()` (ไม่นับจาก `payments.status`)
 *   · ที่นั่งว่างนับแบบเดียวกับ DB function ([D-10] confirmed + checked_in)
 *   · ก๊วนที่ปิด `features.line` เข้าไม่ได้ (gate ด้วย `can()` เหมือน action)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY, serviceClient } from '../helpers/db';
import { can } from '@/domain/permissions/can';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { buildLiffView } = await import('@/server/line/liff');

afterAll(async () => {
  await pool.end();
});

/**
 * อ่านโค้ดโดย **ตัดคอมเมนต์ทิ้งก่อน** — คอมเมนต์ของไฟล์เหล่านี้อธิบายไว้เองว่า
 * "ไม่เชื่อ `liff.getProfile()`" / "ไม่ใช้ `supabaseAdmin()`" ⇒ ถ้าไม่ตัด เทสต์จะไปจับ
 * คำอธิบายของตัวเองแทนที่จะจับโค้ดจริง
 */
const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`liff-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function fixture() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนลิฟ-${crypto.randomUUID()}`,
  ]);

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
     values ($1, 'ซ้อมเย็นนี้', now() + interval '2 hours', now() + interval '4 hours',
             4, 'draft', '{"snapshot_version":1}'::jsonb, $2)
     returning id`,
    [gang.id, owner],
  );

  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  return { owner, gangId: gang.id, sessionId: session.id };
}

async function addMember(gangId: string): Promise<{ userId: string; memberId: string }> {
  const userId = await newUser();
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
    [gangId, userId],
  );
  return { userId, memberId: row.id };
}

async function view(gangId: string, userId: string, memberId: string | null) {
  return buildLiffView(serviceClient(), { gangId, userId, gangMemberId: memberId });
}

describe('WO-4.E DoD — นัดที่เปิดรับ', () => {
  it('เห็นนัดที่เปิดอยู่พร้อมจำนวนที่ว่าง', async () => {
    const { gangId, sessionId } = await fixture();
    const me = await addMember(gangId);

    const result = await view(gangId, me.userId, me.memberId);
    const session = result.sessions.find((s) => s.id === sessionId);

    expect(session).toBeDefined();
    expect(session?.seatsLeft).toBe(4);
    expect(session?.myRegistration).toBeNull();
  });

  it('ลงชื่อแล้วเห็นสถานะของตัวเอง และที่ว่างลดลง', async () => {
    const { gangId, sessionId } = await fixture();
    const me = await addMember(gangId);

    await pool.query(`select public.register_to_session($1, $2)`, [sessionId, me.userId]);

    const result = await view(gangId, me.userId, me.memberId);
    const session = result.sessions.find((s) => s.id === sessionId)!;

    expect(session.myRegistration?.status).toBe('confirmed');
    expect(session.seatsLeft).toBe(3);
  });

  it('🔴 ที่ว่างนับ confirmed + checked_in เหมือน DB function [D-10]', async () => {
    const { gangId, sessionId, owner } = await fixture();
    const me = await addMember(gangId);

    // คนอื่นลงชื่อจนเต็มแล้วเช็คอินหนึ่งคน
    for (let i = 0; i < 4; i++) {
      const other = await addMember(gangId);
      const {
        rows: [reg],
      } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
        sessionId,
        other.userId,
      ]);
      if (i === 0) {
        await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
      }
    }

    const result = await view(gangId, me.userId, me.memberId);
    const session = result.sessions.find((s) => s.id === sessionId)!;

    expect(session.seatsLeft).toBe(0);
  });

  it('นัดที่ยังไม่เปิด / ผ่านไปแล้ว ไม่โผล่', async () => {
    const { gangId, owner } = await fixture();
    const me = await addMember(gangId);

    const {
      rows: [past],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions
         (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
       values ($1, 'นัดที่ผ่านไปแล้ว', now() - interval '2 days', now() - interval '2 days' + interval '2 hours',
               4, 'draft', '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [gangId, owner],
    );
    await pool.query(`select public.transition_session($1, 'open', $2)`, [past.id, owner]);

    const {
      rows: [draft],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions
         (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
       values ($1, 'ยังไม่เปิด', now() + interval '3 days', now() + interval '3 days' + interval '2 hours',
               4, 'draft', '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [gangId, owner],
    );

    const result = await view(gangId, me.userId, me.memberId);
    const ids = result.sessions.map((s) => s.id);

    expect(ids).not.toContain(past.id);
    expect(ids).not.toContain(draft.id);
  });
});

describe('WO-4.E DoD — ยอดค้างของฉัน', () => {
  /** ปิดรอบให้เกิด charge จริงของนัดนั้น */
  async function chargeFor(sessionId: string, registrationId: string, amount: string, actor: string) {
    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'open', 'billing', $3)`,
      [
        sessionId,
        JSON.stringify([
          { registration_id: registrationId, amount, breakdown: { rounding_surplus: '0.00' } },
        ]),
        actor,
      ],
    );
  }

  it('🔴 นับหนี้จากนัดที่ปิดไปแล้วด้วย (ไม่ใช่แค่นัดที่เปิดอยู่)', async () => {
    const { gangId, sessionId, owner } = await fixture();
    const me = await addMember(gangId);

    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      sessionId,
      me.userId,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    await chargeFor(sessionId, reg.id, '250.00', owner);

    const result = await view(gangId, me.userId, me.memberId);

    // นัดปิดไปแล้ว ⇒ ไม่อยู่ในลิสต์ แต่หนี้ต้องยังอยู่
    expect(result.sessions.some((s) => s.id === sessionId)).toBe(false);
    expect(result.outstanding).toBe('250.00');
  });

  it('🔴 สลิปที่ยังไม่ verified ไม่ลดหนี้', async () => {
    const { gangId, sessionId, owner } = await fixture();
    const me = await addMember(gangId);

    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      sessionId,
      me.userId,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    await chargeFor(sessionId, reg.id, '300.00', owner);

    const {
      rows: [charge],
    } = await pool.query<{ id: string }>(
      `select id from public.session_charges where session_id = $1 limit 1`,
      [sessionId],
    );

    const {
      rows: [payment],
    } = await pool.query<{ id: string }>(
      `select id from public.create_payment_for_charges($1, $2, $3::uuid[], $2)`,
      [gangId, me.userId, [charge.id]],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      me.userId,
    ]);

    expect((await view(gangId, me.userId, me.memberId)).outstanding).toBe('300.00');

    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [payment.id, owner]);

    expect((await view(gangId, me.userId, me.memberId)).outstanding).toBe('0.00');
  });

  it('🔴 หนี้ของคนอื่นไม่ปนมาในยอดของเรา (แม้ผู้ใช้จะเป็นแอดมิน)', async () => {
    const { gangId, sessionId, owner } = await fixture();
    const other = await addMember(gangId);

    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      sessionId,
      other.userId,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    await chargeFor(sessionId, reg.id, '500.00', owner);

    const {
      rows: [ownerMember],
    } = await pool.query<{ id: string }>(
      `select id from public.gang_members where gang_id = $1 and user_id = $2`,
      [gangId, owner],
    );

    // เจ้าของก๊วนเห็น charge ทั้งก๊วนตาม RLS — แต่ยอด "ของฉัน" ต้องเป็น 0
    expect((await view(gangId, owner, ownerMember.id)).outstanding).toBe('0.00');
    expect((await view(gangId, other.userId, other.memberId)).outstanding).toBe('500.00');
  });
});

describe('WO-4.E DoD — ไม่มีทางลัดที่ข้ามสิทธิ์', () => {
  const panel = source('features/line/LiffPanel.tsx');
  const page = source('app/gangs/[gangId]/liff/page.tsx');
  const loader = source('server/line/liff.ts');

  it('🔴 ปุ่มในหน้า LIFF เรียก server action ตัวเดียวกับหน้าเว็บปกติ', () => {
    expect(panel).toMatch(/from '@\/server\/actions\/registrations'/);
    expect(panel).toMatch(/registerSelf/);
    expect(panel).toMatch(/cancelRegistration/);
  });

  it('🔴 ไม่มีการใช้ service-role ในเส้นทางของหน้า LIFF', () => {
    for (const file of [panel, page, loader]) {
      expect(file).not.toMatch(/supabaseAdmin\(/);
    }
  });

  it('🔴 ไม่เชื่อ liff.getProfile() เป็นการยืนยันตัวตน (ไม่มี LIFF SDK ในเส้นทางนี้เลย)', () => {
    for (const file of [panel, page, loader]) {
      expect(file).not.toMatch(/getProfile|liff\.init|@line\/liff/);
    }
  });

  it('หน้า LIFF ยัง gate ด้วย can() + features.line เหมือน action', () => {
    expect(page).toMatch(/can\(\{ role, features \}, 'line\.link\.self'\)/);

    const off = { line: false, discovery: true, guests: true, coupons: true, statistics: true };
    expect(can({ role: 'member', features: off }, 'line.link.self')).toBe(false);
  });
});
