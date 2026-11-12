import 'server-only';

import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { loadGangPermissionContext } from '@/server/permissions/gang-context';

/** Existing member list fields only; no skill, debt or statistics lookups. */
export async function loadGangMembers(gangId: string) {
  const user = await requireUser(`/gangs/${gangId}/members`);
  const supabase = await supabaseServer();
  const { data: gang, error: gangError } = await supabase.from('gangs')
    .select('id, name').eq('id', gangId).is('deleted_at', null).maybeSingle();
  if (gangError) throw gangError;
  if (!gang) notFound();
  const ctx = await loadGangPermissionContext(gangId, user.id);
  if (!ctx.role) notFound();
  const canManage = can(ctx, 'gang.member.manage');
  const { data, error } = await supabase.from('gang_members')
    .select('id, user_id, role, is_monthly_member, profiles!gang_members_user_id_fkey!inner(display_name)')
    .eq('gang_id', gangId).is('deleted_at', null).order('role');
  if (error) throw error;
  type Row = { id: string; user_id: string; role: GangRole; is_monthly_member: boolean; profiles: { display_name: string } };
  const members = ((data ?? []) as unknown as Row[]).map(row => ({
    id: row.id, userId: row.user_id, displayName: row.profiles.display_name,
    role: row.role, isMonthlyMember: row.is_monthly_member,
  }));
  return { gangId, name: gang.name as string, members, canManage };
}
