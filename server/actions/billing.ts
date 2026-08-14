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
  roundingFromJson,
} from '@/domain/policies/pricing';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { assertUsableSnapshot } from '@/domain/sessions/snapshot';
import {
  calculateSessionCharges,
  requiresCloseConfirmation,
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
    pricing_plan: { type: string; params: unknown; monthly_member_pays_shuttle?: boolean };
    rounding_policy?: unknown;
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

  /**
   * จำนวนลูกที่ใช้ทั้งนัด — **[WO-2.5-B]** ต้องใช้เฉพาะ `court_plus_shuttle`
   *
   * ⚠️ อ่านจาก `games` ตอนปิดรอบ ไม่ได้อยู่ใน snapshot (snapshot แช่แข็ง "ราคา"
   *    ส่วนนี่คือ "ปริมาณ" ที่เกิดระหว่างนัด — WO-2.5-A ทำให้แก้ได้ก่อนปิดรอบ)
   *
   * ⚠️ บวกกันในหน่วย 1/100 ลูก ด้วย helper ของเงิน เพราะเป็นทศนิยม 2 ตำแหน่ง
   *    เหมือนกัน ⇒ ไม่มี float เข้ามาเกี่ยว
   */
  let shuttlesUsedTotal: string | undefined;
  if (snapshot.pricing_plan.type === 'court_plus_shuttle') {
    const { data: games } = await admin
      .from('games')
      .select('shuttles_used')
      .eq('session_id', sessionId);

    shuttlesUsedTotal = fromSatang(
      sumSatang((games ?? []).map((g) => toSatang(String(g.shuttles_used ?? '0')))),
    );
  }

  return {
    session,
    participants,
    shuttlesUsedTotal,
    billingSnapshot: {
      pricingType: snapshot.pricing_plan.type,
      amountPerPerson: flatRateFromJson(snapshot.pricing_plan.params).amountPerPerson,
      courtPlusShuttle: courtPlusShuttleFromJson(snapshot.pricing_plan.params),
      roundingPolicy: roundingFromJson(snapshot.rounding_policy),
      // snapshot เก่าไม่มีคีย์นี้ ⇒ true = default ของ schema (ค่าลูกคิดตามจริง)
      monthlyMemberPaysShuttle: snapshot.pricing_plan.monthly_member_pays_shuttle ?? true,
      cancellationPolicy: cancellationFromJson(snapshot.cancellation_policy),
    },
  };
}

/** ชื่อที่แสดงในหน้าสรุปยอด — อ่านแยกจาก billing context เพราะการคิดเงินไม่ต้องรู้จักชื่อคน */
async function displayNames(sessionId: string): Promise<Map<string, string>> {
  const { data } = await supabaseAdmin()
    .from('session_registrations')
    .select('id, guest_name, profiles(display_name)')
    .eq('session_id', sessionId)
    .is('deleted_at', null);

  type Row = { id: string; guest_name: string | null; profiles: { display_name: string } | null };

  return new Map(
    ((data ?? []) as unknown as Row[]).map((r) => [
      r.id,
      r.profiles?.display_name ?? r.guest_name ?? 'ไม่ทราบชื่อ',
    ]),
  );
}

export type ChargePreviewRow = {
  registrationId: string;
  displayName: string;
  /** สถานะการลงชื่อ ณ ตอนดูตัวอย่าง */
  status: ParticipantStatus;
  /** ทำไมถึงต้องจ่าย/ไม่ต้องจ่าย — มาจาก `chargeReason()` ตรงๆ */
  reason: string;
  amount: string;
  isMonthlyMember: boolean;
};

export type BillingPreview = {
  sessionStatus: string;
  /** โมเดลคิดเงินที่แช่แข็งไว้ใน snapshot ของนัดนี้ */
  pricingType: string;
  /** จำนวนลูกที่ใช้ทั้งนัด — มีเฉพาะ `court_plus_shuttle` [WO-2.5-B] */
  shuttlesUsedTotal?: string;
  /** เศษจากการปัด (ติดลบ = ก๊วนรับส่วนต่างเอง) */
  roundingSurplus: string;
  rows: ChargePreviewRow[];
  total: string;
  chargedCount: number;
  checkedInCount: number;
  /** true = ต้องติ๊กยืนยันก่อน ไม่งั้น `closeSessionWithBilling()` จะปฏิเสธ */
  needsConfirmation: boolean;
  /** เรื่องที่ต้องอ่านก่อนกดยืนยัน — ไม่ใช่ error แต่ปล่อยผ่านแล้วเก็บเงินผิด */
  warnings: string[];
};

/**
 * **[WO-2.5-A]** สรุปยอดก่อนกดปิดรอบ — อ่านอย่างเดียว ไม่ commit อะไรเลย
 *
 * 🔴 ใช้ `calculateSessionCharges()` ตัวเดียวกับตอนปิดรอบจริง
 *    ❌ ห้ามคำนวณยอดซ้ำด้วยสูตรของตัวเองที่นี่ — สองสูตรจะเบี่ยงจากกันวันใดวันหนึ่ง
 *    แล้วหน้าจอจะโกหกว่าจะเก็บเท่าไหร่
 */
