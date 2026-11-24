'use server';

import { headers } from 'next/headers';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { moneyFromDb } from '@/lib/supabase/money';
import { BUCKETS, tenantKeyOf } from '@/lib/storage/paths';
import { can } from '@/domain/permissions/can';
import { ledgerLineOf, summarize, type LedgerEntry } from '@/domain/billing/ledger';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { AppError, runAction } from '@/shared/action';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { ADMIN_READ_PAGE, allById, financeReader, relatedRows, scopedFinanceNames, uuid, type ReadClient } from '@/server/payments/admin-read';

const sum = (values: string[]) => fromSatang(sumSatang(values.map(toSatang)));
type PaymentJoin = { id: string; status: string; deleted_at: string | null } | null;
type Allocation = {
  id: string; payment_id: string; session_charge_id: string; amount: string | number;
  source: string; created_at: string; payments: PaymentJoin;
};
type Adjustment = {
  id: string; session_charge_id: string; type: string; amount: string | number;
  reason: string; created_at: string; payment_id: string | null;
};
type Charge = {
  id: string; gang_id: string; type: string; amount: string | number; created_at: string;
  session_id: string | null; registration_id: string | null; gang_member_id: string | null;
  billing_month: string | null;
  sessions: { title: string; starts_at: string } | null;
  session_registrations: { user_id: string | null; guest_name: string | null } | null;
  gang_members: { user_id: string } | null;
};
const CHARGE_SELECT = 'id,gang_id,type,amount,created_at,session_id,registration_id,gang_member_id,billing_month,sessions!session_charges_session_id_fkey(title,starts_at),session_registrations!session_charges_registration_id_fkey(user_id,guest_name),gang_members!session_charges_gang_member_id_fkey(user_id)';
const ALLOCATION_SELECT = 'id,payment_id,session_charge_id,amount,source,created_at,payments!payment_allocations_payment_id_fkey(id,status,deleted_at)';
const ADJUSTMENT_SELECT = 'id,session_charge_id,type,amount,reason,created_at,payment_id';
const verified = (a: Allocation) => a.payments?.status === 'verified' && a.payments.deleted_at === null;

async function chargeRelations(db: ReadClient, ids: string[]) {
  const [allocations, adjustments] = await Promise.all([
    relatedRows<Allocation>(db, 'payment_allocations', 'session_charge_id', ids, ALLOCATION_SELECT),
    relatedRows<Adjustment>(db, 'payment_adjustments', 'session_charge_id', ids, ADJUSTMENT_SELECT),
  ]);
  return { allocations, adjustments };
}
function entry(c: Charge, allocations: Allocation[], adjustments: Adjustment[]): LedgerEntry {
  return {
    chargeId: c.id, amount: moneyFromDb(c.amount),
    allocated: allocations.filter((a) => a.session_charge_id === c.id && verified(a)).map((a) => moneyFromDb(a.amount)),
    adjustments: adjustments.filter((a) => a.session_charge_id === c.id).map((a) => moneyFromDb(a.amount)),
  };
}

