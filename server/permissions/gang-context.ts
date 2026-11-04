import 'server-only';

/**
 * R-roles-3 Task 3 — server-only permission-context loader (ADR-015)
 *
 * Loads the ACTIVE delegated-permission bundle for one actor in one gang into
 * `PermissionContext.extra`, so `can()`/`assertCan()` at existing call sites can
 * recognize scheduler/treasurer/custom roles without each call site re-deriving
 * `extra` by hand. Spec'd by the mocked contract in
 * `tests/server/gang-permission-context.test.ts` (plan Task 2) before this file
 * existed; keep that file and this one in sync.
 *
 * 🔴 This does NOT replace RLS/DB actor-checked functions — same rule as `can()`
 *    itself (`domain/permissions/can.ts` header). The real wall is `has_gang_permission()`
 *    + `gangs_with_permission()` in the DB (ADR-015). This loader only makes the
 *    TS-side `can()` answer match what the DB will actually allow, so a scheduler
 *    doesn't get a false "FORBIDDEN" from `can()` while the DB would have let them
 *    through, or a false allow that would just bounce off RLS anyway.
 *
 * 🔴 Phase 1 scope only (planner WO, R-roles-3): this file exists and is
 *    unit-tested, but is NOT wired into any `server/actions/*` call site yet.
 *    Call-site integration is Task 4/5/6, gated on QA runtime clearance for
 *    migrations 0050–0053 (planner instruction). Importing this from a call
 *    site before that clearance is out of scope for this WO.
 *
 * 🔴 orgRole is intentionally left unset here (not `null`, simply never set).
 *    No current `server/actions/*` call site passes `orgRole` into `can()`/
 *    `assertCan()` today (verified by `tests/security/permission-context-coverage.test.ts`
 *    "no server/app call site passes orgRole today") — this loader preserves
 *    that exact status quo rather than inventing new org-admin elevation while
 *    deduplicating loaders (plan Task 3 bullet 2, Open point 2). Resolving the
 *    org-admin gap is explicitly deferred to a future WO with its own decision.
 */
import { supabaseServer } from '@/lib/supabase/server';
import { isDelegableAction } from '@/domain/permissions/delegable';
import type { Action, GangFeatures, GangRole, PermissionContext } from '@/domain/permissions/types';

type MembershipRow = { role: string | null };
type GangRow = { features: unknown };
/**
 * 🔴 FK name assumed from default PostgreSQL naming (`<table>_<column>_fkey`) since
 *    migration `20260818000050_gang_roles_expand.sql` does not name the constraint
 *    on `gang_member_roles.role_id` explicitly. NOT yet confirmed against the live
 *    catalog (shared DB is held for QA runtime right now — plan Task 2 bullet 3:
 *    "verify actual FK names in the catalog" before trusting this in production).
 *    If `migration up --local` / a real query proves this wrong once the DB slot
 *    reopens, fix ONLY this constant — the rest of the loader is unaffected.
 */
const GANG_MEMBER_ROLES_ROLE_ID_FKEY = 'gang_member_roles_role_id_fkey';

type AssignmentRow = {
  gang_roles: { permissions: unknown; deleted_at: string | null } | null;
};

/**
 * สิทธิ์ของ `actorId` ในก๊วน `gangId` ขณะเรียก — ไม่มี cache/TTL (plan Task 3 bullet 5):
 * ทุกครั้งที่เรียกจะอ่านของจริง ณ ตอนนั้น ⇒ revoke/leave มีผลทันทีในการเรียกถัดไปโดยไม่ต้อง restart
 *
 * @param gangId  ต้องมาจากการ resolve resource→gang ที่ caller ทำไว้แล้ว (เช่น sessionContext()) ไม่ใช่รับตรงจาก client DTO
 * @param actorId ต้องมาจาก `requireUser()` หรือ server identity ที่เชื่อถือได้แล้วเท่านั้น ไม่ใช่รับตรงจาก client DTO
 */
export async function loadGangPermissionContext(
  gangId: string,
  actorId: string,
): Promise<PermissionContext> {
  const supabase = await supabaseServer();

  const [membershipResult, gangResult] = await Promise.all([
    supabase
      .from('gang_members')
      .select('role')
      .eq('gang_id', gangId)
      .eq('user_id', actorId)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('gangs')
      .select('features')
      .eq('id', gangId)
      .is('deleted_at', null)
      .maybeSingle(),
  ]);

  if (membershipResult.error) throw membershipResult.error;
  if (gangResult.error) throw gangResult.error;

  const membership = membershipResult.data as MembershipRow | null;
  const gang = gangResult.data as GangRow | null;

  const role = (membership?.role as GangRole | undefined) ?? null;
  const features = (gang?.features ?? {}) as Partial<GangFeatures>;

  // can() เฉพาะ effectiveRole==='member' เท่านั้นที่ดู extra (domain/permissions/can.ts)
  // ⇒ ไม่ใช่สมาชิก/เป็น admin/owner อยู่แล้วไม่ต้อง query assignment ให้เปลือง round-trip
  if (role !== 'member') {
    return { role, features };
  }

  const assignmentsResult = await supabase
    .from('gang_member_roles')
    .select(`gang_roles!${GANG_MEMBER_ROLES_ROLE_ID_FKEY}(permissions, deleted_at)`)
    .eq('gang_id', gangId)
    .eq('user_id', actorId)
    .is('deleted_at', null);

  if (assignmentsResult.error) throw assignmentsResult.error;

  const rows = (assignmentsResult.data ?? []) as unknown as AssignmentRow[];

  const extra: readonly Action[] = Array.from(
    new Set(
      rows
        // assignment active (กรองแล้วจาก query ด้านบน) แต่ role ที่ชี้ไปถูก soft-delete ต้องไม่เข้า extra
        .filter((row) => row.gang_roles !== null && row.gang_roles.deleted_at === null)
        .flatMap((row) => (Array.isArray(row.gang_roles?.permissions) ? (row.gang_roles!.permissions as unknown[]) : []))
        // ปิด allow-list ซ้ำอีกชั้นฝั่ง TS (เหมือน DB's permissions_are_delegable) —
        // แถวที่เพี้ยน/legacy ที่มี action ที่ไม่ใช่ delegable หลุดเข้ามาจะถูกตัดตรงนี้ ไม่ปล่อยเข้า can()
        .filter((permission): permission is Action => typeof permission === 'string' && isDelegableAction(permission)),
    ),
  );

  return { role, features, extra };
}
