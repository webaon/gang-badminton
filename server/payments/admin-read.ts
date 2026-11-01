import 'server-only';

import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/supabase/auth';
import { assertCan } from '@/domain/permissions/can';
import type { Action, GangRole } from '@/domain/permissions/types';
import { AppError } from '@/shared/action';

export const ADMIN_READ_PAGE = 500;
export type ReadClient = Awaited<ReturnType<typeof supabaseServer>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(value: string): string {
  if (!UUID.test(value)) throw new AppError('VALIDATION_ERROR', 'รหัสรายการไม่ถูกต้อง');
  return value;
}

/** Authenticated reads use RLS, never a service-role shortcut. Fail on query errors. */
export async function financeReader(gangId: string, action: Action = 'gang.finance.view') {
  uuid(gangId);
  const user = await requireUser();
  const db = await supabaseServer();
  const { data, error } = await db.from('gang_members').select('role')
    .eq('gang_id', gangId).eq('user_id', user.id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  const ctx = { role: (data?.role ?? null) as GangRole | null };
  assertCan(ctx, action);
  return { db, ctx, user };
}

/** Ordered UUID cursor, not offset; query must order by id ASC and filter by id > after. */
export async function allById<T extends { id: string }>(
  query: (after: string | null) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const { data, error } = await query(after);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < ADMIN_READ_PAGE) return out;
    const next = rows[rows.length - 1].id;
    if (next === after) throw new AppError('INTERNAL_ERROR', 'อ่านหน้าถัดไปไม่สำเร็จ');
    after = next;
  }
}

export async function relatedRows<T extends { id: string }>(
  db: ReadClient, table: string, column: string, ids: readonly string[], select: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    rows.push(...await allById<T>((after) => {
      let q = db.from(table).select(select).in(column, batch).order('id').limit(ADMIN_READ_PAGE);
      if (after) q = q.gt('id', after);
      return q;
    }));
  }
  return rows;
}

/** Internal only, after financeReader authorizes. IDs MUST come from that gang's
 * authorized charge/payment rows, never client input. Profile RLS hides former
 * gangmates; fallback reads only id/display_name for missing scoped identities.
 */
export async function scopedFinanceNames(db: ReadClient, scopedIds: readonly string[]) {
  type Profile = { id: string; display_name: string };
  const ids = [...new Set(scopedIds)];
  const visible = await relatedRows<Profile>(db, 'profiles', 'id', ids, 'id,display_name');
  const names = new Map(visible.map((p) => [p.id, p.display_name]));
  const missing = ids.filter((id) => !names.has(id));
  if (missing.length) {
    const former = await relatedRows<Profile>(supabaseAdmin(), 'profiles', 'id', missing, 'id,display_name');
    for (const p of former) names.set(p.id, p.display_name);
  }
  return names;
}
