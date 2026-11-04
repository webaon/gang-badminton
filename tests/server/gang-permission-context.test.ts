/**
 * R-roles-3 Task 2 — mocked query-contract spec for the server-only context
 * loader, BEFORE `server/permissions/gang-context.ts` exists (plan Task 3).
 *
 * No DB. `@/lib/supabase/server` is mocked with a tiny in-memory query-builder
 * fake (`fakeSupabase`) that supports exactly the chain the loader needs
 * (`.from().select().eq().is().maybeSingle()` and the plain-array form without
 * `.maybeSingle()`), filters rows the same way PostgREST would for `eq`/`is`,
 * and RECORDS every `.eq()`/`.is()` call and the `.select()` string so this
 * test can assert the loader applies explicit tenant/actor/soft-delete filters
 * (plan Task 2 bullet 3) instead of trusting an unfiltered client-side guess.
 *
 * What this fake does NOT prove: the real FK name on `gang_member_roles.role_id`
 * (assumed default Postgres naming `gang_member_roles_role_id_fkey` pending
 * catalog confirmation — plan Task 2 bullet 3 "verify actual FK names"), real
 * RLS behavior, or real network/serialization errors. Those stay a runtime
 * gate; this file only pins the loader's CONTRACT so Task 3 has a spec to
 * implement against without touching the shared DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@/domain/permissions/types';

type Row = Record<string, unknown>;

/** log ของทุก eq()/is() ที่ query เรียกจริง — ใช้ยืนยันว่า loader filter tenant/actor/soft-delete ถูกต้อง ไม่ใช่เดาจาก response */
type FilterCall = { table: string; op: 'eq' | 'is'; col: string; val: unknown };

