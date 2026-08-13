'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { fromJson as cancellationFromJson } from '@/domain/policies/cancellation';
import { flatRateFromJson } from '@/domain/policies/pricing';
import { assertUsableSnapshot } from '@/domain/sessions/snapshot';
import {
  calculateSessionCharges,
  type Participant,
  type ParticipantStatus,
} from '@/domain/billing/session-billing';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

/**
 * ปิดรอบเก็บเงิน — **ADR-001**
 *
 *   server action อ่าน snapshot + registrations
 *     → `SessionBilling.calculate()` (pure TypeScript)
 *     → `close_session_with_charges()` (จุด commit เดียว atomic)
 *
 * ❌ ห้าม insert `session_charges` ที่อื่น · ❌ ห้ามย้าย logic คิดเงินลง SQL
 */

type SessionRow = {
  id: string;
  gang_id: string;
  status: string;
  starts_at: string;
  snapshot: unknown;
};

/** อ่านทุกอย่างที่ต้องใช้คิดเงิน ณ วินาทีนี้ */
async function loadBillingContext(sessionId: string) {
  const admin = supabaseAdmin();

  const { data: session } = await admin
    .from('sessions')
    .select('id, gang_id, status, starts_at, snapshot')
    .eq('id', sessionId)
    .is('deleted_at', null)
    .maybeSingle<SessionRow>();

  if (!session) throw new AppError('NOT_FOUND', 'ไม่พบนัดนี้');

  // fail เร็วถ้า snapshot ใช้การไม่ได้ ดีกว่าคิดเงินผิดแล้วไปรู้ทีหลัง
  assertUsableSnapshot(session.snapshot);
  const snapshot = session.snapshot as {
    pricing_plan: { type: string; params: unknown };
    cancellation_policy: unknown;
  };

  const { data: registrations } = await admin
    .from('session_registrations')
    .select('id, user_id, status, cancelled_at')
    .eq('session_id', sessionId)
    .is('deleted_at', null);

  const rows = registrations ?? [];

  // สมาชิกรายเดือนอ่านจาก gang_members ตอนนี้ — ไม่ได้อยู่ใน snapshot
  // เพราะเป็นคุณสมบัติของคน ไม่ใช่ของราคา (ดูคอมเมนต์ใน session-billing.ts)
  const userIds = rows.map((r) => r.user_id).filter((id): id is string => id !== null);

  const monthly = new Set<string>();
  if (userIds.length > 0) {
    const { data: members } = await admin
      .from('gang_members')
      .select('user_id, is_monthly_member')
      .eq('gang_id', session.gang_id)
      .in('user_id', userIds)
      .is('deleted_at', null);

    for (const m of members ?? []) {
      if (m.is_monthly_member) monthly.add(m.user_id);
    }
  }

  const participants: Participant[] = rows.map((r) => ({
    registrationId: r.id,
    status: r.status as ParticipantStatus,
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : null,
    isMonthlyMember: r.user_id !== null && monthly.has(r.user_id),
  }));

  return {
    session,
    participants,
    billingSnapshot: {
      pricingType: snapshot.pricing_plan.type,
      amountPerPerson: flatRateFromJson(snapshot.pricing_plan.params).amountPerPerson,
      cancellationPolicy: cancellationFromJson(snapshot.cancellation_policy),
    },
  };
}

export type CloseSessionInput = {
  /** `billing` = ปิดรอบปกติ · `cancelled` = ยกเลิกกลางคัน */
  toStatus?: 'billing' | 'cancelled';
  /**
   * สัดส่วนที่เก็บเมื่อยกเลิกกลางคัน (0-1)
   *
   * **[ADR-004]** ไม่ส่งมา = ใช้ค่าตั้งต้นของก๊วนที่แช่แข็งไว้ใน snapshot
   * ส่งมา = แอดมินแก้ตอนกดยกเลิก
   */
  midwayCancelRatio?: number;
};