/** Payment metadata, signed private slip URL (5 min), and resumable review steps. No writes. */
export async function adminPaymentDetail(paymentId: string) {
  return runAction(correlationIdFrom(await headers()), async () => {
    await requireUser();
    uuid(paymentId);
    const db = await supabaseServer();
    const { data: p, error } = await db.from('payments')
      .select('id,gang_id,payer_user_id,amount,received_amount,status,slip_url,submitted_at,verified_at,verified_by,rejected_at,reject_reason,created_at,profiles!payments_payer_user_id_fkey(display_name)')
      .eq('id', paymentId).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!p) throw new AppError('NOT_FOUND', 'ไม่พบรายการจ่ายนี้');
    const { ctx } = await financeReader(p.gang_id, 'payment.verify');
    const allocations = await relatedRows<Allocation>(db, 'payment_allocations', 'payment_id', [paymentId], ALLOCATION_SELECT);
    // A credit payment's ledger has an applied entry; only overpayment means this step completed.
    const { data: overpayment, error: overError } = await db.from('credit_ledger')
      .select('id,amount,created_at').eq('payment_id', paymentId).eq('type', 'overpayment').maybeSingle();
    if (overError) throw overError;
    // Source belongs to allocations, not payments. Mixed allocations are not a transfer review.
    const sources = new Set(allocations.map((a) => a.source));
    const source = sources.size > 1 ? 'mixed' : sources.has('credit') ? 'credit' : 'transfer';
    const amount = moneyFromDb(p.amount);
    const receivedAmount = p.received_amount === null ? null : moneyFromDb(p.received_amount);
    const delta = receivedAmount === null ? null : toSatang(receivedAmount) - toSatang(amount);
    let slip: { fileName: string; kind: 'pdf' | 'image' | 'other'; url: string; expiresIn: number } | null = null;
    if (p.slip_url) {
      if (tenantKeyOf(p.slip_url) !== p.gang_id) throw new AppError('INTERNAL_ERROR', 'ตำแหน่งสลิปไม่ถูกต้อง');
      const { data: signed, error: signedError } = await db.storage.from(BUCKETS.paymentSlips).createSignedUrl(p.slip_url, 300);
      if (signedError) throw signedError;
      if (!signed) throw new AppError('INTERNAL_ERROR', 'สร้างลิงก์สลิปไม่สำเร็จ');
      const fileName = p.slip_url.split('/').pop() ?? '';
      slip = { fileName, kind: /\.pdf$/i.test(fileName) ? 'pdf' : /\.(png|jpe?g|webp|gif)$/i.test(fileName) ? 'image' : 'other', url: signed.signedUrl, expiresIn: 300 };
    }
    const ownCharges = await relatedRows<Charge>(db, 'session_charges', 'id', allocations.map((a) => a.session_charge_id), CHARGE_SELECT);
    return {
      id: p.id as string, gangId: p.gang_id as string, payerUserId: p.payer_user_id as string | null,
      payerDisplayName: (p.profiles as unknown as { display_name: string | null } | null)?.display_name ?? null,
      amount, receivedAmount, status: p.status as string, source: source as string,
      createdAt: p.created_at as string, submittedAt: p.submitted_at as string | null,
      verifiedAt: p.verified_at as string | null, rejectReason: p.reject_reason as string | null,
      comparison: delta === null ? 'unknown' as const : delta === 0 ? 'equal' as const : delta > 0 ? 'over' as const : 'under' as const,
      overpaymentAmount: fromSatang(Math.max(0, delta ?? 0)),
      overpayment: overpayment ? { id: overpayment.id as string, amount: moneyFromDb(overpayment.amount), createdAt: overpayment.created_at as string } : null,
      slip,
      allocations: allocations.map((a) => {
        const c = ownCharges.find((row) => row.id === a.session_charge_id);
        return { id: a.id, chargeId: a.session_charge_id, amount: moneyFromDb(a.amount), source: a.source,
          charge: c ? { id: c.id, amount: moneyFromDb(c.amount), sessionId: c.session_id, type: c.type, userId: c.session_registrations?.user_id ?? c.gang_members?.user_id ?? null, guestName: c.session_registrations?.guest_name ?? null } : null };
      }),
      permissions: {
        setReceivedAmount: can(ctx, 'payment.verify') && source === 'transfer' && ['submitted', 'verified'].includes(p.status) && !overpayment,
        verify: can(ctx, 'payment.verify') && p.status === 'submitted',
        reject: can(ctx, 'payment.verify') && p.status === 'submitted',
        recordOverpayment: can(ctx, 'credit.overpayment.record') && source === 'transfer' && p.status === 'verified' && (delta ?? 0) > 0 && !overpayment && p.payer_user_id !== null,
      },
    };
  });
}

