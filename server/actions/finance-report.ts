'use server';
import { headers } from 'next/headers';
import { AppError, runAction } from '@/shared/action';
import { correlationIdFrom } from '@/shared/api';
import { moneyFromDb } from '@/lib/supabase/money';
import { calculateFinanceReport, assertReportReconciles, type ReportCharge } from '@/domain/reports/finance';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { ADMIN_READ_PAGE, allById, financeReader, relatedRows } from '@/server/payments/admin-read';
import { financeRange, type FinanceDateRange } from '@/server/payments/report-range';
import { readPeriodCash } from '@/server/payments/report-cash';

type Charge = {
  id: string; type: string; amount: string | number; created_at: string;
  breakdown: { rounding_surplus?: string | number };
  sessions: { starts_at: string } | null;
};
type Allocation = {
  id: string; session_charge_id: string; amount: string | number; source: string;
  payments: { status: string; deleted_at: string | null } | null;
};
type Adjustment = { id: string; session_charge_id: string; amount: string | number; type: string };
type Entry = { id: string; amount: string | number; category: string; note: string | null; occurred_on: string; session_id: string | null };
type Credit = { id: string; type: string; amount: string | number };
function grouped<T>(rows: T[], id: (row: T) => string) {
  const map = new Map<string, T[]>();
  for (const row of rows) { const key = id(row); const list = map.get(key) ?? []; list.push(row); map.set(key, list); }
  return map;
}
const sum = (values: string[]) => fromSatang(sumSatang(values.map(toSatang)));

/** WO-6.5a / owner Q-R1:
 * Accrual cohort = sessions.starts_at (Bangkok); monthly fees = charge.created_at.
 * charged/rounding/actualCost/outstanding/credit use the cohort's COMPLETE verified
 * allocations (all sources, excluding deleted payments) + all adjustments AS OF NOW,
 * not an historical end-of-range balance. outstandingAsOf makes this explicit.
 * Cash is a SEPARATE domain pass: payments.verified_at in [from 00:00, to+1 00:00)
 * Bangkok, creditAllocated a subset of all allocations. Refund cash uses adjustment
 * created_at; overpayment/cash_payout use credit_ledger.created_at; income/expense use
 * occurred_on. cashInBySession is TRANSFER BEFORE refunds; overpayment is separate.
 * Never feed period-only allocations to the cohort balance or debt will be overstated.
 */
