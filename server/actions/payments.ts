'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { validateAdjustment, type AdjustmentType } from '@/domain/billing/ledger';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { moneyFromDb } from '@/lib/supabase/money';
import { BUCKETS, paymentSlipPath, tenantKeyOf } from '@/lib/storage/paths';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

/** บวกเงินเป็นจำนวนเต็มสตางค์ — ห้ามใช้ `Number()` บวกกันตรงๆ (CLAUDE.md §2.6) */
function sumMoney(amounts: string[]): string {
  return fromSatang(sumSatang(amounts.map(toSatang)));
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

/** ออกใบจ่ายจาก charges ของตัวเองในนัดนั้น */
export async function createMyPayment(
  sessionId: string,
): Promise<ApiResponse<{ paymentId: string; amount: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: session } = await admin
      .from('sessions')
      .select('id, gang_id')
      .eq('id', sessionId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!session) throw new AppError('NOT_FOUND', 'ไม่พบนัดนี้');
    assertCan({ role: await roleInGang(session.gang_id, user.id) }, 'payment.submit.self');

    // charges ของ "ตัวเอง" = charge ที่ผูกกับ registration ที่เป็น user นี้
    const { data: charges } = await admin
      .from('session_charges')
      .select('id, session_registrations!inner(user_id)')
      .eq('session_id', sessionId)
      .eq('type', 'session');

    type Row = { id: string; session_registrations: { user_id: string | null } };
    const mine = ((charges ?? []) as unknown as Row[])
      .filter((c) => c.session_registrations.user_id === user.id)
      .map((c) => c.id);

    if (mine.length === 0) throw new AppError('CHARGE_NOT_FOUND', 'ไม่มียอดที่ต้องจ่ายในนัดนี้');

    const { data, error } = await admin.rpc('create_payment_for_charges', {
      p_gang_id: session.gang_id,
      p_payer_user_id: user.id,
      p_charge_ids: mine,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;
    const payment = data as { id: string; amount: string };

    revalidatePath(`/gangs/${session.gang_id}/sessions/${sessionId}/pay`);
    return { paymentId: payment.id, amount: payment.amount };
  });
}

/**
 * ขอ path สำหรับอัปสลิป
 *
 * 🔴 [D-15] **server เป็นคนประกอบ path** — client อัปโหลดไปที่ path ที่ได้จากตรงนี้
 *    เท่านั้น ห้ามให้ client ตั้ง path เอง เพราะสิทธิ์ของ storage ตรวจจาก path
 */
export async function prepareSlipUpload(
  paymentId: string,
  fileName: string,
): Promise<ApiResponse<{ bucket: string; path: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();

    const { data: payment } = await supabaseAdmin()
      .from('payments')
      .select('id, gang_id, payer_user_id, status')
      .eq('id', paymentId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'ไม่พบรายการจ่ายนี้');
    if (payment.payer_user_id !== user.id) {
      throw new AppError('FORBIDDEN', 'อัปสลิปได้เฉพาะรายการของตัวเอง');
    }
    if (payment.status === 'verified') {
      throw new AppError('PAYMENT_ALREADY_VERIFIED', 'ยอดนี้ยืนยันแล้ว');
    }

    return {
      bucket: BUCKETS.paymentSlips,
      path: paymentSlipPath(payment.gang_id, payment.id, fileName),
    };
  });
}