/** Calendar days in Bangkok, not elapsed 24-hour intervals or server-local midnight. */
function thaiDay(value: string): number {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (name: string) => Number(date.find((p) => p.type === name)?.value);
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000);
}
export type Aging = '0-7' | '8-30' | '>30';
export type LedgerFilter = { sessionId?: string; aging?: Aging; status?: 'outstanding' | 'settled' | 'credit' };
export type AdminLedgerRow = {
  id: string; sessionId: string | null; sessionTitle: string | null; type: string; date: string;
  userId: string | null; guestName: string | null; displayName: string; debtorKey: string;
  amount: string; paid: string; transferPaid: string; creditPaid: string; adjusted: string;
  outstanding: string; daysOutstanding: number; aging: Aging; status: 'outstanding' | 'settled' | 'credit';
};

/** Cursor limits rows only. Summary always covers the entire filtered scope, not just this page. */
export async function adminLedger(gangId: string, options: { cursor?: string; pageSize?: number; filter?: LedgerFilter } = {}): Promise<ApiResponse<{
  rows: AdminLedgerRow[]; nextCursor: string | null;
  summary: { charged: string; paid: string; transferPaid: string; creditPaid: string; adjusted: string; outstanding: string; credit: string; debtors: number; aging: Record<Aging, { outstanding: string; debtors: number }> };
}>> {
  return runAction(correlationIdFrom(await headers()), async () => {
    const { db } = await financeReader(gangId);
    const { filter = {}, cursor } = options;
    if (cursor) uuid(cursor);
    if (filter.sessionId) uuid(filter.sessionId);
    if (filter.aging && !['0-7', '8-30', '>30'].includes(filter.aging)) throw new AppError('VALIDATION_ERROR', 'ช่วงอายุหนี้ไม่ถูกต้อง');
    if (filter.status && !['outstanding', 'settled', 'credit'].includes(filter.status)) throw new AppError('VALIDATION_ERROR', 'สถานะหนี้ไม่ถูกต้อง');
    const pageSize = options.pageSize ?? ADMIN_READ_PAGE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ADMIN_READ_PAGE) throw new AppError('VALIDATION_ERROR', 'ขนาดหน้าไม่ถูกต้อง');
    const charges = await allById<Charge>((after) => {
      let q = db.from('session_charges').select(CHARGE_SELECT).eq('gang_id', gangId).order('id').limit(ADMIN_READ_PAGE);
      if (after) q = q.gt('id', after);
      if (filter.sessionId) q = q.eq('session_id', filter.sessionId);
      return q;
    });
    const { allocations, adjustments } = await chargeRelations(db, charges.map((c) => c.id));
    const names = await scopedFinanceNames(db, charges.flatMap((c) => {
      const id = c.session_registrations?.user_id ?? c.gang_members?.user_id;
      return id ? [id] : [];
    }));
    const today = thaiDay(new Date().toISOString());
    const rows: AdminLedgerRow[] = charges.map((c) => {
      const line = ledgerLineOf(entry(c, allocations, adjustments));
      const date = c.type === 'session' ? c.sessions?.starts_at : c.created_at;
      if (!date) throw new AppError('INTERNAL_ERROR', 'ไม่พบวันเริ่มค้างของนัด');
      const days = Math.max(0, today - thaiDay(date));
      const userId = c.session_registrations?.user_id ?? c.gang_members?.user_id ?? null;
      const paid = allocations.filter((a) => a.session_charge_id === c.id && verified(a));
      return {
        id: c.id, type: c.type, sessionId: c.session_id, sessionTitle: c.sessions?.title ?? null,
        date, userId, guestName: c.session_registrations?.guest_name ?? null,
        displayName: userId ? names.get(userId) ?? 'ไม่ทราบชื่อ' : c.session_registrations?.guest_name ?? 'ไม่ทราบชื่อ',
        debtorKey: userId ? `user:${userId}` : `guest:${c.registration_id ?? c.id}`,
        amount: line.charge, paid: line.allocated, adjusted: line.adjusted, outstanding: line.outstanding,
        transferPaid: sum(paid.filter((a) => a.source === 'transfer').map((a) => moneyFromDb(a.amount))),
        creditPaid: sum(paid.filter((a) => a.source === 'credit').map((a) => moneyFromDb(a.amount))),
        daysOutstanding: days, aging: days <= 7 ? '0-7' : days <= 30 ? '8-30' : '>30',
        status: toSatang(line.outstanding) > 0 ? 'outstanding' : toSatang(line.outstanding) < 0 ? 'credit' : 'settled',
      };
    });
    const scope = rows.filter((r) => (!filter.aging || r.aging === filter.aging) && (!filter.status || r.status === filter.status));
    const scopeIds = new Set(scope.map((r) => r.id));
    const totals = summarize(charges.filter((c) => scopeIds.has(c.id)).map((c) => entry(c, allocations, adjustments)));
    const debtors = (rs: AdminLedgerRow[]) => new Set(rs.filter((r) => r.status === 'outstanding').map((r) => r.debtorKey)).size;
    const aging = Object.fromEntries((['0-7', '8-30', '>30'] as const).map((bucket) => {
      const group = scope.filter((r) => r.aging === bucket && r.status === 'outstanding');
      return [bucket, { outstanding: sum(group.map((r) => r.outstanding)), debtors: debtors(group) }];
    })) as Record<Aging, { outstanding: string; debtors: number }>;
    const remaining = scope.filter((r) => !cursor || r.id > cursor);
    const page = remaining.slice(0, pageSize);
    return {
      rows: page, nextCursor: remaining.length > pageSize ? page[page.length - 1].id : null,
      summary: { charged: totals.charged, paid: totals.allocated, adjusted: totals.adjusted, outstanding: totals.outstanding, credit: totals.credit,
        transferPaid: sum(scope.map((r) => r.transferPaid)), creditPaid: sum(scope.map((r) => r.creditPaid)), debtors: debtors(scope), aging },
    };
  });
}

