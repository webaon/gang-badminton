'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { moneyFromDb } from '@/lib/supabase/money';
import { assertCan } from '@/domain/permissions/can';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import type { GangRole } from '@/domain/permissions/types';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

/**
 * เครดิตสมาชิก **[WO-B5a · ADR-010]**
 *
 * อ่านเงินผ่าน RLS (`credit_balances` / `credit_ledger`) — สมาชิกเห็นของตัวเอง แอดมินเห็นทั้งก๊วน
 * เขียนผ่าน DB function ทางเดียว (`record_overpayment()`) · การหักเครดิตไม่มี action:
 * เกิดอัตโนมัติใน DB เมื่อมีหนี้ใหม่ (trigger บน session_charges → `apply_credit()`)
 *
 * 🔴 ไม่คำนวณเงินที่นี่ — ยอดทุกตัวมาจาก DB แล้วผ่าน `moneyFromDb()`
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

export type CreditEntry = {
  id: string;
  /** ลำดับรายการต่อสมาชิก (เริ่ม 1 ไม่ซ้ำไม่ข้าม) — ใช้เรียงประวัติ */
  seq: number;
  type: 'overpayment' | 'applied' | 'admin_topup' | 'cash_payout' | 'charge_return';
  /** บวก = เข้า / ลบ = ออก (ใช้จ่ายหนี้) */
  amount: string;
  balanceAfter: string;
  reason: string | null;
  paymentId: string | null;
  createdAt: string;
};

export type MemberCredit = {
  gangId: string;
  userId: string;
  /** ยอดเครดิตคงเหลือ — "เงินที่ก๊วนติดสมาชิกคนนี้" */
  balance: string;
  /** รายการล่าสุดก่อน (สูงสุด 50) */
  entries: CreditEntry[];
};

const RECENT_ENTRIES = 50;

async function readMemberCredit(gangId: string, userId: string): Promise<MemberCredit> {
  const supabase = await supabaseServer();

  const { data: balanceRow, error: balanceError } = await supabase
    .from('credit_balances')
    .select('balance')
    .eq('gang_id', gangId)
    .eq('user_id', userId)
    .maybeSingle();
  if (balanceError) throw balanceError;

  const { data: rows, error: ledgerError } = await supabase
    .from('credit_ledger')
    .select('id, seq, type, amount, balance_after, reason, payment_id, created_at')
    .eq('gang_id', gangId)
    .eq('user_id', userId)
    .order('seq', { ascending: false })
    .limit(RECENT_ENTRIES);
  if (ledgerError) throw ledgerError;

  return {
    gangId,
    userId,
    balance: moneyFromDb(balanceRow?.balance),
    entries: (rows ?? []).map((r) => ({
      id: r.id as string,
      seq: Number(r.seq),
      type: r.type as CreditEntry['type'],
      amount: moneyFromDb(r.amount),
      balanceAfter: moneyFromDb(r.balance_after),
      reason: (r.reason as string | null) ?? null,
      paymentId: (r.payment_id as string | null) ?? null,
      createdAt: r.created_at as string,
    })),
  };
}

/** เครดิตของฉันในก๊วนนี้ */
export async function getMyCredit(gangId: string): Promise<ApiResponse<MemberCredit>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'credit.read.self');
    return readMemberCredit(gangId, user.id);
  });
}

/** เครดิตของสมาชิกคนอื่น — แอดมินเท่านั้น (ของตัวเองใช้ `credit.read.self`) */
export async function getMemberCredit(
  gangId: string,
  userId: string,
): Promise<ApiResponse<MemberCredit>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const role = await roleInGang(gangId, user.id);
    assertCan({ role }, user.id === userId ? 'credit.read.self' : 'credit.read.other');
    return readMemberCredit(gangId, userId);
  });
}

export type GangCreditSummary = {
  /** เงินที่ก๊วนติดสมาชิกทั้งหมด = Σ ยอดคงเหลือ (ไม่ใช่เงินสดเข้า) */
  totalOwed: string;
  members: { userId: string; displayName: string; balance: string }[];
};

/** สรุปเครดิตทั้งก๊วน (เฉพาะคนที่ยังมียอด > 0) — แอดมินเท่านั้น */
export async function listGangCredits(gangId: string): Promise<ApiResponse<GangCreditSummary>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'credit.read.other');

    const supabase = await supabaseServer();
    const { data, error } = await supabase
      .from('credit_balances')
      // 🔴 ระบุ FK เสมอ (CLAUDE.md) — credit_balances มี FK ไป profiles ตัวเดียว แต่ระบุไว้กัน embed คลุมเครือในอนาคต
      .select('user_id, balance, profiles!credit_balances_user_id_fkey(display_name)')
      .eq('gang_id', gangId)
      .gt('balance', 0)
      .order('balance', { ascending: false });
    if (error) throw error;

    type Row = {
      user_id: string;
      balance: string | number;
      profiles: { display_name: string | null } | null;
    };
    const members = ((data ?? []) as unknown as Row[]).map((r) => ({
      userId: r.user_id,
      displayName: r.profiles?.display_name ?? 'ไม่ทราบชื่อ',
      balance: moneyFromDb(r.balance),
    }));

    // ผลรวมเป็นสตางค์จำนวนเต็มผ่าน helper ของเงิน (ไม่มี float)
    return {
      totalOwed: fromSatang(sumSatang(members.map((m) => toSatang(m.balance)))),
      members,
    };
  });
}

