/**
 * WO-1.4 DoD — RLS tests ทั้ง 5 ข้อใน baseline §Verification
 *
 *   1. ก๊วน A อ่านก๊วน B ไม่ได้
 *   2. member อ่าน gang_line_configs ไม่ได้
 *   3. non-member อ่านสลิปไม่ได้ (storage)
 *   4. guest token ใช้ข้าม session ไม่ได้
 *   5. recursion ไม่เกิด
 *
 * + เทสต์ที่คุมช่องโหว่ซึ่ง WO-1.3 เปิดค้างไว้แล้ว WO-1.4 ปิด
 *
 * ⚠️ connection ของเทสต์เป็น `postgres` (BYPASSRLS) ⇒ ทุกข้อที่ตรวจ RLS
 *    **ต้อง** ห่อด้วย asRole()/visibleCount() ไม่งั้นจะผ่านแบบหลอกๆ ทุกครั้ง
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  visibleCount,
  readAccess,
  createFixture,
  createUser,
  addGangMember,
  reloadPostgrestSchema,
} from '../helpers/db';

type Tenant = {
  ownerId: string;
  memberId: string;
  outsiderId: string;
  gangId: string;
  sessionId: string;
};

/** ก๊วนหนึ่งใบ พร้อม owner (admin) + member ธรรมดา */
async function makeTenant(tag: string): Promise<Tenant> {
  const ownerId = await createUser(`owner-${tag}`);
  const fx = await createFixture({ ownerId, maxPlayers: 6 });

  // ผู้สร้างก๊วนต้องเป็น owner ของทั้ง org และ gang
  await pool.query(
    `insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'owner')`,
    [fx.orgId, ownerId],
  );
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'owner')`,
    [fx.gangId, ownerId],
  );

  const memberId = await createUser(`member-${tag}`);
  await addGangMember(fx.gangId, memberId);

  const outsiderId = await createUser(`outsider-${tag}`);

  return { ownerId, memberId, outsiderId, gangId: fx.gangId, sessionId: fx.sessionId };
}

describe('WO-1.4 DoD — RLS', () => {
  let A: Tenant;
  let B: Tenant;

  beforeAll(async () => {
    await reloadPostgrestSchema();
    A = await makeTenant('A');
    B = await makeTenant('B');
  });

  afterAll(async () => {
    await pool.end();
  });

  // ---------------------------------------------------------------------------
  it('RLS 1. ก๊วน A อ่านข้อมูลของก๊วน B ไม่ได้เลยสักตาราง', async () => {
    const memberOfA = A.memberId;

    // เห็นก๊วนตัวเอง
    expect(
      await visibleCount(memberOfA, 'select 1 from public.gangs where id = $1', [A.gangId]),
    ).toBe(1);

    // ไม่เห็นก๊วน B (ก๊วน B ไม่ public)
    expect(
      await visibleCount(memberOfA, 'select 1 from public.gangs where id = $1', [B.gangId]),
    ).toBe(0);

    // ตารางลูกของก๊วน B ก็ต้องมองไม่เห็น
    const leaks: string[] = [];
    for (const [table, sql] of [
      ['gang_members', 'select 1 from public.gang_members where gang_id = $1'],
      ['sessions', 'select 1 from public.sessions where gang_id = $1'],
      ['gang_pricing_plans', 'select 1 from public.gang_pricing_plans where gang_id = $1'],
      ['announcements', 'select 1 from public.announcements where gang_id = $1'],
      ['event_logs', 'select 1 from public.event_logs where gang_id = $1'],
      ['member_statistics', 'select 1 from public.member_statistics where gang_id = $1'],
      ['session_charges', 'select 1 from public.session_charges where gang_id = $1'],
      ['payments', 'select 1 from public.payments where gang_id = $1'],
      ['gang_expenses', 'select 1 from public.gang_expenses where gang_id = $1'],
    ] as const) {
      if ((await visibleCount(memberOfA, sql, [B.gangId])) !== 0) leaks.push(table);
    }
    expect(leaks, `ตารางที่รั่วข้ามก๊วน: ${leaks.join(', ')}`).toEqual([]);

    // นัดของก๊วน B ก็ต้องไม่เห็น
    expect(
      await visibleCount(memberOfA, 'select 1 from public.sessions where id = $1', [B.sessionId]),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  it('RLS 2. gang_line_configs เป็น server-only — แม้แต่ owner ของก๊วนก็อ่านไม่ได้', async () => {
    await pool.query(
      `insert into public.gang_line_configs (gang_id, channel_access_token_ref, is_enabled)
       values ($1, 'vault-secret-id-xyz', true)`,
      [A.gangId],
    );

    const sql = 'select 1 from public.gang_line_configs where gang_id = $1';

    // ตารางนี้ปิดสองชั้น (ไม่ grant + ไม่มี policy) ⇒ ผลลัพธ์ที่ยอมรับได้คือ
    // 'denied' (ตกที่ GRANT) หรือ 0 (ตกที่ RLS) — ห้ามเป็นตัวเลขมากกว่า 0
    expect(await readAccess(A.memberId, sql, [A.gangId])).toBe('denied');

    // 🔴 owner/admin ของก๊วนเองก็ต้องไม่เห็น — baseline บอก "server-only" ไม่ใช่ "admin-only"
    expect(await readAccess(A.ownerId, sql, [A.gangId])).toBe('denied');

    // anon ก็เช่นกัน
    expect(await readAccess(null, sql, [A.gangId], 'anon')).toBe('denied');

    // service_role (ฝั่ง server) ยังอ่านได้ตามปกติ
    const { rows } = await pool.query(
      `select 1 from public.gang_line_configs where gang_id = $1`,
      [A.gangId],
    );
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  it('RLS 3. non-member อ่านสลิปใน storage ไม่ได้ / เจ้าของกับแอดมินอ่านได้', async () => {
    const slipPath = `${A.gangId}/${crypto.randomUUID()}/slip.jpg`;
    await pool.query(
      `insert into storage.objects (bucket_id, name, owner, owner_id)
       values ('payment-slips', $1, $2::uuid, $3::text)`,
      [slipPath, A.memberId, A.memberId],
    );

    const seenBy = async (uid: string) =>
      visibleCount(uid, `select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1`, [
        slipPath,
      ]);

    // เจ้าของสลิป
    expect(await seenBy(A.memberId)).toBe(1);
    // แอดมินก๊วนเดียวกัน
    expect(await seenBy(A.ownerId)).toBe(1);

    // 🔴 คนนอกก๊วน และสมาชิกก๊วนอื่น ต้องไม่เห็น
    expect(await seenBy(A.outsiderId)).toBe(0);
    expect(await seenBy(B.memberId)).toBe(0);
    expect(await seenBy(B.ownerId)).toBe(0);

    // anon ก็ไม่เห็น (bucket ไม่ public)
    expect(
      await visibleCount(
        null,
        `select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1`,
        [slipPath],
        'anon',
      ),
    ).toBe(0);

    // และ bucket ต้องไม่ถูกตั้งเป็น public โดยพลาด
    const {
      rows: [bucket],
    } = await pool.query<{ public: boolean }>(
      `select public from storage.buckets where id = 'payment-slips'`,
    );
    expect(bucket.public).toBe(false);
  });

  // ---------------------------------------------------------------------------
  it('RLS 4. invite token ของนัดหนึ่ง ใช้กับอีกนัดไม่ได้', async () => {
    const token = `cross-session-token-${crypto.randomUUID()}`;

    // token ผูกกับนัดของก๊วน A
    await pool.query(
      `insert into public.session_invite_tokens (session_id, token_hash, expires_at, max_uses)
       values ($1, extensions.digest($2, 'sha256'), now() + interval '1 day', 10)`,
      [A.sessionId, token],
    );

    // เอาไปใช้กับนัดของก๊วน B → ต้องไม่ผ่าน
    await expect(
      pool.query(`select public.register_to_session($1, null, $2, null, $3)`, [
        B.sessionId,
        'ผู้มาเยือนหน้าใหม่',
        token,
      ]),
    ).rejects.toThrow(/INVITE_TOKEN_INVALID/);

    // ไม่มี registration ใดเกิดขึ้นในนัด B
    const { rows } = await pool.query(
      `select 1 from public.session_registrations where session_id = $1`,
      [B.sessionId],
    );
    expect(rows).toHaveLength(0);

    // ใช้กับนัดที่ถูกต้องยังได้ตามปกติ (พิสูจน์ว่า token เองไม่ได้เสีย)
    await pool.query(`select public.register_to_session($1, null, $2, null, $3)`, [
      A.sessionId,
      'ผู้มาเยือนถูกนัด',
      token,
    ]);
    const okRows = await pool.query(
      `select 1 from public.session_registrations where session_id = $1`,
      [A.sessionId],
    );
    expect(okRows.rows).toHaveLength(1);

    // แถมอีกชั้น: แถว token ของก๊วน A ต้องมองไม่เห็นจากฝั่งก๊วน B
    expect(
      await visibleCount(
        B.ownerId,
        'select 1 from public.session_invite_tokens where session_id = $1',
        [A.sessionId],
      ),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  it('RLS 5. policy ที่อ้างตารางตัวเองไม่เกิด infinite recursion', async () => {
    // gang_members เป็นเคสอันตรายที่สุด: policy ของมันเรียก is_gang_member()
    // ซึ่งอ่าน gang_members เอง — ถ้า helper ไม่ใช่ definer จะพังตรงนี้
    await expect(
      visibleCount(A.memberId, 'select 1 from public.gang_members where gang_id = $1', [A.gangId]),
    ).resolves.toBeGreaterThan(0);

    // เดินทุกตารางที่มี policy อ้าง helper — ต้องไม่มีตัวไหน raise
    const failures: string[] = [];
    for (const table of [
      'gangs',
      'gang_members',
      'organizations',
      'organization_members',
      'profiles',
      'sessions',
      'session_registrations',
      'session_charges',
      'payments',
      'payment_allocations',
      'payment_adjustments',
      'games',
      'event_logs',
      'notifications',
      'announcements',
      'join_requests',
      'member_statistics',
      'member_line_links',
      'coupons',
      'gang_expenses',
      'gang_incomes',
      'gang_pricing_plans',
      'gang_skill_levels',
      'session_templates',
      'session_invite_tokens',
      'notification_logs',
    ]) {
      try {
        await visibleCount(A.memberId, `select 1 from public.${table} limit 5`);
      } catch (err) {
        failures.push(`${table}: ${(err as Error).message}`);
      }
    }
    expect(failures, `ตารางที่ query ไม่ผ่าน:\n${failures.join('\n')}`).toEqual([]);
  });
});