export async function previewSessionCharges(
  sessionId: string,
  input: { toStatus?: 'billing' | 'cancelled'; midwayCancelRatio?: number } = {},
): Promise<ApiResponse<BillingPreview>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const context = await loadBillingContext(sessionId);

    const { data: membership } = await supabase
      .from('gang_members')
      .select('role')
      .eq('gang_id', context.session.gang_id)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();

    assertCan({ role: (membership?.role as GangRole | undefined) ?? null }, 'billing.close');

    const toStatus = input.toStatus ?? 'billing';
    const result = calculateSessionCharges({
      snapshot: context.billingSnapshot,
      participants: context.participants,
      startsAt: new Date(context.session.starts_at),
      shuttlesUsedTotal: context.shuttlesUsedTotal,
      ...(toStatus === 'cancelled'
        ? {
            midwayCancelRatio:
              input.midwayCancelRatio ?? context.billingSnapshot.cancellationPolicy.midwayCancelRatio,
          }
        : {}),
    });

    const names = await displayNames(sessionId);
    const chargeOf = new Map(result.charges.map((c) => [c.registrationId, c]));

    // แสดง**ทุกคน**ที่ลงชื่อไว้ ไม่ใช่เฉพาะคนที่มียอด — คนที่ "ไม่ถูกเก็บ"
    // คือสิ่งที่แอดมินต้องตรวจมากที่สุด (เช่นลืมเช็คอินให้ หรือ no-show ผิดคน)
    const rows: ChargePreviewRow[] = context.participants.map((p) => {
      const charge = chargeOf.get(p.registrationId);
      return {
        registrationId: p.registrationId,
        displayName: names.get(p.registrationId) ?? 'ไม่ทราบชื่อ',
        status: p.status,
        reason: String(charge?.breakdown.reason ?? reasonWhenFree(p)),
        amount: charge?.amount ?? '0.00',
        isMonthlyMember: p.isMonthlyMember,
      };
    });

    const checkedInCount = context.participants.filter((p) => p.status === 'checked_in').length;
    const seated = context.participants.filter((p) =>
      ['confirmed', 'checked_in'].includes(p.status),
    ).length;

    const needsConfirmation = requiresCloseConfirmation(context.participants);

    const warnings: string[] = [];
    // ใช้กติกาเดียวกับด่านยืนยันตอนปิดรอบจริง — หน้าจอกับ server ต้องเตือนตรงกัน
    if (needsConfirmation) {
      warnings.push(
        `ยังไม่มีใครเช็คอินเลย แต่มีคนได้ที่ ${seated} คน — ` +
          'ถ้าปิดรอบตอนนี้ ทุกคนจะถูกคิดเงินในฐานะ "ไม่ได้เช็คอิน" ตามนโยบายของก๊วน',
      );
    }
    if (result.charges.length === 0) {
      warnings.push('ไม่มีใครถูกเก็บเงินในรอบนี้ — ตรวจสถานะแต่ละคนก่อนยืนยัน');
    }

    return {
      sessionStatus: context.session.status,
      pricingType: context.billingSnapshot.pricingType,
      shuttlesUsedTotal: context.shuttlesUsedTotal,
      roundingSurplus: result.roundingSurplus,
      rows,
      total: result.totalCollected,
      chargedCount: result.charges.length,
      checkedInCount,
      needsConfirmation,
      warnings,
    };
  });
}

/** เหตุผลของคนที่ไม่มียอด — charge ไม่ถูกสร้าง จึงไม่มี breakdown ให้อ่าน */
function reasonWhenFree(p: Participant): string {
  if (p.status === 'waitlist') return 'waitlist';
  if (p.status === 'cancelled') return 'cancelled_in_time';
  if (p.isMonthlyMember) return 'monthly_member';
  return 'not_charged';
}

export type CloseSessionInput = {
  /** `billing` = ปิดรอบปกติ · `cancelled` = ยกเลิกกลางคัน */
  toStatus?: 'billing' | 'cancelled';
  /**
   * ยืนยันว่าตั้งใจปิดรอบทั้งที่ไม่มีใครเช็คอิน
   *
   * **[WO-2.5-A]** ค่าเริ่มต้นคือ "ไม่ยืนยัน" ⇒ action จะปฏิเสธ
   * ดูเหตุผลที่จุด raise ด้านล่าง
   */
  confirmNoCheckIn?: boolean;
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
     * 🔴 **[WO-2.5-A]** ปิดรอบทั้งที่ไม่มีใครเช็คอินเลย = สัญญาณว่าลืมเปิดคอนโซล
     *
     * `penalty_type = full_share` ทำให้ `confirmed` ที่ไม่เคยเช็คอินถูกเก็บเต็ม
     * เท่ากับคนไม่มา ⇒ ถ้าปล่อยผ่านเงียบๆ ทั้งก๊วนจะโดนเก็บเงินด้วยเหตุผลผิด
     * และเงินถูก commit ไปแล้วแก้ไม่ได้
     *
     * ⚠️ นี่คือ "ให้ยืนยัน" ไม่ใช่ "ห้าม" — วันที่ไม่มีใครมาจริงๆ ก็ต้องปิดรอบได้
     */
    if (
      toStatus === 'billing' &&
      !input.confirmNoCheckIn &&
      requiresCloseConfirmation(first.participants)
    ) {
      const seated = first.participants.filter((p) => p.status === 'confirmed').length;
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        `ยังไม่มีใครเช็คอินเลย แต่มีคนได้ที่ ${seated} คน — ตรวจหน้าสรุปยอดแล้วยืนยันอีกครั้ง`,
      );
    }

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
        shuttlesUsedTotal: context.shuttlesUsedTotal,
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
