'use server';
import { headers } from 'next/headers';
import { AppError, runAction } from '@/shared/action';
import { correlationIdFrom } from '@/shared/api';
import { moneyFromDb } from '@/lib/supabase/money';
import { ADMIN_READ_PAGE, allById, financeReader, relatedRows, scopedFinanceNames, uuid } from '@/server/payments/admin-read';

type Status = 'submitted' | 'verified' | 'rejected' | 'pending';
type Payment = {
  id: string; payer_user_id: string | null; amount: string | number; received_amount: string | number | null;
  status: Status; slip_url: string | null; submitted_at: string | null; verified_at: string | null; created_at: string;
};
type ChargeTitle = { id: string; type: string; session_id: string | null; sessions: { title: string } | null };
type Cursor = { v: 1; rank: number; at: string; id: string };
const STATUSES: Status[] = ['submitted', 'verified', 'rejected', 'pending'];
function instantKey(value: string) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new AppError('INTERNAL_ERROR', 'เวลาคิวตรวจไม่ถูกต้อง');
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return instant.toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(6, '0').slice(0, 6)}Z`);
}
function key(p: Payment): Cursor {
  return { v: 1, rank: p.status === 'submitted' ? 0 : 1,
    at: instantKey(p.status === 'submitted' ? p.submitted_at ?? p.created_at : p.created_at), id: p.id };
}
function compare(a: Cursor, b: Cursor) {
  return a.rank - b.rank || a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}
function parseCursor(value: string): Cursor {
  try {
    if (value.length > 250) throw new Error('too long');
    const c = JSON.parse(value) as Cursor;
    if (c.v !== 1 || ![0, 1].includes(c.rank) || typeof c.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.at)) throw new Error('invalid');
    uuid(c.id);
    return c;
  } catch { throw new AppError('VALIDATION_ERROR', 'ตัวชี้หน้าคิวไม่ถูกต้อง'); }
}

/** Review queue. Opaque cursor: submitted first, then oldest submitted_at + id.
 * Counts cover the full session scope BEFORE the status tab filter (and independent of cursor).
 * All source relations page separately: no embedded-array truncation, no swallowed query errors.
 */
export async function adminPaymentList(gangId: string, options: {
  cursor?: string; pageSize?: number; filter?: { status?: Status; sessionId?: string };
} = {}) {
  return runAction(correlationIdFrom(await headers()), async () => {
    const { db } = await financeReader(gangId, 'payment.verify');
    const pageSize = options.pageSize ?? ADMIN_READ_PAGE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ADMIN_READ_PAGE) throw new AppError('VALIDATION_ERROR', 'ขนาดหน้าไม่ถูกต้อง');
    const { filter = {} } = options;
    if (filter.status && !STATUSES.includes(filter.status)) throw new AppError('VALIDATION_ERROR', 'สถานะสลิปไม่ถูกต้อง');
    if (filter.sessionId) uuid(filter.sessionId);
    const cursor = options.cursor ? parseCursor(options.cursor) : null;
    const payments = await allById<Payment>((after) => {
      let q = db.from('payments').select('id,payer_user_id,amount,received_amount,status,slip_url,submitted_at,verified_at,created_at')
        .eq('gang_id', gangId).is('deleted_at', null).order('id').limit(ADMIN_READ_PAGE);
      if (after) q = q.gt('id', after);
      return q;
    });
    const allocations = await relatedRows<{ id: string; payment_id: string; session_charge_id: string }>(
      db, 'payment_allocations', 'payment_id', payments.map((p) => p.id), 'id,payment_id,session_charge_id');
    const charges = await relatedRows<ChargeTitle>(db, 'session_charges', 'id', [...new Set(allocations.map((a) => a.session_charge_id))],
      'id,type,session_id,sessions!session_charges_session_id_fkey(title)');
    const chargeById = new Map(charges.map((c) => [c.id, c]));
    const perPayment = new Map<string, ChargeTitle[]>();
    for (const a of allocations) {
      const c = chargeById.get(a.session_charge_id);
      if (!c) throw new AppError('INTERNAL_ERROR', 'ไม่พบหนี้ของสลิป');
      const list = perPayment.get(a.payment_id) ?? [];
      list.push(c); perPayment.set(a.payment_id, list);
    }
    const scope = payments.filter((p) => !filter.sessionId || perPayment.get(p.id)?.some((c) => c.session_id === filter.sessionId));
    const counts = { submitted: 0, verified: 0, rejected: 0, pending: 0 };
    for (const p of scope) {
      if (!STATUSES.includes(p.status)) throw new AppError('INTERNAL_ERROR', 'สถานะสลิปไม่ถูกต้อง');
      counts[p.status] += 1;
    }
    const queue = scope.filter((p) => !filter.status || p.status === filter.status).map((p) => ({ p, k: key(p) }))
      .filter(({ k }) => !cursor || compare(k, cursor) > 0).sort((a, b) => compare(a.k, b.k));
    const page = queue.slice(0, pageSize);
    const names = await scopedFinanceNames(db, page.flatMap(({ p }) => p.payer_user_id ? [p.payer_user_id] : []));
    return {
      rows: page.map(({ p }) => ({
        paymentId: p.id, payerDisplayName: p.payer_user_id ? names.get(p.payer_user_id) ?? 'ไม่ทราบชื่อ' : 'ไม่ทราบผู้จ่าย',
        amount: moneyFromDb(p.amount), receivedAmount: p.received_amount === null ? null : moneyFromDb(p.received_amount),
        status: p.status, hasSlip: Boolean(p.slip_url), submittedAt: p.submitted_at, verifiedAt: p.verified_at,
        sessionTitles: [...new Set((perPayment.get(p.id) ?? []).map((c) => c.type === 'monthly_fee' ? 'ค่าสมาชิกรายเดือน' : c.sessions?.title ?? 'นัดที่ถูกลบ'))],
      })),
      nextCursor: queue.length > pageSize ? JSON.stringify(page[page.length - 1].k) : null,
      counts,
    };
  });
}
