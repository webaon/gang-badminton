'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { fromJson as cancellationFromJson } from '@/domain/policies/cancellation';
import {
  courtPlusShuttleFromJson,
  flatRateFromJson,
  isImplemented as isPricingImplemented,
  roundingFromJson,
  type PricingType,
} from '@/domain/policies/pricing';
import { buildSnapshot } from '@/domain/sessions/snapshot';
import { isValidTimeZone, zonedTimeToUtc } from '@/domain/time/timezone';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

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

export type CreateSessionInput = {
  title: string;
  venue: string | null;
  /** เวลาบนนาฬิกาของก๊วน เช่น `2026-08-20T19:00` — ไม่ใช่ ISO instant */
  startsAtLocal: string;
  endsAtLocal: string;
  courtCount: number;
  maxPlayers: number;
  allowGuests: boolean;
};

/**
 * สร้างนัดใหม่
 *
 * 🔴 สองอย่างที่ห้ามพลาด:
 *
 *   1. **snapshot ต้องครบตอนสร้าง** — baseline §Snapshot rule
 *      อ่านราคา/policy/skill ณ ตอนนี้แล้วแช่แข็งลงไป
 *      ตอนคิดเงินจะอ่านจาก snapshot เท่านั้น ไม่กลับมาอ่านตารางอีก
 *
 *   2. **นัดใหม่เป็น `draft` เสมอ** — policy `sessions_insert_admin_draft_only` [D-14]
 *      บังคับอยู่แล้วระดับ DB แต่เขียนให้ชัดที่นี่ด้วยเพื่อไม่ให้ใครงงว่าทำไม insert ไม่ผ่าน
 *      เปิดรับสมัครต้องเรียก `openSession()` ซึ่งไปที่ `transition_session()`
 */
export async function createSession(
  gangId: string,
  input: CreateSessionInput,
): Promise<ApiResponse<{ sessionId: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'session.create');

    if (input.title.trim() === '') throw new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อนัด');
    if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < 1) {
      throw new AppError('VALIDATION_ERROR', 'จำนวนคนสูงสุดต้องเป็นจำนวนเต็มตั้งแต่ 1');
    }
    if (!Number.isInteger(input.courtCount) || input.courtCount < 1) {
      throw new AppError('VALIDATION_ERROR', 'จำนวนคอร์ทต้องเป็นจำนวนเต็มตั้งแต่ 1');
    }

    const supabase = await supabaseServer();

    const { data: gang } = await supabase
      .from('gangs')
      .select('id, timezone, promptpay_id, cancellation_policy')
      .eq('id', gangId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!gang) throw new AppError('NOT_FOUND', 'ไม่พบก๊วนนี้');
    if (!isValidTimeZone(gang.timezone)) {
      throw new AppError('INTERNAL_ERROR', `ก๊วนตั้ง timezone ที่ไม่ถูกต้อง: ${gang.timezone}`);
    }

    // แปลงเวลาที่แอดมินกรอก (เวลาของก๊วน) เป็น instant จริง
    let startsAt: Date;
    let endsAt: Date;
    try {
      startsAt = zonedTimeToUtc(input.startsAtLocal, gang.timezone);
      endsAt = zonedTimeToUtc(input.endsAtLocal, gang.timezone);
    } catch (err) {
      throw new AppError('VALIDATION_ERROR', (err as Error).message, { cause: err });
    }

    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new AppError('VALIDATION_ERROR', 'เวลาจบต้องหลังเวลาเริ่ม');
    }

    const { data: plan } = await supabase
      .from('gang_pricing_plans')
      .select('id, name, type, params, rounding_policy, monthly_member_pays_shuttle')
      .eq('gang_id', gangId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!plan) {
      // 🔴 ปล่อยให้สร้างนัดโดยไม่มีแผนราคาไม่ได้ — snapshot จะไม่มีข้อมูลคิดเงิน
      //    แล้วจะไปพังตอนปิดรอบ ซึ่งสายเกินไป (คนเล่นจบแล้ว เก็บเงินไม่ได้)
      throw new AppError(
        'VALIDATION_ERROR',
        'ก๊วนนี้ยังไม่ได้ตั้งแผนราคา — ตั้งราคาก่อนสร้างนัด',
      );
    }

    const { data: skillLevels } = await supabase
      .from('gang_skill_levels')
      .select('label, rank')
      .eq('gang_id', gangId)
      .order('rank');

    const planType = plan.type as PricingType;

    // 🔴 กันไม่ให้แช่แข็ง snapshot ของโมเดลที่คิดเงินไม่ได้
    //    ถ้าปล่อยผ่าน คนจะเล่นจบทั้งนัดแล้วเพิ่งรู้ตอนกดปิดรอบว่าเก็บเงินไม่ได้
    if (!isPricingImplemented(planType)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `แผนราคาของก๊วนเป็นแบบที่ระบบยังคิดเงินให้ไม่ได้ (${planType}) — เปลี่ยนแผนราคาก่อนสร้างนัด`,
      );
    }

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

    const rows = unwrap(
      await supabase
        .from('sessions')
        .insert({
          gang_id: gangId,
          title: input.title.trim(),
          venue: input.venue?.trim() || null,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          court_count: input.courtCount,
          max_players: input.maxPlayers,
          allow_guests: input.allowGuests,
          // 🔴 draft เสมอ — เปิดรับสมัครผ่าน transition_session()
          status: 'draft',
          snapshot,
          created_by: user.id,
        })
        .select('id'),
    );

    const row = assertOne<{ id: string }>(rows);

    revalidatePath(`/gangs/${gangId}/sessions`);
    return { sessionId: row.id };
  });
}

