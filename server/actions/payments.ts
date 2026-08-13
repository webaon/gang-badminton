'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { BUCKETS, paymentSlipPath, tenantKeyOf } from '@/lib/storage/paths';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

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
