/**
 * R-roles-3 Phase 2 — REAL DB integration test for `loadGangPermissionContext()`.
 *
 * `tests/server/gang-permission-context.test.ts` (Task 2) proved the loader's
 * CONTRACT against a mocked in-memory query-builder; it explicitly disclaimed
 * that it does NOT prove the real FK name on `gang_member_roles.role_id`. This
 * file closes that gap per planner instruction: "integration test ที่เรียก
 * loader กับ DB จริงอย่างน้อย 1 เคส (treasurer ได้ permission จริง) ห้ามใช้
 * แค่ mock".
 *
 * Mock boundary (same convention as every other action test in this repo —
 * see tests/sessions/member-credit-actions.test.ts): `@/lib/supabase/server`
 * is mocked to return `serviceClient()` instead of a cookie-bound client,
 * because `supabaseServer()` needs `next/headers`' `cookies()` which only
 * exists inside a real Next.js request — there is no way to get a per-user
 * RLS-bound client outside that runtime without hand-rolling JWT signing.
 * `loadGangPermissionContext()` ITSELF is NOT mocked: every query it issues
 * (including the `gang_roles!gang_member_roles_role_id_fkey(...)` embed) goes
 * out over real PostgREST against the real local Postgres catalog. If the FK
 * name constant in `server/permissions/gang-context.ts` were wrong, PostgREST
 * would reject the embed with a real "Could not find a relationship" error —
 * these tests would fail for real, not silently pass against a forgiving mock.
 *
 * What this test does NOT prove: RLS (service_role bypasses it — that is
 * role-matrix.test.ts/grant-matrix.test.ts's job, run separately in this same
 * WO). This test's only job is "does the loader's query shape actually match
 * the live schema", which is exactly the gap the mocked spec left open.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient, reloadPostgrestSchema } from '../helpers/db';
import { ROLE_PRESETS } from '@/domain/permissions/delegable';

vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => serviceClient() }));

// ต้อง import หลัง vi.mock (hoisted ก่อนอยู่แล้วตามกฎ vitest แต่เขียนไว้ให้ชัดว่าตั้งใจ)
import { loadGangPermissionContext } from '@/server/permissions/gang-context';

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
    [`gpc-db-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function setup() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(
    `select id from public.create_gang($1, $2)`,
    [owner, `ก๊วน-gpc-db-${crypto.randomUUID()}`],
  );
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'owner')
     on conflict do nothing`,
    [gang.id, owner],
  );

  const addMember = async (role = 'member') => {
    const u = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`, [
      gang.id,
      u,
      role,
    ]);
    return u;
  };

  const plain = await addMember();
  const treasurer = await addMember();
  const scheduler = await addMember();
  const revokedTreasurer = await addMember();
  const departed = await addMember();
  const outsider = await newUser(); // ไม่เคยเป็นสมาชิกก๊วนนี้เลย

  await pool.query(`select public.assign_gang_role($1,$2,'treasurer',$3)`, [gang.id, treasurer, owner]);
  await pool.query(`select public.assign_gang_role($1,$2,'scheduler',$3)`, [gang.id, scheduler, owner]);

  // มอบแล้วถอนคืน — ต้องเหลือ extra=[] ไม่ใช่ error (revoke_gang_role soft-delete แถว assignment)
  await pool.query(`select public.assign_gang_role($1,$2,'treasurer',$3)`, [gang.id, revokedTreasurer, owner]);
  await pool.query(`select public.revoke_gang_role($1,$2,'treasurer',$3)`, [gang.id, revokedTreasurer, owner]);

  // ออกจากก๊วนจริง (soft-delete แถว gang_members) — ไม่ใช่แค่สร้างแล้วลบมือ ให้ผ่าน trigger/ฟังก์ชันจริงถ้ามี
  await pool.query(`update public.gang_members set deleted_at = now() where gang_id=$1 and user_id=$2`, [
    gang.id,
    departed,
  ]);

  return { gangId: gang.id, owner, plain, treasurer, scheduler, revokedTreasurer, departed, outsider };
}

type World = Awaited<ReturnType<typeof setup>>;
let wp: Promise<World> | undefined;
const world = () => (wp ??= setup());

describe('loadGangPermissionContext() — real DB, real PostgREST embed (no mock)', () => {
  it('owner: role=owner, no delegated-permission query needed (short-circuits before touching gang_member_roles)', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.owner);
    expect(ctx.role).toBe('owner');
    expect(ctx.extra).toBeUndefined();
  });

  it('plain member with no delegated role: role=member, extra=[] (real empty-embed result, not a mock default)', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.plain);
    expect(ctx.role).toBe('member');
    expect(ctx.extra).toEqual([]);
  });

  it('🔴 treasurer: role=member, extra = exactly ROLE_PRESETS.treasurer via the real gang_roles!gang_member_roles_role_id_fkey embed', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.treasurer);
    expect(ctx.role).toBe('member');
    expect(ctx.extra).toBeDefined();
    expect(new Set(ctx.extra)).toEqual(new Set(ROLE_PRESETS.treasurer));
  });

  it('scheduler: role=member, extra includes statistics.view.all (the Task 6 gang-wide-stats action) via the same real embed', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.scheduler);
    expect(ctx.role).toBe('member');
    expect(new Set(ctx.extra)).toEqual(new Set(ROLE_PRESETS.scheduler));
    expect(ctx.extra).toContain('statistics.view.all');
  });

  it('revoked assignment: role=member, extra=[] — revoke_gang_role()\'s soft-delete is actually respected by the real query, not just assumed', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.revokedTreasurer);
    expect(ctx.role).toBe('member');
    expect(ctx.extra).toEqual([]);
  });

  it('departed member: role=null (gang_members.deleted_at filter works against the real row, not a mock default)', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.departed);
    expect(ctx.role).toBeNull();
    expect(ctx.extra).toBeUndefined();
  });

  it('outsider (never a member of this gang): role=null', async () => {
    const w = await world();
    const ctx = await loadGangPermissionContext(w.gangId, w.outsider);
    expect(ctx.role).toBeNull();
  });

  it('features come from the real gangs.features column for every caller regardless of role', async () => {
    const w = await world();
    const [ownerCtx, memberCtx] = await Promise.all([
      loadGangPermissionContext(w.gangId, w.owner),
      loadGangPermissionContext(w.gangId, w.plain),
    ]);
    expect(ownerCtx.features).toEqual(memberCtx.features);
    expect(typeof ownerCtx.features).toBe('object');
  });
});
