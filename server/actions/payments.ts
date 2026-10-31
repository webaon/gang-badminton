'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { summarize, validateAdjustment, type AdjustmentType, type LedgerEntry } from '@/domain/billing/ledger';
import { breakdownCharges } from '@/domain/billing/charge-breakdown';
import type { BillingResult, BillingSnapshot } from '@/domain/billing/session-billing';
import { fromJson as cancellationFromJson } from '@/domain/policies/cancellation';
import { courtPlusShuttleFromJson, flatRateFromJson, roundingFromJson } from '@/domain/policies/pricing';
import { assertUsableSnapshot } from '@/domain/sessions/snapshot';
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


// =============================================================================
// WO-R3 — loader ฝั่งสมาชิก (อ่านอย่างเดียว) สำหรับหน้า "ยอดของฉัน" / หน้าจ่ายรายนัด
// =============================================================================
//
// 🔴 กติการ่วมของสามตัวนี้
//   · user มาจาก session เท่านั้น — ❌ ไม่มี parameter userId จาก client
//   · `assertCan(payment.submit.self)` ด้วย role ของก๊วนนั้น (คนนอกก๊วน = FORBIDDEN)
//   · ❌ ไม่มีสูตรเงินใหม่: ยอด = `summarize()` ของ ledger เดิม · แยกค่าคอร์ท/ลูก/ค่าปรับ/เศษ = `breakdownCharges()` เดิม
//   · ⚠️ RLS ของ `session_charges` ให้ **แอดมินเห็นทั้งก๊วน** ⇒ ทุก query ที่อ่านด้วย RLS ต้องมี filter "เจ้าของคือฉัน"
//     เองเสมอ ไม่งั้นแอดมินที่เรียก action นี้จะได้ยอดของทั้งก๊วนมาเป็น "ยอดของฉัน"
//   · service-role ใช้ใน 2 จุดเท่านั้น (อธิบายที่จุดใช้งาน): allocations ของ charge ฉัน · charge ทั้งนัดเพื่อแยกยอด

const READ_PAGE = 500;
const IN_CHUNK = 50;

/** อ่านทุกหน้า — PostgREST ตัดที่ max_rows (1000) เงียบๆ (บทเรียน WO-B13) ⇒ ห้ามอ่านครั้งเดียวแล้วเชื่อว่าครบ */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await page(from, from + READ_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < READ_PAGE) return out;
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** payment ของ "ฉัน" ที่ผูกกับ charge — ไม่คืนข้อมูลคนจ่ายแทน */
export type MyPaymentRef = {
  id: string;
  status: string;
  amount: string;
  createdAt: string;
};

export type MyBalanceItem = {
  kind: 'session' | 'monthly_fee';
  /** `session` เท่านั้น */
  sessionId: string | null;
  sessionTitle: string | null;
  /** วันที่เริ่มนัด (kind=session) · `billingMonth` (kind=monthly_fee: `YYYY-MM-DD` วันแรกของเดือน) */
  date: string | null;
  chargeIds: string[];
  /** ยอดตั้งต้น (`session_charges.amount`) */
  amount: string;
  /** จ่ายแล้ว = allocations ของสลิปที่ verified เท่านั้น (รวมที่เพื่อนจ่ายแทน) */
  paid: string;
  /** ผลรวมรายการปรับยอด (บวก = เพิ่มหนี้ · ลบ = ลดหนี้ — refund/credit) */
  adjusted: string;
  /** ยังค้าง (>0 เท่านั้น) — ledger เดิม: ไม่หักกลบกับ credit */
  outstanding: string;
  /** ก๊วนต้องคืน/เครดิต (ติดลบหรือ 0) */
  credit: string;
  /** payment ล่าสุด **ที่ฉันเป็นผู้จ่าย** และผูกกับนัดนี้ผ่าน payment_allocations */
  latestPayment: MyPaymentRef | null;
};

export type MyBalance = {
  gangId: string;
  /** ใหม่→เก่า */
  items: MyBalanceItem[];
  totals: { charged: string; paid: string; adjusted: string; outstanding: string; credit: string };
};

type ChargeBaseRow = {
  id: string;
  gang_id: string;
  type: 'session' | 'monthly_fee';
  session_id: string | null;
  billing_month: string | null;
  amount: string | number;
  created_at: string;
};
type SessionLite = { id: string; title: string; starts_at: string } | null;
type AllocRow = {
  session_charge_id: string;
  amount: string | number;
  payments: {
    id: string;
    gang_id: string;
    payer_user_id: string | null;
    amount: string | number;
    status: string;
    created_at: string;
    deleted_at: string | null;
  } | null;
};

