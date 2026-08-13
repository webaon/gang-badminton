'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import {
  DEFAULT_ROUNDING_POLICY,
  flatRateToJson,
  isImplemented as isPricingImplemented,
  roundingToJson,
  validateFlatRate,
  type FlatRateParams,
  type PricingType,
} from '@/domain/policies/pricing';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

/** ระดับฝีมือ + แผนราคาของก๊วน — แอดมินเท่านั้น */

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function assertGangAdmin(gangId: string, action: 'gang.skill.manage' | 'gang.pricing.manage') {
  const user = await requireUser();
  const supabase = await supabaseServer();

  const { data } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  assertCan({ role: (data?.role as GangRole | undefined) ?? null }, action);
  return user;
}

// ---------------------------------------------------------------------------
// ระดับฝีมือ
// ---------------------------------------------------------------------------

export async function addSkillLevel(
  gangId: string,
  label: string,
  rank: number,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    await assertGangAdmin(gangId, 'gang.skill.manage');

    if (label.trim() === '') throw new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อระดับฝีมือ');
    if (!Number.isInteger(rank) || rank < 1) {
      throw new AppError('VALIDATION_ERROR', 'ลำดับต้องเป็นจำนวนเต็มตั้งแต่ 1');
    }

    const supabase = await supabaseServer();

    try {
      const rows = unwrap(
        await supabase
          .from('gang_skill_levels')
          .insert({ gang_id: gangId, label: label.trim(), rank })
          .select('id'),
      );
      revalidatePath(`/gangs/${gangId}/settings`);
      return assertOne<{ id: string }>(rows);
    } catch (err) {
      // ชน gang_skill_levels_gang_rank_key
      if ((err as { message?: string }).message?.includes('gang_rank_key')) {
        throw new AppError('VALIDATION_ERROR', 'ลำดับนี้ถูกใช้ไปแล้วในก๊วนนี้');
      }
      throw err;
    }
  });
}

export async function removeSkillLevel(
  gangId: string,
  skillLevelId: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    await assertGangAdmin(gangId, 'gang.skill.manage');

    const supabase = await supabaseServer();

    // `gang_members.skill_level_id` เป็น ON DELETE SET NULL ⇒ ลบได้โดยไม่ทำให้สมาชิกหาย
    const rows = unwrap(
      await supabase
        .from('gang_skill_levels')
        .delete()
        .eq('id', skillLevelId)
        .eq('gang_id', gangId)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/settings`);
    return assertOne<{ id: string }>(rows);
  });
}

// ---------------------------------------------------------------------------
// แผนราคา — MVP-0 รองรับ flat_rate โมเดลเดียว (ADR-002)
// ---------------------------------------------------------------------------

export type PricingPlanInput = {
  name: string;
  type: PricingType;
  flatRate: FlatRateParams;
};

export async function upsertPricingPlan(
  gangId: string,
  input: PricingPlanInput,
  planId?: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await assertGangAdmin(gangId, 'gang.pricing.manage');

    // 🔴 ปฏิเสธโมเดลที่ยังไม่ implement อย่างชัดเจน
    //    ปล่อยผ่านแล้วคิดเงินไม่ได้ตอนปิดรอบจะแย่กว่ามาก — ก๊วนตั้งราคาไว้ทั้งเดือน
    //    แล้วเพิ่งรู้ว่าระบบคิดให้ไม่ได้
    if (!isPricingImplemented(input.type)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'ตอนนี้รองรับเฉพาะแบบเหมาจ่ายต่อหัว (โมเดลอื่นอยู่ระหว่างพัฒนา)',
      );
    }

    const issues = validateFlatRate(input.flatRate);
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', issues.map((i) => i.message).join(' · '));
    }

    if (input.name.trim() === '') throw new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อแผนราคา');

    const supabase = await supabaseServer();

    const payload = {
      gang_id: gangId,
      name: input.name.trim(),
      type: input.type,
      params: flatRateToJson(input.flatRate),
      rounding_policy: roundingToJson(DEFAULT_ROUNDING_POLICY),
      updated_by: user.id,
    };

    const rows = unwrap(
      planId
        ? await supabase
            .from('gang_pricing_plans')
            .update(payload)
            .eq('id', planId)
            .eq('gang_id', gangId)
            .select('id')
        : await supabase
            .from('gang_pricing_plans')
            .insert({ ...payload, created_by: user.id })
            .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/settings`);
    return assertOne<{ id: string }>(rows);
  });
}
