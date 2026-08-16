import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import { GangSettingsForm } from '@/features/gangs/GangSettingsForm';
import { PricingAndSkills } from '@/features/gangs/PricingAndSkills';
import { reminderFromJson } from '@/domain/gangs/settings';
import { MonthlyPlanForm } from '@/features/billing/MonthlyPlanForm';
import { RecomputeStatsButton } from '@/features/reports/RecomputeStatsButton';
import {
  courtPlusShuttleFromJson,
  flatRateFromJson,
  monthlyFromJson,
  roundingFromJson,
  SESSION_PRICING_TYPES,
  type PricingType,
} from '@/domain/policies/pricing';

export const dynamic = 'force-dynamic';

export default async function GangSettingsPage({
  params,
}: {
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/settings`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, area, is_public, promptpay_id, timezone, cancellation_policy, settings')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  // RLS คืน 0 แถวเมื่อไม่มีสิทธิ์ — แยกไม่ออกจาก "ไม่มีก๊วนนี้"
  // ⇒ ตอบ 404 เหมือนกัน ซึ่งเป็นสิ่งที่ต้องการ: ไม่บอกว่าก๊วนนี้มีอยู่จริงไหม
  if (!gang) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  if (!can({ role }, 'gang.update')) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <Card padding={6}>
          <h1 className="mb-2 text-xl font-semibold">{gang.name}</h1>
          <p className="text-sm">เฉพาะแอดมินของก๊วนเท่านั้นที่แก้ตั้งค่าได้</p>
          <p className="mt-4">
            <Link href={`/gangs/${gangId}/members`} className="underline">
              ดูรายชื่อสมาชิก
            </Link>
          </p>
        </Card>
      </main>
    );
  }

  const { data: plan } = await supabase
    .from('gang_pricing_plans')
    .select('id, name, type, params, rounding_policy, monthly_member_pays_shuttle')
    .eq('gang_id', gangId)
    .eq('is_active', true)
    .in('type', SESSION_PRICING_TYPES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // [ADR-006] ค่าสมาชิกรายเดือนเป็นแผนแยกแถว ไม่ปนกับแผนราคาของนัด
  const { data: monthlyPlan } = await supabase
    .from('gang_pricing_plans')
    .select('id, params')
    .eq('gang_id', gangId)
    .eq('type', 'monthly')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: skillLevels } = await supabase
    .from('gang_skill_levels')
    .select('id, label, rank')
    .eq('gang_id', gangId)
    .order('rank');

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">ตั้งค่าก๊วน</h1>
        <span className="flex gap-3">
          <Link href={`/gangs/${gangId}/sessions`} className="underline">
            นัด
          </Link>
          <Link href={`/gangs/${gangId}/members`} className="underline">
            สมาชิก
          </Link>
        </span>
      </div>

      <Card padding={6}>
        <GangSettingsForm
          gangId={gangId}
          initial={{
            name: gang.name,
            area: gang.area,
            isPublic: gang.is_public,
            promptpayId: gang.promptpay_id,
            timezone: gang.timezone,
            cancellationPolicy: policyFromJson(gang.cancellation_policy),
            reminder: reminderFromJson(gang.settings),
          }}
        />
      </Card>

      <div className="mt-4">
        <Card padding={6}>
          <PricingAndSkills
            gangId={gangId}
            plan={
              plan
                ? {
                    id: plan.id,
                    name: plan.name,
                    type: plan.type as PricingType,
                    amountPerPerson: flatRateFromJson(plan.params).amountPerPerson,
                    courtFeeTotal: courtPlusShuttleFromJson(plan.params).courtFeeTotal,
                    shuttlePrice: courtPlusShuttleFromJson(plan.params).shuttlePrice,
                    roundingMode: roundingFromJson(plan.rounding_policy).mode,
                    monthlyMemberPaysShuttle: plan.monthly_member_pays_shuttle ?? true,
                  }
                : null
            }
            skillLevels={skillLevels ?? []}
          />
        </Card>
      </div>

      <div className="mt-4">
        <Card padding={6}>
          <MonthlyPlanForm
            gangId={gangId}
            plan={
              monthlyPlan
                ? { id: monthlyPlan.id, monthlyFee: monthlyFromJson(monthlyPlan.params).monthlyFee }
                : null
            }
          />
          <p className="mt-3 text-sm">
            <Link href={`/gangs/${gangId}/membership`} className="underline">
              ดูรอบบิลรายเดือน
            </Link>
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card padding={6}>
          <h2 className="mb-2 text-base font-semibold">สถิติสมาชิก</h2>
          <RecomputeStatsButton gangId={gangId} />
        </Card>
      </div>
    </main>
  );
}