/** สมาชิกของก๊วน + มีสิทธิ์จ่ายของตัวเอง */
async function assertSelfPayer(gangId: string, userId: string): Promise<void> {
  assertCan({ role: await roleInGang(gangId, userId) }, 'payment.submit.self');
}

/**
 * allocations ของ charge ฉัน (ทุก payment ไม่ว่าใครจ่าย)
 *
 * 🔴 ใช้ service-role เพราะ RLS ของ `payment_allocations` เปิดให้เห็นเฉพาะ payment ที่ "ฉันเป็นผู้จ่าย" หรือแอดมิน
 *    (`is_payment_visible`) ⇒ เพื่อนจ่ายแทน charge ของฉันแล้ว ฉันจะมองไม่เห็น allocation นั้น ยอดค้างจะผิด (เหมือนยังไม่จ่าย)
 *    ขอบเขต: query ด้วย `session_charge_id IN (charge ของฉัน)` เท่านั้น และไม่คืนตัวตนของคนจ่ายแทนออกไป
 */
async function allocationsOfMyCharges(chargeIds: readonly string[], onlyPayer?: string): Promise<AllocRow[]> {
  // ใบที่ตัวเองเป็นผู้จ่ายอ่านผ่าน RLS ได้ — ไม่ต้องใช้ service-role (myPaymentForSession)
  const admin = onlyPayer ? await supabaseServer() : supabaseAdmin();
  const out: AllocRow[] = [];

  for (const ids of chunk(chargeIds, IN_CHUNK)) {
    out.push(
      ...(await readAll<AllocRow>((from, to) =>
        admin
          .from('payment_allocations')
          .select(
            'session_charge_id, amount, payments(id, gang_id, payer_user_id, amount, status, created_at, deleted_at)',
          )
          .in('session_charge_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      )),
    );
  }
  return out;
}

/** รายการปรับยอดของ charge ฉัน — RLS พอ (เจ้าของหนี้เห็นของตัวเอง) แต่ filter ด้วย id ซ้ำเพราะแอดมินเห็นทั้งก๊วน */
async function adjustmentsOfMyCharges(
  chargeIds: readonly string[],
): Promise<{ session_charge_id: string; amount: string | number }[]> {
  const supabase = await supabaseServer();
  const out: { session_charge_id: string; amount: string | number }[] = [];

  for (const ids of chunk(chargeIds, IN_CHUNK)) {
    out.push(
      ...(await readAll<{ session_charge_id: string; amount: string | number }>((from, to) =>
        supabase
          .from('payment_adjustments')
          .select('session_charge_id, amount')
          .in('session_charge_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      )),
    );
  }
  return out;
}

function latestOwnPayment(allocs: readonly AllocRow[], userId: string): MyPaymentRef | null {
  let best: AllocRow['payments'] = null;

  for (const a of allocs) {
    const p = a.payments;
    if (!p || p.deleted_at || p.payer_user_id !== userId) continue;
    if (!best || p.created_at > best.created_at || (p.created_at === best.created_at && p.id > best.id)) {
      best = p;
    }
  }

  return best
    ? { id: best.id, status: best.status, amount: moneyFromDb(best.amount), createdAt: best.created_at }
    : null;
}

/**
 * ยอดค้าง/ประวัติของฉันข้ามนัด — hi-fi 29 "ยอดของฉัน"
 *
 * 🔴 ยอดทุกตัวมาจาก `summarize()` ของ ledger เดิม (charge − allocations(verified) + adjustments)
 *    ❌ ไม่อ่านจาก `payments.status` และไม่มีสูตรใหม่ · `outstanding` กับ `credit` แยกกัน ไม่หักกลบ
 */
export async function myBalance(gangId: string): Promise<ApiResponse<MyBalance>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    await assertSelfPayer(gangId, user.id);

    const supabase = await supabaseServer();

    // charge ของ "ฉัน" — filter เองเสมอ (RLS ให้แอดมินเห็นทั้งก๊วน)
    const sessionCharges = await readAll<ChargeBaseRow & { sessions: SessionLite }>((from, to) =>
      supabase
        .from('session_charges')
        .select(
          'id, gang_id, type, session_id, billing_month, amount, created_at, sessions(id, title, starts_at), session_registrations!inner(user_id)',
        )
        .eq('gang_id', gangId)
        .eq('type', 'session')
        .eq('session_registrations.user_id', user.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    );

    const monthlyCharges = await readAll<ChargeBaseRow & { sessions: null }>((from, to) =>
      supabase
        .from('session_charges')
        .select(
          'id, gang_id, type, session_id, billing_month, amount, created_at, gang_members!inner(user_id)',
        )
        .eq('gang_id', gangId)
        .eq('type', 'monthly_fee')
        .eq('gang_members.user_id', user.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
    );

    const all = [...sessionCharges, ...monthlyCharges];
    const chargeIds = all.map((c) => c.id);

    const [allocs, adjustments] = await Promise.all([
      allocationsOfMyCharges(chargeIds),
      adjustmentsOfMyCharges(chargeIds),
    ]);

    const entryOf = (c: ChargeBaseRow): LedgerEntry => ({
      chargeId: c.id,
      amount: moneyFromDb(c.amount),
      allocated: allocs
        .filter((a) => a.session_charge_id === c.id && a.payments?.status === 'verified')
        .map((a) => moneyFromDb(a.amount)),
      adjustments: adjustments.filter((a) => a.session_charge_id === c.id).map((a) => moneyFromDb(a.amount)),
    });

    // รวม charge ของนัดเดียวกันเป็นแถวเดียว · ค่าสมาชิกรายเดือนแยกแถวต่อเดือน
    type Row = ChargeBaseRow & { sessions: SessionLite };
    const groups = new Map<string, { kind: MyBalanceItem['kind']; rows: Row[] }>();
    for (const c of all as Row[]) {
      const key = c.type === 'session' ? `s:${c.session_id}` : `m:${c.billing_month}`;
      const group = groups.get(key) ?? { kind: c.type, rows: [] };
      group.rows.push(c);
      groups.set(key, group);
    }

    const items: MyBalanceItem[] = [...groups.values()].map((g) => {
      const first = g.rows[0];
      const ids = new Set(g.rows.map((r) => r.id));
      const s = summarize(g.rows.map(entryOf));

      return {
        kind: g.kind,
        sessionId: g.kind === 'session' ? first.session_id : null,
        sessionTitle: g.kind === 'session' ? (first.sessions?.title ?? null) : null,
        date: g.kind === 'session' ? (first.sessions?.starts_at ?? first.created_at) : first.billing_month,
        chargeIds: g.rows.map((r) => r.id),
        amount: s.charged,
        paid: s.allocated,
        adjusted: s.adjusted,
        outstanding: s.outstanding,
        credit: s.credit,
        latestPayment: latestOwnPayment(
          allocs.filter((a) => ids.has(a.session_charge_id)),
          user.id,
        ),
      };
    });

    items.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

    const total = summarize(all.map(entryOf));

    return {
      gangId,
      items,
      totals: {
        charged: total.charged,
        paid: total.allocated,
        adjusted: total.adjusted,
        outstanding: total.outstanding,
        credit: total.credit,
      },
    };
  });
}

export type MyChargeBreakdownRow = {
  chargeId: string;
  /** เหตุผลที่ถูกเก็บ (`attended` / `no_check_in` / `no_show` / `late_cancel` …) — ใช้ map เป็นข้อความฝั่ง UI */
  reason: string;
  isMonthlyMember: boolean;
  court: string;
  shuttle: string;
  penalty: string;
  rounding: string;
  /** court + shuttle + penalty + rounding = amount เสมอ */
  amount: string;
};

export type MyChargeBreakdown = {
  sessionId: string;
  pricingType: string;
  rows: MyChargeBreakdownRow[];
  total: { court: string; shuttle: string; penalty: string; rounding: string; amount: string };
};

/** แปลง snapshot ของนัด → input ของ `breakdownCharges()` (mapping เดียวกับ `loadBillingContext` ใน billing.ts — ไม่มีสูตร) */
function billingSnapshotOf(raw: unknown): BillingSnapshot {
  assertUsableSnapshot(raw);
  const s = raw as {
    pricing_plan: { type: string; params: unknown; monthly_member_pays_shuttle?: boolean };
    rounding_policy?: unknown;
    cancellation_policy: unknown;
  };

  return {
    pricingType: s.pricing_plan.type,
    amountPerPerson: flatRateFromJson(s.pricing_plan.params).amountPerPerson,
    courtPlusShuttle: courtPlusShuttleFromJson(s.pricing_plan.params),
    roundingPolicy: roundingFromJson(s.rounding_policy),
    monthlyMemberPaysShuttle: s.pricing_plan.monthly_member_pays_shuttle ?? true,
    cancellationPolicy: cancellationFromJson(s.cancellation_policy),
  };
}

/**
 * แยกยอดของฉันในนัดนี้ เป็น ค่าคอร์ท / ค่าลูก / ค่าปรับ / ปัดเศษ — hi-fi 29/30
 *
 * 🔴 ไม่มีสูตรใหม่ — ใช้ `breakdownCharges()` ตัวเดียวกับหน้าปิดรอบ (WO-B12) กับ charge ที่ปิดรอบเขียนไว้แล้ว
 *    · ตัวเลขจึงตรงกับที่แอดมินเห็นตอนปิดรอบ
 *    · `breakdownCharges()` ตรวจกลับกับยอดจริงทุกแถว — **ไม่ reconcile ⇒ คืน `null` ไม่ส่งตัวเลขใดๆ** (ดีกว่าหน้าจอโกหกเรื่องเงิน)
 *    · คืน `null` เช่นกันเมื่อฉันไม่มี charge ในนัดนี้ (ยังไม่ปิดรอบ / ไม่ได้ถูกเก็บเงิน)
 *
 * 🔴 service-role: ต้องอ่าน charge **ทั้งนัด** เพื่อรู้จำนวนคน/ลำดับที่หารค่าสนาม (เศษสตางค์แจกตามลำดับ)
 *    ใช้คำนวณภายในเท่านั้น — คืนเฉพาะแถวของ "ฉัน" ออกไป ไม่มีชื่อ/ยอดคนอื่นในผลลัพธ์
 */
export async function myChargeBreakdown(
  sessionId: string,
): Promise<ApiResponse<MyChargeBreakdown | null>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: session } = await supabase
      .from('sessions')
      .select('id, gang_id, snapshot')
      .eq('id', sessionId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!session) throw new AppError('NOT_FOUND', 'ไม่พบนัดนี้');
    await assertSelfPayer(session.gang_id, user.id);

    const mine = await readAll<{ id: string; registration_id: string }>((from, to) =>
      supabase
        .from('session_charges')
        .select('id, registration_id, session_registrations!inner(user_id)')
        .eq('session_id', sessionId)
        .eq('type', 'session')
        .eq('session_registrations.user_id', user.id)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (mine.length === 0) return null;

    // charge ทั้งนัด ตามลำดับที่ปิดรอบ insert (uuid v7 เรียงตามเวลา = ลำดับเดียวกับที่เอนจินแจกเศษ)
    const everyone = await readAll<{
      id: string;
      registration_id: string;
      amount: string | number;
      breakdown: Record<string, string | number | boolean>;
    }>((from, to) =>
      supabaseAdmin()
        .from('session_charges')
        .select('id, registration_id, amount, breakdown')
        .eq('session_id', sessionId)
        .eq('type', 'session')
        .order('id', { ascending: true })
        .range(from, to),
    );

    let split: ReturnType<typeof breakdownCharges>;
    let pricingType: string;
    try {
      const snapshot = billingSnapshotOf(session.snapshot);
      pricingType = snapshot.pricingType;

      const charges = everyone.map((c) => ({
        registrationId: c.registration_id,
        amount: moneyFromDb(c.amount),
        breakdown: c.breakdown,
      }));
      const result: BillingResult = {
        charges,
        totalCollected: fromSatang(sumSatang(charges.map((c) => toSatang(c.amount)))),
        roundingSurplus: '0.00', // ไม่ถูกใช้ในการแยกยอด
      };

      // จำนวนลูกที่ใช้ — engine เขียนไว้ใน breakdown ของทุก charge ของ court_plus_shuttle
      const shuttles = charges.map((c) => c.breakdown.shuttles_used_total).find((v) => v !== undefined);

      split = breakdownCharges({
        result,
        snapshot,
        ...(snapshot.pricingType === 'court_plus_shuttle' ? { shuttlesUsedTotal: String(shuttles ?? '') } : {}),
      });
    } catch (error) {
      // ไม่ reconcile / ข้อมูลไม่ครบ ⇒ ไม่ส่งตัวเลข (log เฉพาะข้อความสั้นของ domain ไม่มีข้อมูลบุคคล)
      console.warn('[payments] แยกยอดไม่ reconcile — ไม่ส่งตัวเลข', {
        correlationId,
        sessionId,
        message: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
      return null;
    }

    const rows: MyChargeBreakdownRow[] = [];
    for (const c of mine) {
      const parts = split.parts.get(c.registration_id);
      const stored = everyone.find((e) => e.id === c.id);
      if (!parts || !stored) return null;

      rows.push({
        chargeId: c.id,
        reason: String(stored.breakdown.reason ?? ''),
        isMonthlyMember: stored.breakdown.is_monthly_member === true,
        court: parts.court,
        shuttle: parts.shuttle,
        penalty: parts.penalty,
        rounding: parts.rounding,
        amount: parts.amount,
      });
    }

    const sum = (pick: (r: MyChargeBreakdownRow) => string) =>
      fromSatang(sumSatang(rows.map((r) => toSatang(pick(r)))));

    return {
      sessionId,
      pricingType,
      rows,
      total: {
        court: sum((r) => r.court),
        shuttle: sum((r) => r.shuttle),
        penalty: sum((r) => r.penalty),
        rounding: sum((r) => r.rounding),
        amount: sum((r) => r.amount),
      },
    };
  });
}

export type MyPaymentForSession = {
  id: string;
  gangId: string;
  /** ยอดทั้งใบที่ต้องโอน (ใบเดียวอาจครอบหลายนัด) — ใช้สร้าง QR */
  amount: string;
  /** ส่วนของใบนี้ที่ตกกับ charge ของฉันในนัดนี้ */
  amountForSession: string;
  status: string;
  hasSlip: boolean;
  rejectReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  verifiedAt: string | null;
  /** charge ของฉันในนัดนี้ที่ใบนี้ครอบอยู่ */
  chargeIds: string[];
};

/**
 * payment ของ "ฉัน" ที่ผูกกับนัดนี้ผ่าน `payment_allocations` — แก้บั๊ก pay/page.tsx ที่เลือก payment ล่าสุดของก๊วน
 *
 * 🔴 ผูกด้วย allocation → charge → นัด เท่านั้น (ไม่ใช่ `gang_id` + `limit 1`) ⇒ สองนัดค้างได้ใบของตัวเองคนละใบ
 * 🔴 คืนเฉพาะ payment ที่ **ฉันเป็นผู้จ่าย** (`payer_user_id = ฉัน`) — ใบที่เพื่อนจ่ายแทนฉันไม่ถูกคืน
 *    (ยอดที่เพื่อนจ่ายแทนนับอยู่ใน `myBalance().paid` แล้ว)
 * คืน `null` = ยังไม่มีใบจ่ายของนัดนี้ (ให้ UI เสนอ "ขอ QR")
 */
export async function myPaymentForSession(
  sessionId: string,
): Promise<ApiResponse<MyPaymentForSession | null>> {
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
    await assertSelfPayer(session.gang_id, user.id);

    const mine = await readAll<{ id: string }>((from, to) =>
      supabase
        .from('session_charges')
        .select('id, session_registrations!inner(user_id)')
        .eq('session_id', sessionId)
        .eq('type', 'session')
        .eq('session_registrations.user_id', user.id)
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (mine.length === 0) return null;

    const allocs = (await allocationsOfMyCharges(mine.map((c) => c.id), user.id)).filter(
      (a) => a.payments && !a.payments.deleted_at && a.payments.payer_user_id === user.id,
    );
    const latest = latestOwnPayment(allocs, user.id);
    if (!latest) return null;

    const forThis = allocs.filter((a) => a.payments?.id === latest.id);

    // ฟิลด์ที่ไม่ได้อยู่ใน allocation join — อ่านจาก payments ของตัวเอง (RLS: payer = ฉัน)
    const { data: payment } = await supabase
      .from('payments')
      .select('id, gang_id, amount, status, slip_url, reject_reason, created_at, submitted_at, verified_at')
      .eq('id', latest.id)
      .eq('payer_user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();

    if (!payment) return null;

    return {
      id: payment.id,
      gangId: payment.gang_id,
      amount: moneyFromDb(payment.amount),
      amountForSession: fromSatang(sumSatang(forThis.map((a) => toSatang(moneyFromDb(a.amount))))),
      status: payment.status,
      hasSlip: payment.slip_url !== null && payment.slip_url !== '',
      rejectReason: payment.reject_reason,
      createdAt: payment.created_at,
      submittedAt: payment.submitted_at,
      verifiedAt: payment.verified_at,
      chargeIds: forThis.map((a) => a.session_charge_id),
    };
  });
}