/** ยืนยันว่าอัปสลิปแล้ว → `submitted` */
export async function submitSlip(
  paymentId: string,
  slipPath: string,
): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: payment } = await admin
      .from('payments')
      .select('id, gang_id, payer_user_id')
      .eq('id', paymentId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'ไม่พบรายการจ่ายนี้');
    if (payment.payer_user_id !== user.id) {
      throw new AppError('FORBIDDEN', 'อัปสลิปได้เฉพาะรายการของตัวเอง');
    }

    // 🔴 ตรวจซ้ำว่า path ที่ client ส่งกลับมาอยู่ใต้ก๊วนที่ถูกต้องจริง
    //    (client อาจส่ง path อื่นมาแทนที่ path ที่ server ออกให้)
    if (tenantKeyOf(slipPath) !== payment.gang_id) {
      throw new AppError('VALIDATION_ERROR', 'ตำแหน่งไฟล์ไม่ถูกต้อง');
    }

    await admin.from('payments').update({ slip_url: slipPath }).eq('id', paymentId);

    const { data, error } = await admin.rpc('transition_payment', {
      p_payment_id: paymentId,
      p_to_status: 'submitted',
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${payment.gang_id}/payments`);
    return { status: (data as { status: string }).status };
  });
}

/** แอดมินยืนยัน/ปฏิเสธสลิป */
export async function reviewPayment(
  paymentId: string,
  decision: 'verified' | 'rejected',
  reason?: string,
): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: payment } = await admin
      .from('payments')
      .select('id, gang_id')
      .eq('id', paymentId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'ไม่พบรายการจ่ายนี้');
    assertCan({ role: await roleInGang(payment.gang_id, user.id) }, 'payment.verify');

    if (decision === 'rejected' && !reason?.trim()) {
      // ปฏิเสธโดยไม่บอกเหตุผล = ผู้จ่ายไม่รู้ว่าต้องแก้อะไร แล้วจะอัปซ้ำแบบเดิม
      throw new AppError('VALIDATION_ERROR', 'ต้องระบุเหตุผลที่ปฏิเสธ');
    }

    const { data, error } = await admin.rpc('transition_payment', {
      p_payment_id: paymentId,
      p_to_status: decision,
      p_actor_id: user.id,
      p_reason: reason ?? null,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${payment.gang_id}/payments`);
    return { status: (data as { status: string }).status };
  });
}

/** ลิงก์ดูสลิปแบบมีอายุ — bucket เป็น private จึงเปิดตรงไม่ได้ */
export async function slipSignedUrl(paymentId: string): Promise<ApiResponse<{ url: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: payment } = await admin
      .from('payments')
      .select('id, gang_id, payer_user_id, slip_url')
      .eq('id', paymentId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!payment?.slip_url) throw new AppError('NOT_FOUND', 'ยังไม่มีสลิป');

    const role = await roleInGang(payment.gang_id, user.id);
    const isOwner = payment.payer_user_id === user.id;

    if (!isOwner && !['owner', 'admin'].includes(role ?? '')) {
      throw new AppError('FORBIDDEN', 'ดูสลิปนี้ไม่ได้');
    }

    const { data, error } = await admin.storage
      .from(BUCKETS.paymentSlips)
      .createSignedUrl(payment.slip_url, 60 * 5);

    if (error || !data) throw new AppError('INTERNAL_ERROR', 'สร้างลิงก์สลิปไม่สำเร็จ');

    return { url: data.signedUrl };
  });
}

/**
 * จ่ายแทนเพื่อน — 1 สลิปครอบหลาย charge ข้ามคน **[WO-2.5-D]**
 *
 * 🔴 ผู้จ่ายคือคนที่กด (`payer_user_id`) แต่ **หนี้ที่ถูกล้างคือของเจ้าของ charge**
 *    ผูกกันด้วย `payment_allocations` ⇒ ยอดค้างของแต่ละคนคำนวณจาก ledger
 *    ไม่ใช่จาก `payments.status` (baseline §การตัดสินใจสะสม)
 *
 * 🔴 กดซ้ำได้ไม่จำกัด — `create_payment_for_charges()` คืนใบเดิมถ้ายังไม่ verified
 */