function fakeSupabase(tables: Record<string, Row[]>, calls: FilterCall[], selects: { table: string; cols: string }[]) {
  return {
    from(table: string) {
      let rows = tables[table] ?? [];
      const builder = {
        select(c: string) {
          selects.push({ table, cols: c });
          return builder;
        },
        eq(col: string, val: unknown) {
          calls.push({ table, op: 'eq', col, val });
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        is(col: string, val: unknown) {
          calls.push({ table, op: 'is', col, val });
          rows = rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        // ไม่มี .maybeSingle() ⇒ ใช้เป็น thenable คืน array ตรง (เหมือน supabase-js query builder จริง)
        then(onFulfilled: (v: { data: Row[]; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

const supabaseServerMock = vi.fn();
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: () => supabaseServerMock() }));

// gang-context.ts ยังไม่มี (RED ตั้งใจ) — import แบบ dynamic กันพังตอน collect ถ้าไฟล์ไม่มีจริง
async function loader() {
  const mod = (await import('@/server/permissions/gang-context')) as {
    loadGangPermissionContext: (gangId: string, actorId: string) => Promise<import('@/domain/permissions/types').PermissionContext>;
  };
  return mod.loadGangPermissionContext;
}

const GANG = 'gang-00000000-0000-0000-0000-000000000001';
const OTHER_GANG = 'gang-00000000-0000-0000-0000-000000000002';
const OWNER_ID = 'user-owner';
const ADMIN_ID = 'user-admin';
const MEMBER_ID = 'user-member';
const TREASURER_ID = 'user-treasurer';
const SCHEDULER_ID = 'user-scheduler';
const BOTH_ID = 'user-both';
const DEPARTED_ID = 'user-departed';
const OUTSIDER_ID = 'user-outsider';
const DUP_ID = 'user-dup';
const DELETED_ASSIGN_ID = 'user-deleted-assignment';
const DELETED_ROLE_ID = 'user-deleted-role';
const FOREIGN_GANG_ROLE_ID = 'user-foreign-gang-role';
const MALFORMED_ID = 'user-malformed';

const TREASURER_PERMS: readonly Action[] = ['payment.verify', 'credit.read.other', 'gang.finance.view'];
const SCHEDULER_PERMS: readonly Action[] = ['session.create', 'registration.checkin', 'game.manage'];

function baseTables(): Record<string, Row[]> {
  return {
    gangs: [{ id: GANG, features: { statistics: true, guests: false }, deleted_at: null }],
    gang_members: [
      { gang_id: GANG, user_id: OWNER_ID, role: 'owner', deleted_at: null },
      { gang_id: GANG, user_id: ADMIN_ID, role: 'admin', deleted_at: null },
      { gang_id: GANG, user_id: MEMBER_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: TREASURER_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: SCHEDULER_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: BOTH_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: DEPARTED_ID, role: 'member', deleted_at: '2026-01-01T00:00:00Z' },
      { gang_id: GANG, user_id: DUP_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: DELETED_ASSIGN_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: DELETED_ROLE_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: FOREIGN_GANG_ROLE_ID, role: 'member', deleted_at: null },
      { gang_id: GANG, user_id: MALFORMED_ID, role: 'member', deleted_at: null },
    ],
    // แถวนี้จงใจ "ฝัง" ผล embed ไว้ตรงๆ (ไม่ join จริงแบบ PostgREST) — ดู comment หัวไฟล์:
    // สิ่งที่เทสต์นี้พิสูจน์คือ loader filter/flatten/dedupe ถูก ไม่ใช่ syntax ของ PostgREST embed เอง
    gang_member_roles: [
      { gang_id: GANG, user_id: TREASURER_ID, deleted_at: null, gang_roles: { permissions: TREASURER_PERMS, deleted_at: null } },
      { gang_id: GANG, user_id: SCHEDULER_ID, deleted_at: null, gang_roles: { permissions: SCHEDULER_PERMS, deleted_at: null } },
      { gang_id: GANG, user_id: BOTH_ID, deleted_at: null, gang_roles: { permissions: TREASURER_PERMS, deleted_at: null } },
      { gang_id: GANG, user_id: BOTH_ID, deleted_at: null, gang_roles: { permissions: SCHEDULER_PERMS, deleted_at: null } },
      // duplicate: สองแถว assignment คนละ id แต่ permission ซ้ำกันบางตัว ⇒ ต้อง dedupe
      { gang_id: GANG, user_id: DUP_ID, deleted_at: null, gang_roles: { permissions: ['session.create', 'game.manage'], deleted_at: null } },
      { gang_id: GANG, user_id: DUP_ID, deleted_at: null, gang_roles: { permissions: ['game.manage', 'registration.checkin'], deleted_at: null } },
      // assignment ตัวเองถูก soft-delete ⇒ ต้องไม่เข้า extra แม้ query ไม่ได้ filter deleted_at ของ embed
      { gang_id: GANG, user_id: DELETED_ASSIGN_ID, deleted_at: '2026-01-01T00:00:00Z', gang_roles: { permissions: SCHEDULER_PERMS, deleted_at: null } },
      // assignment ยัง active แต่ role ที่ชี้ไปถูก soft-delete ⇒ ต้องไม่เข้า extra
      { gang_id: GANG, user_id: DELETED_ROLE_ID, deleted_at: null, gang_roles: { permissions: SCHEDULER_PERMS, deleted_at: '2026-01-01T00:00:00Z' } },
      // assignment ของก๊วนอื่นที่ถูก inject เข้ามาในตารางเดียวกัน (mock ไม่ scope ตามจริง) ⇒ query ต้อง .eq('gang_id', gangId) กรองออก
      { gang_id: OTHER_GANG, user_id: FOREIGN_GANG_ROLE_ID, deleted_at: null, gang_roles: { permissions: SCHEDULER_PERMS, deleted_at: null } },
      // permissions เพี้ยน: ไม่ใช่ array, มี action ปลอมที่ไม่ใช่ delegable, มี non-string
      { gang_id: GANG, user_id: MALFORMED_ID, deleted_at: null, gang_roles: { permissions: 'not-an-array', deleted_at: null } },
    ],
  };
}

describe('loadGangPermissionContext — mocked query contract (no DB, RED until Task 3 exists)', () => {
  let calls: FilterCall[];
  let selects: { table: string; cols: string }[];

  beforeEach(() => {
    calls = [];
    selects = [];
    vi.resetModules();
  });

  function wire(tables: Record<string, Row[]>) {
    supabaseServerMock.mockResolvedValue(fakeSupabase(tables, calls, selects));
  }

  it('owner: role passthrough, no extra query needed (can() never uses extra above member)', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, OWNER_ID);
    expect(ctx.role).toBe('owner');
    expect(ctx.extra).toBeUndefined();
    expect(ctx.features).toEqual({ statistics: true, guests: false });
  });

  it('admin: role passthrough, no extra query needed', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, ADMIN_ID);
    expect(ctx.role).toBe('admin');
    expect(ctx.extra).toBeUndefined();
  });

  it('member with no assignment: role=member, extra is empty (not undefined — distinct from admin/owner no-op)', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, MEMBER_ID);
    expect(ctx.role).toBe('member');
    expect(ctx.extra).toEqual([]);
  });

  it('outsider (no membership row at all): role=null, extra never queried', async () => {
    wire(baseTables());
    calls.length = 0;
    const ctx = await (await loader())(GANG, OUTSIDER_ID);
    expect(ctx.role).toBeNull();
    expect(ctx.extra).toBeUndefined();
    expect(calls.some((c) => c.table === 'gang_member_roles')).toBe(false);
  });

  it('departed member (soft-deleted gang_members row): role=null via the deleted_at filter, extra never queried', async () => {
    wire(baseTables());
    calls.length = 0;
    const ctx = await (await loader())(GANG, DEPARTED_ID);
    expect(ctx.role).toBeNull();
    expect(calls.some((c) => c.table === 'gang_member_roles')).toBe(false);
  });

  it('orgAdmin is explicitly NOT elevated by this loader (pre-existing gap preserved on purpose, not fixed here)', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, OUTSIDER_ID);
    expect(ctx.orgRole).toBeUndefined();
    expect('orgRole' in ctx).toBe(false);
  });

  it('treasurer: extra contains exactly its bundle permissions', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, TREASURER_ID);
    expect(ctx.role).toBe('member');
    expect([...(ctx.extra ?? [])].sort()).toEqual([...TREASURER_PERMS].sort());
  });

  it('scheduler: extra contains exactly its bundle permissions', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, SCHEDULER_ID);
    expect([...(ctx.extra ?? [])].sort()).toEqual([...SCHEDULER_PERMS].sort());
  });

  it('both bundles held at once: extra is the union, deduped', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, BOTH_ID);
    const expected = new Set([...TREASURER_PERMS, ...SCHEDULER_PERMS]);
    expect(new Set(ctx.extra)).toEqual(expected);
    expect(ctx.extra?.length).toBe(expected.size);
  });

  it('duplicate permissions across two assignment rows are deduped, not summed', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, DUP_ID);
    expect([...(ctx.extra ?? [])].sort()).toEqual(['game.manage', 'registration.checkin', 'session.create'].sort());
  });

  it('soft-deleted assignment row never contributes to extra, even though the role it points to is still valid', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, DELETED_ASSIGN_ID);
    expect(ctx.extra).toEqual([]);
  });

  it('active assignment pointing at a soft-deleted gang_roles row never contributes to extra', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, DELETED_ROLE_ID);
    expect(ctx.extra).toEqual([]);
  });

  it('a foreign-gang role row for the same user_id must not leak in — gang_id filter is load-bearing', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, FOREIGN_GANG_ROLE_ID);
    expect(ctx.extra).toEqual([]);
  });

  it('malformed permissions value (not an array) yields empty extra, not a thrown error and not a crash', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, MALFORMED_ID);
    expect(ctx.extra).toEqual([]);
  });

  it('a non-delegable action smuggled into a bundle\'s permissions array never enters extra (defense in depth vs. a corrupted/legacy row)', async () => {
    const tables = baseTables();
    tables.gang_member_roles.push({
      gang_id: GANG,
      user_id: MEMBER_ID,
      deleted_at: null,
      gang_roles: { permissions: ['gang.member.manage', 'session.create'], deleted_at: null },
    });
    wire(tables);
    const ctx = await (await loader())(GANG, MEMBER_ID);
    expect(ctx.extra).toEqual(['session.create']);
  });

  it('membership query is scoped by gang_id, user_id and deleted_at is null — explicit filters, not an unfiltered table scan', async () => {
    wire(baseTables());
    await (await loader())(GANG, MEMBER_ID);
    const membershipCalls = calls.filter((c) => c.table === 'gang_members');
    expect(membershipCalls).toEqual(
      expect.arrayContaining([
        { table: 'gang_members', op: 'eq', col: 'gang_id', val: GANG },
        { table: 'gang_members', op: 'eq', col: 'user_id', val: MEMBER_ID },
        { table: 'gang_members', op: 'is', col: 'deleted_at', val: null },
      ]),
    );
  });

  it('assignment query is scoped by gang_id, user_id and deleted_at is null too (member path only)', async () => {
    wire(baseTables());
    await (await loader())(GANG, SCHEDULER_ID);
    const assignmentCalls = calls.filter((c) => c.table === 'gang_member_roles');
    expect(assignmentCalls).toEqual(
      expect.arrayContaining([
        { table: 'gang_member_roles', op: 'eq', col: 'gang_id', val: GANG },
        { table: 'gang_member_roles', op: 'eq', col: 'user_id', val: SCHEDULER_ID },
        { table: 'gang_member_roles', op: 'is', col: 'deleted_at', val: null },
      ]),
    );
  });

  it('assignment select uses a named FK embed, not a bare/ambiguous join (CLAUDE.md §embeds)', async () => {
    wire(baseTables());
    await (await loader())(SCHEDULER_ID === SCHEDULER_ID ? GANG : GANG, SCHEDULER_ID);
    const assignmentSelect = selects.find((s) => s.table === 'gang_member_roles');
    expect(assignmentSelect?.cols).toMatch(/gang_roles!gang_member_roles_role_id_fkey\(/);
  });

  it('gangs query is scoped by id and deleted_at is null, used for features regardless of role', async () => {
    wire(baseTables());
    await (await loader())(GANG, OUTSIDER_ID);
    const gangCalls = calls.filter((c) => c.table === 'gangs');
    expect(gangCalls).toEqual(
      expect.arrayContaining([
        { table: 'gangs', op: 'eq', col: 'id', val: GANG },
        { table: 'gangs', op: 'is', col: 'deleted_at', val: null },
      ]),
    );
  });

  it('a membership query error rejects the loader rather than silently returning role=null (fail closed, not open)', async () => {
    const tables = baseTables();
    supabaseServerMock.mockResolvedValue({
      from(table: string) {
        if (table === 'gang_members') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
            maybeSingle: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
          };
        }
        return fakeSupabase(tables, calls, selects).from(table);
      },
    });
    await expect((await loader())(GANG, MEMBER_ID)).rejects.toBeTruthy();
  });

  it('an assignment query error rejects the loader rather than silently returning extra=[] (fail closed)', async () => {
    const tables = baseTables();
    supabaseServerMock.mockResolvedValue({
      from(table: string) {
        if (table === 'gang_member_roles') {
          return {
            select() { return this; },
            eq() { return this; },
            is() { return this; },
            then(onFulfilled: (v: { data: null; error: { message: string } }) => unknown, onRejected?: (e: unknown) => unknown) {
              return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(onFulfilled, onRejected);
            },
          };
        }
        return fakeSupabase(tables, calls, selects).from(table);
      },
    });
    await expect((await loader())(GANG, MEMBER_ID)).rejects.toBeTruthy();
  });

  it('actorId must come from the caller explicitly — the loader never falls back to a different/service identity when it mismatches every row', async () => {
    wire(baseTables());
    const ctx = await (await loader())(GANG, 'user-does-not-exist-anywhere');
    expect(ctx.role).toBeNull();
    expect(ctx.extra).toBeUndefined();
  });
});