/** Complete charge-level ledger, including the independently retryable debt-reduction/credit-return steps. */
export async function chargeHistory(chargeId: string) {
  return runAction(correlationIdFrom(await headers()), async () => {
    await requireUser();
    uuid(chargeId);
    const db = await supabaseServer();
    const { data, error } = await db.from('session_charges').select(CHARGE_SELECT).eq('id', chargeId).maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError('NOT_FOUND', 'ไม่พบรายการหนี้');
    const c = data as unknown as Charge;
    const { ctx } = await financeReader(c.gang_id);
    const { allocations, adjustments } = await chargeRelations(db, [chargeId]);
    const line = ledgerLineOf(entry(c, allocations, adjustments));
    const reduced = adjustments.some((a) => a.type === 'credit' && toSatang(moneyFromDb(a.amount)) < 0);
    const returned = sum(adjustments.filter((a) => a.type === 'credit_return').map((a) => moneyFromDb(a.amount)));
    const pending = toSatang(line.outstanding) < 0;
    return {
      chargeId, gangId: c.gang_id, amount: line.charge, paid: line.allocated, adjusted: line.adjusted, outstanding: line.outstanding,
      allocations: allocations.map((a) => ({ id: a.id, paymentId: a.payment_id, amount: moneyFromDb(a.amount), source: a.source, status: a.payments?.status ?? null, deleted: a.payments?.deleted_at !== null, createdAt: a.created_at })),
      adjustments: adjustments.map((a) => ({ id: a.id, type: a.type, amount: moneyFromDb(a.amount), reason: a.reason, paymentId: a.payment_id, createdAt: a.created_at })),
      creditReturn: {
        debtReduced: reduced, returnedAmount: returned,
        state: pending ? 'pending_credit_return' as const : toSatang(returned) > 0 ? 'returned' as const : reduced ? 'debt_reduced' as const : 'none' as const,
        // Eligibility hint only. DB determines the cap and may reject — no client-side money ceiling.
        canReturn: pending && can(ctx, 'credit.return_charge') && (c.session_registrations?.user_id ?? c.gang_members?.user_id) != null,
      },
    };
  });
}