/**
 * เปลี่ยนสถานะนัด — ทางเดียวคือ `transition_session()`
 *
 * ❌ ห้าม `UPDATE sessions SET status` ตรง (trigger บล็อกอยู่แล้ว แต่ห้ามแม้แต่จะลอง)
 */
export async function transitionSession(
  sessionId: string,
  toStatus: 'open' | 'in_play' | 'billing' | 'settled' | 'archived' | 'cancelled',
): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: session } = await supabase
      .from('sessions')
      .select('id, gang_id')
      .eq('id', sessionId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!session) throw new AppError('NOT_FOUND', 'ไม่พบนัดนี้');

    assertCan({ role: await roleInGang(session.gang_id, user.id) }, 'session.transition');

    const { data, error } = await supabaseAdmin().rpc('transition_session', {
      p_session_id: sessionId,
      p_to_status: toStatus,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    // แจ้งสมาชิกก๊วนเมื่อเปิดรับสมัคร (baseline §โมดูล ข้อ 6 "เปิดรอบใหม่")
    //
    // ⚠️ เข้าคิวอย่างเดียว — worker เป็นคนส่ง ⇒ ถ้าคิวมีปัญหาก็ไม่ทำให้การเปิดนัดล้ม
    //    ซึ่งสำคัญกว่า: แจ้งเตือนช้าได้ แต่เปิดนัดไม่ได้คือปัญหาจริง
    if (toStatus === 'open') {
      const { error: notifyError } = await supabaseAdmin().rpc('enqueue_session_notification', {
        p_session_id: sessionId,
        p_event_type: 'session.opened',
        p_audience: 'gang_members',
        p_correlation_id: correlationId,
      });

      // 🔴 ห้าม swallow เงียบ — log ไว้ให้ตามได้ แต่ไม่โยนต่อ
      if (notifyError) {
        console.error('[sessions] เข้าคิวแจ้งเตือนไม่สำเร็จ', {
          correlationId,
          sessionId,
          message: notifyError.message,
        });
      }
    }

    revalidatePath(`/gangs/${session.gang_id}/sessions`);
    return { status: (data as { status: string }).status };
  });
}

export type UpdateSessionInput = Omit<CreateSessionInput, never>;

/**
 * แก้รายละเอียดนัด
 *
 * ⚠️ **ไม่แตะ snapshot** — snapshot ถูกแช่แข็งตอนสร้าง การแก้ชื่อ/สนาม/เวลา
 *    ไม่ควรทำให้ราคาเปลี่ยน ถ้าอยากได้ราคาใหม่ต้องสร้างนัดใหม่
 */
export async function updateSession(
  sessionId: string,
  input: UpdateSessionInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: session } = await supabase
      .from('sessions')
      .select('id, gang_id, status, gangs!inner(timezone)')
      .eq('id', sessionId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!session) throw new AppError('NOT_FOUND', 'ไม่พบนัดนี้');

    assertCan({ role: await roleInGang(session.gang_id, user.id) }, 'session.update');

    if (!['draft', 'open'].includes(session.status)) {
      throw new AppError('INVALID_TRANSITION', 'แก้ได้เฉพาะนัดที่ยังไม่เริ่มเล่น');
    }

    const timezone = (session as unknown as { gangs: { timezone: string } }).gangs.timezone;

    let startsAt: Date;
    let endsAt: Date;
    try {
      startsAt = zonedTimeToUtc(input.startsAtLocal, timezone);
      endsAt = zonedTimeToUtc(input.endsAtLocal, timezone);
    } catch (err) {
      throw new AppError('VALIDATION_ERROR', (err as Error).message, { cause: err });
    }

    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new AppError('VALIDATION_ERROR', 'เวลาจบต้องหลังเวลาเริ่ม');
    }

    const rows = unwrap(
      await supabase
        .from('sessions')
        .update({
          title: input.title.trim(),
          venue: input.venue?.trim() || null,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          court_count: input.courtCount,
          max_players: input.maxPlayers,
          allow_guests: input.allowGuests,
          updated_by: user.id,
        })
        .eq('id', sessionId)
        .select('id'),
    );

    revalidatePath(`/gangs/${session.gang_id}/sessions`);
    return assertOne<{ id: string }>(rows);
  });
}