export async function createPaymentForCharges(
  gangId: string,
  chargeIds: string[],
  /**
   * ออกใบให้คนอื่นเป็นผู้จ่าย — แอดมินเท่านั้น
   *
   * ⚠️ ไม่ส่ง = ตัวเองเป็นผู้จ่าย (สมาชิกทั่วไปทำได้เท่านี้)
   *    ส่งมาแล้วไม่ใช่ตัวเอง = ต้องมีสิทธิ์ `payment.verify` ไม่งั้นใครก็ยัดหนี้ให้คนอื่นได้
   */
  payerUserId?: string,
): Promise<ApiResponse<{ paymentId: string; amount: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const role = await roleInGang(gangId, user.id);

    // ต้องเป็นสมาชิกก๊วนนี้ถึงจะจ่ายแทนกันได้
    assertCan({ role }, 'payment.submit.self');

    const payer = payerUserId ?? user.id;
    if (payer !== user.id) assertCan({ role }, 'payment.verify');

    if (chargeIds.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'ยังไม่ได้เลือกรายการที่จะจ่าย');
    }

    const { data, error } = await supabaseAdmin().rpc('create_payment_for_charges', {
      p_gang_id: gangId,
      p_payer_user_id: payer,
      p_charge_ids: chargeIds,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;
    const payment = data as { id: string; amount: string };

    revalidatePath(`/gangs/${gangId}/payments`);
    return { paymentId: payment.id, amount: payment.amount };
  });
}

/**
 * ปรับยอดหลัง verify — refund / correction / credit **[WO-2.5-D]**
 *
 * ❌ ห้ามแก้ `session_charges` หรือ `payments` ที่ยืนยันแล้ว (มี trigger กันอีกชั้น)
 *    ทุกการแก้ยอดเป็นแถวใหม่ใน `payment_adjustments` ⇒ ตรวจย้อนหลังได้เสมอ
 */
export async function addChargeAdjustment(
  chargeId: string,
  input: { type: AdjustmentType; amount: string; reason: string; paymentId?: string },
): Promise<ApiResponse<{ id: string; outstanding: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: charge } = await admin
      .from('session_charges')
      .select('id, gang_id, session_id')
      .eq('id', chargeId)
      .maybeSingle();

    if (!charge) throw new AppError('CHARGE_NOT_FOUND', 'ไม่พบยอดเรียกเก็บนี้');
    assertCan({ role: await roleInGang(charge.gang_id, user.id) }, 'payment.verify');

    // ตรวจใน domain ก่อนยิง DB — ข้อความบอกผู้ใช้ได้ละเอียดกว่า error จากฐานข้อมูล
    const { data: allocations } = await admin
      .from('payment_allocations')
      .select('amount, payments!inner(status)')
      .eq('session_charge_id', chargeId);

    type AllocationRow = { amount: string | number; payments: { status: string } };
    const paid = ((allocations ?? []) as unknown as AllocationRow[])
      .filter((a) => a.payments.status === 'verified')
      .map((a) => moneyFromDb(a.amount));

    const { data: existing } = await admin
      .from('payment_adjustments')
      .select('amount')
      .eq('session_charge_id', chargeId);

    const issues = validateAdjustment({
      type: input.type,
      amount: input.amount,
      reason: input.reason,
      allocated: sumMoney(paid),
      existingAdjustments: (existing ?? []).map((a) => moneyFromDb(a.amount)),
    });

    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', issues.map((i) => i.message).join(' · '));
    }

    const { data, error } = await admin.rpc('add_payment_adjustment', {
      p_charge_id: chargeId,
      p_type: input.type,
      p_amount: Number(input.amount),
      p_reason: input.reason,
      p_payment_id: input.paymentId ?? null,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const { data: outstanding } = await admin.rpc('charge_outstanding', { p_charge_id: chargeId });

    revalidatePath(`/gangs/${charge.gang_id}/payments`);
    if (charge.session_id) {
      revalidatePath(`/gangs/${charge.gang_id}/sessions/${charge.session_id}/pay`);
    }

    return { id: (data as { id: string }).id, outstanding: String(outstanding ?? '0') };
  });
}
