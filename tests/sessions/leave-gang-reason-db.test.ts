/**
 * [WO-B2.2] leaveGang() server action ผ่าน DB จริง — 2 เคสที่ planner สั่งให้พิสูจน์ก่อนปิดงาน
 *
 * ไม่ mock DB เลย (เหมือน tests/gangs/leave-transfer-gang.test.ts/tests/sessions/
 * member-credit-actions.test.ts) — mock เฉพาะ auth/next boundary (requireUser/headers/cache)
 * ตามธรรมเนียมเดียวกันทุกไฟล์ในกลุ่มนี้ ส่วน supabaseAdmin()/supabaseServer() ชี้ไปที่
 * serviceClient() ของ tests/helpers/db.ts (bypass RLS ได้ตั้งใจ — ที่นี่พิสูจน์ error mapping
 * ของ leaveGang() เอง ไม่ใช่พิสูจน์ RLS ซึ่งมี tests/rls/ แยกอยู่แล้ว)
 *
 * Fixture ทั้งสองเคสคัดลอกรูปแบบจาก tests/gangs/leave-transfer-gang.test.ts (createGang/addMember/
 * createSession/register) — ไฟล์นั้นพิสูจน์ RPC `leave_gang()` ตรงๆ แล้วว่า raise จริง ที่นี่พิสูจน์
 * ว่า TS action `leaveGang()` แปล error นั้นเป็น `reason`/`reasonMeta` ถูกต้องตาม WO-B2.2's table
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { pool, serviceClient, reloadPostgrestSchema } from '../helpers/db';

const h = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => serviceClient() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => serviceClient() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { leaveGang } from '@/server/actions/members';

beforeAll(async () => {
  await reloadPostgrestSchema();
});
afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`lgr-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function createGang(ownerId: string): Promise<{ id: string }> {
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    ownerId,
    `ก๊วน-leave-reason-${crypto.randomUUID()}`,
  ]);
  return gang;
}

async function addMember(gangId: string, role: 'member' | 'admin' | 'owner' = 'member'): Promise<string> {
  const userId = await newUser();
  await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`, [
    gangId,
    userId,
    role,
  ]);
  return userId;
}

async function createSession(
  gangId: string,
  createdBy: string,
  opts: { startsInHours: number; cutoffHours: number; allowCancelAfterCutoff: boolean },
): Promise<string> {
  const policy = { cutoff_hours: opts.cutoffHours, allow_cancel_after_cutoff: opts.allowCancelAfterCutoff };
  const snapshot = {
    snapshot_version: 1,
    cancellation_policy: policy,
    rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
    pricing_plan: { type: 'flat_rate', params: { amount_per_person: '150.00' } },
    promptpay_id: '0812345678',
  };
  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, allow_guests, snapshot, created_by)
     values ($1, 'WO-B2.2 leaveGang reason', now() + ($2 || ' hours')::interval,
             now() + (($2::numeric + 2) || ' hours')::interval,
             10, 'open', false, $3::jsonb, $4)
     returning id`,
    [gangId, String(opts.startsInHours), JSON.stringify(snapshot), createdBy],
  );
  return session.id;
}

async function register(sessionId: string, userId: string): Promise<void> {
  await pool.query(`select public.register_to_session($1, $2)`, [sessionId, userId]);
}

async function roleOf(gangId: string, userId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ role: string }>(
    `select role from public.gang_members where gang_id = $1 and user_id = $2 and deleted_at is null`,
    [gangId, userId],
  );
  return rows[0]?.role;
}

describe('[WO-B2.2] leaveGang() — reason/reasonMeta ผ่าน action จริง + DB จริง', () => {
  it('🔴 owner คนสุดท้ายออกไม่ได้ → code VALIDATION_ERROR, reason OWNER_MUST_TRANSFER, ยังเป็น owner อยู่เหมือนเดิม', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);

    // ยืนยัน fixture ตรงสมมติฐาน: create_gang() ใส่ owner เข้า gang_members ให้แล้วเป็น role='owner' คนเดียว
    expect(await roleOf(gang.id, owner)).toBe('owner');

    h.userId = owner;
    const res = await leaveGang(gang.id);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.reason).toBe('OWNER_MUST_TRANSFER');
      expect(res.error.reasonMeta).toBeUndefined();
    }

    // atomic: ยัง owner อยู่เหมือนเดิม ไม่ถูก soft-delete ไปครึ่งๆกลางๆ
    expect(await roleOf(gang.id, owner)).toBe('owner');
  });

  it('🔴 มีนัดที่เลย cutoff แล้วก๊วนห้ามยกเลิกหลัง cutoff → code CANCEL_CUTOFF_PASSED, reason HAS_LATE_CANCEL_REGISTRATION + reasonMeta {startsAt, cutoffAt} ไม่มี registration_id หลุดมา', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const leaver = await addMember(gang.id);

    // starts_at = now+3h, cutoff_hours=12 ⇒ cutoff_at = now-9h (เลยไปแล้ว) + allow_cancel_after_cutoff=false ⇒ blocked
    const session = await createSession(gang.id, owner, {
      startsInHours: 3,
      cutoffHours: 12,
      allowCancelAfterCutoff: false,
    });
    await register(session, leaver);

    const {
      rows: [sessionRow],
    } = await pool.query<{ starts_at: string }>(`select starts_at from public.sessions where id = $1`, [session]);

    h.userId = leaver;
    const res = await leaveGang(gang.id);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('CANCEL_CUTOFF_PASSED');
      expect(res.error.reason).toBe('HAS_LATE_CANCEL_REGISTRATION');
      expect(res.error.reasonMeta).toBeDefined();
      const meta = res.error.reasonMeta as { startsAt: string; cutoffAt: string };
      // startsAt ต้องตรงกับ sessions.starts_at จริง (ไม่ใช่ประมาณ)
      expect(new Date(meta.startsAt).getTime()).toBe(new Date(sessionRow.starts_at).getTime());
      // cutoffAt = starts_at - 12h ⇒ ต้องเก่ากว่า startsAt อยู่ ~12 ชม. และอยู่ในอดีตแล้ว (เงื่อนไขที่ raise ได้)
      expect(new Date(meta.cutoffAt).getTime()).toBe(new Date(meta.startsAt).getTime() - 12 * 3600 * 1000);
      expect(new Date(meta.cutoffAt).getTime()).toBeLessThan(Date.now());
      // whitelist จริง (ไม่ใช่แค่ unit test ของ mapper เอง) — registration_id ต้องไม่หลุดออกมาใน response จริง
      expect(Object.keys(meta).sort()).toEqual(['cutoffAt', 'startsAt']);
    }

    // atomic: ยังเป็นสมาชิกอยู่ และ registration ยังเป็น confirmed เหมือนเดิม (ไม่ออกครึ่งๆกลางๆ)
    expect(await roleOf(gang.id, leaver)).toBe('member');
    const { rows: regRows } = await pool.query<{ status: string }>(
      `select status from public.session_registrations where session_id = $1 and user_id = $2 and deleted_at is null`,
      [session, leaver],
    );
    expect(regRows[0]?.status).toBe('confirmed');
  });
});
