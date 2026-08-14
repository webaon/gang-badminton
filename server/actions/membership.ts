'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { assertBillingMonth } from '@/domain/billing/membership';
import { monthlyToJson, validateMonthly } from '@/domain/policies/pricing';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import { billOneGang } from '@/server/membership/billing';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

/**
 * ค่าสมาชิกรายเดือน — **[WO-2.5-C]**
 *
 * 🔴 [ADR-006] แผน `monthly` เป็น**คนละแถว**กับแผนราคาต่อนัด
 *    ก๊วนที่เก็บรายเดือนยังต้องมีแผนต่อนัดสำหรับคนที่ไม่ใช่สมาชิกรายเดือน
 */

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function roleInGang(gangId: string, userId: string): Promise<GangRole | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  return (data?.role as GangRole | undefined) ?? null;
}

/** วันนี้ตามนาฬิกาของก๊วน — `monthly_member_since/until` เป็น `date` ไม่มีโซน */
async function todayInGang(gangId: string): Promise<string> {
  const supabase = await supabaseServer();
  const { data } = await supabase.from('gangs').select('timezone').eq('id', gangId).maybeSingle();

  return utcToZonedWallClock(new Date(), data?.timezone ?? 'Asia/Bangkok').slice(0, 10);
}

export async function upsertMonthlyPlan(
  gangId: string,
  monthlyFee: string,
  planId?: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'gang.pricing.manage');

    const issues = validateMonthly({ monthlyFee });
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', issues.map((i) => i.message).join(' · '));
    }

    const supabase = await supabaseServer();

    const payload = {
      gang_id: gangId,
      name: 'ค่าสมาชิกรายเดือน',
      type: 'monthly' as const,
      params: monthlyToJson({ monthlyFee }),
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
    revalidatePath(`/gangs/${gangId}/membership`);
    return assertOne<{ id: string }>(rows);
  });
}

/**
 * ตั้ง/ยกเลิกสถานะสมาชิกรายเดือน
 *
 * ⚠️ ยกเลิกแล้ว**ไม่ลบบิลที่ออกไปแล้ว** — บันทึก `monthly_member_until` เป็นวันนี้
 *    แล้วเดือนถัดไปจะไม่ถูกออกบิลเอง (ประวัติเงินต้องอยู่ครบ)
 */
export async function setMonthlyMembership(
  gangId: string,
  memberId: string,
  isMonthly: boolean,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'gang.member.manage');

    const today = await todayInGang(gangId);
    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('gang_members')
        .update(
          isMonthly
            ? { is_monthly_member: true, monthly_member_since: today, monthly_member_until: null }
            : { is_monthly_member: false, monthly_member_until: today },
        )
        .eq('id', memberId)
        .eq('gang_id', gangId)
        .is('deleted_at', null)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/members`);
    revalidatePath(`/gangs/${gangId}/membership`);
    return assertOne<{ id: string }>(rows);
  });
}

/**
 * ออกบิลรอบนี้เดี๋ยวนี้ — ปุ่มของแอดมิน
 *
 * 🔴 idempotent: กดซ้ำไม่สร้างซ้ำ (partial unique index กันที่ฐานข้อมูล)
 *    ⇒ ใช้เก็บคนที่สมัครกลางเดือนหลัง cron รันไปแล้วได้ด้วย
 */
export async function generateMonthlyFeesNow(
  gangId: string,
  billingMonth?: string,
): Promise<ApiResponse<{ created: number; skipped: number; billingMonth: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'billing.close');

    if (billingMonth !== undefined) {
      try {
        assertBillingMonth(billingMonth);
      } catch (err) {
        throw new AppError('VALIDATION_ERROR', (err as Error).message, { cause: err });
      }
    }

    const outcome = await billOneGang({ gangId, billingMonth, actorId: user.id, correlationId });

    if (!outcome) {
      throw new AppError(
        'VALIDATION_ERROR',
        'ก๊วนนี้ยังไม่ได้ตั้งค่าสมาชิกรายเดือน — ตั้งค่าในหน้าตั้งค่าก๊วนก่อน',
      );
    }

    revalidatePath(`/gangs/${gangId}/membership`);
    return {
      created: outcome.created,
      skipped: outcome.skipped,
      billingMonth: outcome.billingMonth,
    };
  });
}