export async function financeReport(gangId: string, dates: FinanceDateRange) {
  return runAction(correlationIdFrom(await headers()), async () => {
    const { db } = await financeReader(gangId);
    const range = financeRange(dates);
    const outstandingAsOf = new Date().toISOString();
    const inside = (value: string) => {
      const instant = new Date(value).getTime();
      if (!Number.isFinite(instant)) throw new AppError('INTERNAL_ERROR', 'วันของรายการไม่ถูกต้อง');
      return instant >= new Date(range.startUtc).getTime() && instant < new Date(range.endUtcExclusive).getTime();
    };
    const [allCharges, periodCash, refunds, credit, incomes, expenses] = await Promise.all([
      allById<Charge>((after) => {
        let q = db.from('session_charges').select('id,type,amount,created_at,breakdown,sessions!session_charges_session_id_fkey(starts_at)')
          .eq('gang_id', gangId).order('id').limit(ADMIN_READ_PAGE);
        if (after) q = q.gt('id', after);
        return q;
      }),
      readPeriodCash(db, gangId, range),
      allById<Adjustment>((after) => {
        let q = db.from('payment_adjustments').select('id,session_charge_id,amount,type,session_charges!inner(gang_id)')
          .eq('session_charges.gang_id', gangId).eq('type', 'refund')
          .gte('created_at', range.startUtc).lt('created_at', range.endUtcExclusive).order('id').limit(ADMIN_READ_PAGE);
        if (after) q = q.gt('id', after);
        return q;
      }),
      allById<Credit>((after) => {
        let q = db.from('credit_ledger').select('id,type,amount').eq('gang_id', gangId).in('type', ['overpayment', 'cash_payout'])
          .gte('created_at', range.startUtc).lt('created_at', range.endUtcExclusive).order('id').limit(ADMIN_READ_PAGE);
        if (after) q = q.gt('id', after);
        return q;
      }),
      ...(['gang_incomes', 'gang_expenses'] as const).map((table) => allById<Entry>((after) => {
        let q = db.from(table).select('id,amount,category,note,occurred_on,session_id').eq('gang_id', gangId)
          .gte('occurred_on', range.from).lte('occurred_on', range.to).order('id').limit(ADMIN_READ_PAGE);
        if (after) q = q.gt('id', after);
        return q;
      })),
    ]);
    const cohort = allCharges.filter((c) => {
      const date = c.type === 'monthly_fee' ? c.created_at : c.sessions?.starts_at;
      if (!date) throw new AppError('INTERNAL_ERROR', 'ไม่พบวันของนัดสำหรับรายงาน');
      return inside(date);
    });
    const [allocations, adjustments] = await Promise.all([
      relatedRows<Allocation>(db, 'payment_allocations', 'session_charge_id', cohort.map((c) => c.id),
        'id,session_charge_id,amount,source,payments!payment_allocations_payment_id_fkey(status,deleted_at)'),
      relatedRows<Adjustment>(db, 'payment_adjustments', 'session_charge_id', cohort.map((c) => c.id), 'id,session_charge_id,amount,type'),
    ]);
    const allocated = grouped(allocations.filter((a) => a.payments?.status === 'verified' && a.payments.deleted_at === null), (a) => a.session_charge_id);
    const adjusted = grouped(adjustments, (a) => a.session_charge_id);
    const cohortInput: ReportCharge[] = cohort.map((c) => ({
      chargeId: c.id, amount: moneyFromDb(c.amount),
      allocated: (allocated.get(c.id) ?? []).map((a) => moneyFromDb(a.amount)),
      creditAllocated: (allocated.get(c.id) ?? []).filter((a) => a.source === 'credit').map((a) => moneyFromDb(a.amount)),
      adjustments: (adjusted.get(c.id) ?? []).map((a) => moneyFromDb(a.amount)),
      refunds: [], roundingSurplus: moneyFromDb(c.breakdown?.rounding_surplus ?? '0.00'),
    }));
    const cohortReport = calculateFinanceReport({ charges: cohortInput, otherIncomes: [], expenses: [] });
    const cashAllocations = grouped(periodCash.allocations, (a) => a.session_charge_id);
    const cashRefunds = grouped(refunds, (a) => a.session_charge_id);
    const cashIds = new Set([...cashAllocations.keys(), ...cashRefunds.keys()]);
    const byId = new Map(allCharges.map((c) => [c.id, c]));
    const cashInput: ReportCharge[] = [...cashIds].map((id) => {
      const c = byId.get(id);
      if (!c) throw new AppError('INTERNAL_ERROR', 'ไม่พบหนี้ของรายการเงินสด');
      const paid = cashAllocations.get(id) ?? [];
      return { chargeId: id, amount: moneyFromDb(c.amount), allocated: paid.map((a) => a.amount),
        creditAllocated: paid.filter((a) => a.source === 'credit').map((a) => a.amount),
        adjustments: [], refunds: (cashRefunds.get(id) ?? []).map((a) => moneyFromDb(a.amount)), roundingSurplus: '0.00' };
    });
    const cashReport = calculateFinanceReport({
      charges: cashInput, otherIncomes: incomes.map((i) => moneyFromDb(i.amount)), expenses: expenses.map((e) => moneyFromDb(e.amount)),
      overpayments: credit.filter((c) => c.type === 'overpayment').map((c) => moneyFromDb(c.amount)),
      memberPayouts: credit.filter((c) => c.type === 'cash_payout').map((c) => moneyFromDb(c.amount)),
    });
    const report = { ...cohortReport, collected: cashReport.collected, overpaymentIn: cashReport.overpaymentIn,
      memberPayouts: cashReport.memberPayouts, otherIncome: cashReport.otherIncome, expense: cashReport.expense, netCash: cashReport.netCash };
    const actualCost = fromSatang(toSatang(report.charged) - toSatang(report.roundingSurplus));
    assertReportReconciles(report, actualCost);
    const refunded = fromSatang(-sumSatang(refunds.map((r) => toSatang(moneyFromDb(r.amount)))));
    const allocatedInPeriod = sum(periodCash.allocations.map((a) => a.amount));
    const creditAllocated = sum(periodCash.allocations.filter((a) => a.source === 'credit').map((a) => a.amount));
    const cashIdentity = fromSatang(toSatang(periodCash.transferIn) - toSatang(refunded) + toSatang(report.overpaymentIn)
      + toSatang(report.otherIncome) - toSatang(report.expense) - toSatang(report.memberPayouts));
    if (cashIdentity !== report.netCash) throw new AppError('INTERNAL_ERROR', 'กระแสเงินสดไม่ตรงกับรายงาน');
    const toEntries = (kind: 'income' | 'expense', rows: Entry[]) => rows.map((r) => ({ id: r.id, kind, amount: moneyFromDb(r.amount), category: r.category, note: r.note, occurredOn: r.occurred_on, sessionId: r.session_id }));
    return {
      range, outstandingAsOf, report, actualCost, allocatedInPeriod, creditAllocated,
      transferIn: periodCash.transferIn, refunds: refunded, cashInBySession: periodCash.cashInBySession,
      entries: [...toEntries('income', incomes), ...toEntries('expense', expenses)].sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || a.id.localeCompare(b.id)),
    };
  });
}
