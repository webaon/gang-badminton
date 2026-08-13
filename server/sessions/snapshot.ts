import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { fromJson as cancellationFromJson } from '@/domain/policies/cancellation';
import {
  courtPlusShuttleFromJson,
  flatRateFromJson,
  isImplemented as isPricingImplemented,
  roundingFromJson,
  SESSION_PRICING_TYPES,
  type PricingType,
} from '@/domain/policies/pricing';
import { buildSnapshot, type SessionSnapshot } from '@/domain/sessions/snapshot';
import { isValidTimeZone } from '@/domain/time/timezone';
import { AppError } from '@/shared/action';

/**
 * ประกอบ snapshot ของนัด — **จุดเดียวในระบบ** [WO-2.5-E]
 *
 * 🔴 baseline §Snapshot rule + DoD ของ WO-2.5-E:
 *    "นัดที่ generate ต้องมี snapshot ครบเหมือนสร้างมือ — ไม่งั้นปิดรอบไม่ได้"
 *
 *    ⇒ ถ้าปล่อยให้ `createSession()` กับ cron generate ต่างคนต่างประกอบ snapshot
 *      วันหนึ่งจะเบี่ยงจากกัน แล้วนัดที่ generate จะปิดรอบไม่ได้โดยไม่มีใครรู้จนถึงหน้างาน
 */

export type SnapshotContext = {
  snapshot: SessionSnapshot;
  gang: { id: string; timezone: string; promptpay_id: string | null };
};

export async function buildSessionSnapshot(
  client: SupabaseClient,
  gangId: string,
  /** แผนราคาที่ template ระบุไว้ — ไม่ระบุ = ใช้แผนที่ active ล่าสุดของก๊วน */
  pricingPlanId?: string | null,
): Promise<SnapshotContext> {
  const { data: gang } = await client
    .from('gangs')
    .select('id, timezone, promptpay_id, cancellation_policy')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) throw new AppError('NOT_FOUND', 'ไม่พบก๊วนนี้');
  if (!isValidTimeZone(gang.timezone)) {
    throw new AppError('INTERNAL_ERROR', `ก๊วนตั้ง timezone ที่ไม่ถูกต้อง: ${gang.timezone}`);
  }

  let query = client
    .from('gang_pricing_plans')
    .select('id, name, type, params, rounding_policy, monthly_member_pays_shuttle')
    .eq('gang_id', gangId)
    // 🔴 [ADR-006] แผน `monthly` เป็นค่าสมาชิกรายเดือน ไม่ใช่ราคาของนัด
    .in('type', SESSION_PRICING_TYPES);

  // template อาจตรึงแผนราคาไว้ — แต่ถ้าแผนนั้นถูกปิดไปแล้วต้องไม่เงียบ
  query = pricingPlanId
    ? query.eq('id', pricingPlanId)
    : query.eq('is_active', true).order('created_at', { ascending: false }).limit(1);

  const { data: plan } = await query.maybeSingle();

  if (!plan) {
    // 🔴 ปล่อยให้สร้างนัดโดยไม่มีแผนราคาไม่ได้ — จะไปพังตอนปิดรอบ ซึ่งสายเกินไป
    throw new AppError(
      'VALIDATION_ERROR',
      pricingPlanId
        ? 'แผนราคาที่ตั้งไว้ในตารางประจำใช้ไม่ได้แล้ว — แก้ตารางก่อน'
        : 'ก๊วนนี้ยังไม่ได้ตั้งแผนราคา — ตั้งราคาก่อนสร้างนัด',
    );
  }

  const planType = plan.type as PricingType;
  if (!isPricingImplemented(planType)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `แผนราคาของก๊วนเป็นแบบที่ระบบยังคิดเงินให้ไม่ได้ (${planType}) — เปลี่ยนแผนราคาก่อน`,
    );
  }

  const { data: skillLevels } = await client
    .from('gang_skill_levels')
    .select('label, rank')
    .eq('gang_id', gangId)
    .order('rank');

  const snapshot = buildSnapshot({
    pricingPlan:
      planType === 'court_plus_shuttle'
        ? {
            id: plan.id,
            name: plan.name,
            type: 'court_plus_shuttle',
            courtPlusShuttle: courtPlusShuttleFromJson(plan.params),
          }
        : {
            id: plan.id,
            name: plan.name,
            type: 'flat_rate',
            flatRate: flatRateFromJson(plan.params),
          },
    monthlyMemberPaysShuttle: plan.monthly_member_pays_shuttle ?? true,
    roundingPolicy: roundingFromJson(plan.rounding_policy),
    promptpayId: gang.promptpay_id,
    cancellationPolicy: cancellationFromJson(gang.cancellation_policy),
    skillLevels: skillLevels ?? [],
  });

  return {
    snapshot,
    gang: { id: gang.id, timezone: gang.timezone, promptpay_id: gang.promptpay_id },
  };
}