/**
 * แอดมินบันทึกยอดโอนเกินของสลิปที่ยืนยันแล้ว → เข้าเป็นเครดิตของผู้โอน
 *
 * 🔴 ยอดเครดิต = (ยอดที่โอนจริง − ยอดสลิป) **คำนวณใน DB** จาก `payments.received_amount` ที่แอดมินกรอกไว้
 *    (`setPaymentReceivedAmount`) — `amount` ที่ส่งมาเป็นแค่ "ยืนยันตัวเลข": ต้องเท่ากับที่ DB คำนวณ
 *    (ไม่ส่ง = ใช้ที่ DB คำนวณ) · ไม่มี received_amount ⇒ ปฏิเสธ
 * 🔴 ตัดสินทั้งหมดใน `record_overpayment()` (สลิปต้อง verified · แอดมินจริง · หนึ่งสลิปครั้งเดียว ·
 *    FOR UPDATE ยอด) — ที่นี่แค่ตรวจ `can()` และรูปแบบจำนวนเงิน
 */
export async function recordOverpayment(
  paymentId: string,
  amount: string | null,
  reason: string,
): Promise<ApiResponse<{ balanceAfter: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: payment } = await supabase
      .from('payments')
      .select('id, gang_id')
      .eq('id', paymentId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'ไม่พบการชำระเงินนี้');

    assertCan({ role: await roleInGang(payment.gang_id, user.id) }, 'credit.overpayment.record');

    // ส่งเป็น string เสมอ — ห้ามผ่าน float (CLAUDE.md §2.6); DB ตรวจรูปแบบซ้ำ
    if (amount !== null && !/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
      throw new AppError('VALIDATION_ERROR', 'จำนวนเงินไม่ถูกต้อง');
    }
    if (!reason.trim()) throw new AppError('VALIDATION_ERROR', 'ต้องระบุเหตุผล');

    const { data, error } = await supabaseAdmin().rpc('record_overpayment', {
      p_payment_id: paymentId,
      p_amount: amount === null ? null : amount.trim(),
      p_reason: reason.trim(),
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });
    if (error) throw error;

    const row = data as { balance_after: string | number };
    revalidatePath(`/gangs/${payment.gang_id}/payments`);
    return { balanceAfter: moneyFromDb(row.balance_after) };
  });
}

/**
 * แอดมินกรอก "ยอดที่โอนจริง" ของสลิป (ตอนตรวจ/ยืนยันสลิป) **[WO-B5b-1 · ADR-010 Q1]**
 *
 * ใช้เทียบกับยอดสลิปเพื่อหาส่วนเกิน (โอนเกิน) — ไม่ได้ทำให้เกิดเครดิตเอง ต้องกด `recordOverpayment` ต่างหาก
 * ⚠️ สิทธิ์ `payment.verify` (ผู้ตรวจสลิป) · DB ตรวจแอดมินซ้ำ · แก้ได้จนกว่าจะบันทึกโอนเกินจากสลิปนี้
 * (แยกจาก `reviewPayment` โดยตั้งใจ — ไม่แตะ `payments.ts` ที่มีงานค้างของผู้อื่น · ผูกเข้าปุ่มยืนยันที่ UI ใน WO-6.5)
 */
export async function setPaymentReceivedAmount(
  paymentId: string,
  receivedAmount: string,
): Promise<ApiResponse<{ receivedAmount: string; amount: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: payment } = await supabase
      .from('payments')
      .select('id, gang_id')
      .eq('id', paymentId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'ไม่พบการชำระเงินนี้');

    assertCan({ role: await roleInGang(payment.gang_id, user.id) }, 'payment.verify');

    if (!/^\d+(\.\d{1,2})?$/.test(receivedAmount.trim())) {
      throw new AppError('VALIDATION_ERROR', 'ยอดที่โอนจริงไม่ถูกต้อง');
    }

    const { data, error } = await supabaseAdmin().rpc('set_payment_received_amount', {
      p_payment_id: paymentId,
      p_received: receivedAmount.trim(),
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });
    if (error) throw error;

    const row = data as { amount: string | number; received_amount: string | number };
    revalidatePath(`/gangs/${payment.gang_id}/payments`);
    // ส่วนเกินคำนวณใน DB ตอน record_overpayment เท่านั้น — ไม่คำนวณเงินที่นี่
    return { receivedAmount: moneyFromDb(row.received_amount), amount: moneyFromDb(row.amount) };
  });
}