export async function closeSessionWithBilling(
  sessionId: string,
  input: CloseSessionInput = {},
): Promise<ApiResponse<{ status: string; chargeCount: number; total: string }>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const first = await loadBillingContext(sessionId);

    const { data: membership } = await supabase
      .from('gang_members')
      .select('role')
      .eq('gang_id', first.session.gang_id)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();

    assertCan({ role: (membership?.role as GangRole | undefined) ?? null }, 'billing.close');

    const toStatus = input.toStatus ?? 'billing';

    /**
     * 🔴 จัดการ `INVALID_TRANSITION` ด้วยการ **คำนวณใหม่** ไม่ใช่ retry ดิบๆ
     *
     * `expected_status` เป็น optimistic guard — ถ้าไม่ตรงแปลว่าสถานะเปลี่ยนไป
     * ระหว่างที่เราคำนวณอยู่ (เช่นมีคนกดเริ่มเล่น หรือมีคนยกเลิกเพิ่ม)
     * ⇒ ยิงซ้ำด้วยตัวเลขเดิมคือการยัดยอดที่ล้าสมัยลงไป ต้องอ่านใหม่แล้วคิดใหม่
     */
    const attempt = async (context: Awaited<ReturnType<typeof loadBillingContext>>) => {
      const result = calculateSessionCharges({
        snapshot: context.billingSnapshot,
        participants: context.participants,
        startsAt: new Date(context.session.starts_at),
        // [ADR-004] ยกเลิกกลางคัน: ใช้ค่าที่แอดมินระบุ ไม่งั้นใช้ค่าตั้งต้นของก๊วน
        // ที่แช่แข็งไว้ใน snapshot (ไม่ใช่ค่าปัจจุบันของก๊วน — baseline §Snapshot rule)
        ...(toStatus === 'cancelled'
          ? {
              midwayCancelRatio:
                input.midwayCancelRatio ??
                context.billingSnapshot.cancellationPolicy.midwayCancelRatio,
            }
          : {}),
      });

      const { error } = await supabaseAdmin().rpc('close_session_with_charges', {
        p_session_id: sessionId,
        p_charges: result.charges.map((c) => ({
          registration_id: c.registrationId,
          amount: c.amount,
          breakdown: c.breakdown,
        })),
        p_expected_status: context.session.status,
        p_to_status: toStatus,
        p_actor_id: user.id,
        p_correlation_id: correlationId,
      });

      return { error, result };
    };

    let { error, result } = await attempt(first);

    if (error && String(error.message).includes('INVALID_TRANSITION')) {
      console.warn('[billing] สถานะเปลี่ยนระหว่างคำนวณ — คิดใหม่จากข้อมูลล่าสุด', {
        correlationId,
        sessionId,
      });

      const fresh = await loadBillingContext(sessionId);
      ({ error, result } = await attempt(fresh));
    }

    if (error) throw error;

    // เตือนจ่ายเฉพาะคนที่มียอดจริง (baseline §โมดูล ข้อ 6 "เตือนจ่าย")
    if (result.charges.length > 0) {
      const { error: notifyError } = await supabaseAdmin().rpc('enqueue_session_notification', {
        p_session_id: sessionId,
        p_event_type: 'payment.due',
        p_audience: 'charged',
        p_correlation_id: correlationId,
      });

      // เงินถูก commit ไปแล้ว — แจ้งเตือนล้มต้องไม่ทำให้ทั้ง action ล้มตาม
      if (notifyError) {
        console.error('[billing] เข้าคิวเตือนจ่ายไม่สำเร็จ', {
          correlationId,
          sessionId,
          message: notifyError.message,
        });
      }
    }

    revalidatePath(`/gangs/${first.session.gang_id}/sessions/${sessionId}`);

    return {
      status: toStatus,
      chargeCount: result.charges.length,
      total: result.totalCollected,
    };
  });
}
