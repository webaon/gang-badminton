import 'server-only';
import { AppError } from '@/shared/action';
import { moneyFromDb } from '@/lib/supabase/money';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { ADMIN_READ_PAGE, allById, relatedRows, type ReadClient } from './admin-read';
import type { financeRange } from './report-range';

export type PeriodAllocation = {
  id: string; payment_id: string; session_charge_id: string; amount: string; source: string;
};
export type CashSession = { sessionId: string | null; sessionTitle: string; sessionDate: string | null; amount: string };
type Charge = {
  id: string; gang_id: string; type: string; session_id: string | null;
  sessions: { title: string; starts_at: string } | null;
};

/** Internal only: caller must authorize finance.view first. RLS client, no service-role bypass.
 * Q-R1 cash cohort is payments.verified_at, never charge/session date. Both transfer and
 * credit allocations are returned; cashInBySession includes ONLY the transfer subset.
 */
export async function readPeriodCash(db: ReadClient, gangId: string, range: ReturnType<typeof financeRange>) {
  const payments = await allById<{ id: string }>((after) => {
    let q = db.from('payments').select('id').eq('gang_id', gangId)
      .eq('status', 'verified').is('deleted_at', null)
      .gte('verified_at', range.startUtc).lt('verified_at', range.endUtcExclusive)
      .order('id').limit(ADMIN_READ_PAGE);
    if (after) q = q.gt('id', after);
    return q;
  });
  const raw = await relatedRows<Omit<PeriodAllocation, 'amount'> & { amount: string | number }>(
    db, 'payment_allocations', 'payment_id', payments.map((p) => p.id),
    'id,payment_id,session_charge_id,amount,source',
  );
  const allocations: PeriodAllocation[] = raw.map((a) => ({ ...a, amount: moneyFromDb(a.amount) }));
  const charges = await relatedRows<Charge>(db, 'session_charges', 'id',
    [...new Set(allocations.map((a) => a.session_charge_id))],
    'id,gang_id,type,session_id,sessions!session_charges_session_id_fkey(title,starts_at)');
  const chargeById = new Map(charges.map((c) => [c.id, c]));
  const grouped = new Map<string, { meta: Omit<CashSession, 'amount'>; amounts: string[] }>();
  for (const a of allocations) {
    const c = chargeById.get(a.session_charge_id);
    if (!c || c.gang_id !== gangId) throw new AppError('INTERNAL_ERROR', 'ไม่พบหนี้ในก๊วนของรายการรับเงิน');
    if (a.source !== 'transfer' && a.source !== 'credit') throw new AppError('INTERNAL_ERROR', 'ประเภทการจัดสรรไม่ถูกต้อง');
    if (a.source !== 'transfer') continue;
    if (c.type === 'session' && (!c.session_id || !c.sessions)) throw new AppError('INTERNAL_ERROR', 'ไม่พบนัดของรายการรับเงิน');
    const key = c.session_id ?? 'monthly_fee';
    const group = grouped.get(key) ?? { meta: {
      sessionId: c.session_id,
      sessionTitle: c.type === 'monthly_fee' ? 'ค่าสมาชิกรายเดือน' : c.sessions!.title,
      sessionDate: c.type === 'monthly_fee' ? null : c.sessions!.starts_at,
    }, amounts: [] };
    group.amounts.push(a.amount);
    grouped.set(key, group);
  }
  const sum = (values: string[]) => fromSatang(sumSatang(values.map(toSatang)));
  const cashInBySession: CashSession[] = [...grouped.values()].map((g) => ({ ...g.meta, amount: sum(g.amounts) }));
  cashInBySession.sort((a, b) => (a.sessionDate ?? '').localeCompare(b.sessionDate ?? '') || (a.sessionId ?? '').localeCompare(b.sessionId ?? ''));
  const transferIn = sum(allocations.filter((a) => a.source === 'transfer').map((a) => a.amount));
  if (sum(cashInBySession.map((r) => r.amount)) !== transferIn) throw new AppError('INTERNAL_ERROR', 'ยอดเงินเข้าต่อนัดไม่ตรงกับเงินโอน');
  return { allocations, cashInBySession, transferIn };
}
