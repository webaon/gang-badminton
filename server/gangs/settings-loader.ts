import 'server-only';

import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import { loadGangPermissionContext } from '@/server/permissions/gang-context';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import { reminderFromJson } from '@/domain/gangs/settings';
import { courtPlusShuttleFromJson, flatRateFromJson, monthlyFromJson, roundingFromJson, SESSION_PRICING_TYPES, type PricingType } from '@/domain/policies/pricing';
import { lineLoginStatus, lineStatus, lineUsage } from '@/server/actions/line';

/** WO-6.6a: existing settings-page reads, unchanged fields/filters; no new data sources. */
export async function loadGangSettings(gangId: string) {
  const user = await requireUser(`/gangs/${gangId}/settings`);
  const supabase = await supabaseServer();
  const { data: gang, error: gangError } = await supabase.from('gangs')
    .select('id, name, area, is_public, promptpay_id, timezone, cancellation_policy, settings')
    .eq('id', gangId).is('deleted_at', null).maybeSingle();
  if (gangError) throw gangError;
  if (!gang) notFound();
  const ctx = await loadGangPermissionContext(gangId, user.id);
  if (!ctx.role) notFound();
  const canManage = can(ctx, 'gang.update');
  if (!canManage) return { gangId, name: gang.name as string, canManage, settings: null };

  const { data: plan, error: planError } = await supabase.from('gang_pricing_plans')
    .select('id, name, type, params, rounding_policy, monthly_member_pays_shuttle')
    .eq('gang_id', gangId).eq('is_active', true).in('type', SESSION_PRICING_TYPES)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (planError) throw planError;
  const { data: monthlyPlan, error: monthlyError } = await supabase.from('gang_pricing_plans')
    .select('id, params').eq('gang_id', gangId).eq('type', 'monthly').eq('is_active', true)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (monthlyError) throw monthlyError;
  const [line, usage, login] = await Promise.all([lineStatus(gangId), lineUsage(gangId), lineLoginStatus(gangId)]);
  const { data: skillLevels, error: skillsError } = await supabase.from('gang_skill_levels')
    .select('id, label, rank').eq('gang_id', gangId).order('rank');
  if (skillsError) throw skillsError;

  return {
    gangId, name: gang.name as string, canManage,
    settings: {
      initial: {
        name: gang.name as string, area: gang.area as string | null,
        isPublic: gang.is_public as boolean, promptpayId: gang.promptpay_id as string | null,
        timezone: gang.timezone as string,
        cancellationPolicy: policyFromJson(gang.cancellation_policy),
        reminder: reminderFromJson(gang.settings),
      },
      plan: plan ? {
        id: plan.id as string, name: plan.name as string, type: plan.type as PricingType,
        amountPerPerson: flatRateFromJson(plan.params).amountPerPerson,
        courtFeeTotal: courtPlusShuttleFromJson(plan.params).courtFeeTotal,
        shuttlePrice: courtPlusShuttleFromJson(plan.params).shuttlePrice,
        roundingMode: roundingFromJson(plan.rounding_policy).mode,
        monthlyMemberPaysShuttle: (plan.monthly_member_pays_shuttle ?? true) as boolean,
      } : null,
      monthlyPlan: monthlyPlan ? { id: monthlyPlan.id as string, monthlyFee: monthlyFromJson(monthlyPlan.params).monthlyFee } : null,
      skillLevels: (skillLevels ?? []) as { id: string; label: string; rank: number }[],
      line, usage, login,
    },
  };
}
