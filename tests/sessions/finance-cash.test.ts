/** Q-R1 cash basis: real local PostgREST, fixture-only changes, no reset. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient } from '../helpers/db';
import { financeRange } from '@/server/payments/report-range';
import { readPeriodCash } from '@/server/payments/report-cash';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { calculateFinanceReport, type ReportCharge } from '@/domain/reports/finance';
const h = vi.hoisted(() => ({ userId: '', failTable: '' }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => {
  const real = serviceClient();
  return new Proxy(real, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key);
    return (table: string) => {
      if (table !== h.failTable) return real.from(table);
      const result = Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected failure' } });
      const chain: unknown = new Proxy({}, { get: (_, prop) => prop === 'then' ? result.then.bind(result) : () => chain });
      return chain;
    };
  } });
} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
import { financeReport } from '@/server/actions/finance-report';

let gang: string, owner: string, member: string, gm: string;
let sessionIds: string[], chargeIds: string[], payment: string, monthlyTotal: string, paymentTotal: string;
beforeAll(async () => {
  const { rows: users } = await pool.query<{ id: string }>(
    `insert into auth.users(id,email) select gen_random_uuid(),'report-' || gen_random_uuid() || '@example.com' from generate_series(1,2) returning id`);
  [owner, member] = users.map((r) => r.id);
  const { rows: [g] } = await pool.query<{ id: string }>('select id from public.create_gang($1,$2)', [owner, `report-${crypto.randomUUID()}`]);
  gang = g.id;
  const { rows: [m] } = await pool.query<{ id: string }>(`insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member') returning id`, [gang, member]);
  gm = m.id;
  const { rows: sessions } = await pool.query<{ id: string }>(
    `insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,court_count,created_by)
     select $1,'October session ' || i, '2026-10-30T19:00:00+07'::timestamptz + i * interval '1 day',
       '2026-10-30T21:00:00+07'::timestamptz + i * interval '1 day',4,1,$2 from generate_series(0,1) i returning id`, [gang, owner]);
  sessionIds = sessions.map((s) => s.id);
  chargeIds = [];
  for (const [index, sid] of sessionIds.entries()) {
    const { rows: [r] } = await pool.query<{ id: string }>(
      `insert into public.session_registrations(session_id,user_id,status,ordering,created_by) values($1,$2,'confirmed',1,$3) returning id`, [sid, member, owner]);
    const { rows: [c] } = await pool.query<{ id: string }>(
      `insert into public.session_charges(gang_id,type,session_id,registration_id,amount,created_by,created_at)
       values($1,'session',$2,$3,$4,$5,'2026-10-31T12:00:00+07') returning id`, [gang, sid, r.id, index === 0 ? '100.00' : '200.00', owner]);
    chargeIds.push(c.id);
  }
  const { rows: monthly } = await pool.query<{ id: string }>(
    `insert into public.session_charges(gang_id,type,gang_member_id,billing_month,amount,created_by,created_at)
     select $1,'monthly_fee',$2,date '1900-01-01' + i * interval '1 month',1.25,$3,'2026-10-31T12:00:00+07'
     from generate_series(0,1000) i returning id`, [gang, gm, owner]);
  const { rows: [total] } = await pool.query<{ amount: string }>('select sum(amount)::text as amount from public.session_charges where id=any($1::uuid[])', [monthly.map((c) => c.id)]);
  monthlyTotal = total.amount;
  chargeIds.push(...monthly.map((c) => c.id));
  const { rows: [p] } = await pool.query<{ id: string; amount: string }>('select id,amount::text from public.create_payment_for_charges($1,$2,$3::uuid[],$4)', [gang, member, chargeIds, owner]);
  payment = p.id; paymentTotal = p.amount;
  await pool.query("select public.transition_payment($1,'submitted',$2)", [payment, member]);
  await pool.query("select public.transition_payment($1,'verified',$2)", [payment, owner]);
  await pool.query("update public.payments set verified_at='2026-11-03T10:00:00+07' where id=$1", [payment]);
}, 30000);
afterAll(async () => { await pool.end(); });
const db = serviceClient();
const range = financeRange({ from: '2026-11-01', to: '2026-11-30' });

describe('Q-R1 verified_at + cashInBySession', () => {
  it('October sessions verified November 3 belong to November, not October; one payment splits into two sessions plus monthly', async () => {
    const november = await readPeriodCash(db, gang, range);
    expect(november.allocations).toHaveLength(1003);
    expect(new Set(november.allocations.map((a) => a.id)).size).toBe(1003);
    expect(november.cashInBySession).toHaveLength(3);
    expect(november.cashInBySession.find((s) => s.sessionId === sessionIds[0])?.amount).toBe('100.00');
    expect(november.cashInBySession.find((s) => s.sessionId === sessionIds[1])?.amount).toBe('200.00');
    expect(november.cashInBySession.find((s) => s.sessionId === null)).toEqual({ sessionId: null, sessionTitle: 'ค่าสมาชิกรายเดือน', sessionDate: null, amount: monthlyTotal });
    expect(november.transferIn).toBe(paymentTotal);
    expect(fromSatang(sumSatang(november.cashInBySession.map((s) => toSatang(s.amount))))).toBe(november.transferIn);
    const october = await readPeriodCash(db, gang, financeRange({ from: '2026-10-01', to: '2026-10-31' }));
    expect(october.allocations).toEqual([]);
    expect(october.transferIn).toBe('0.00');
  });

  it('start midnight Thai inclusive, final next-midnight exclusive, including microsecond boundary', async () => {
    for (const [instant, included] of [
      ['2026-10-31T16:59:59.999999Z', false], ['2026-10-31T17:00:00Z', true],
      ['2026-11-30T16:59:59.999999Z', true], ['2026-11-30T17:00:00Z', false],
    ] as const) {
      await pool.query('update public.payments set verified_at=$2::timestamptz where id=$1', [payment, instant]);
      const res = await readPeriodCash(db, gang, range);
      expect(res.transferIn, instant).toBe(included ? paymentTotal : '0.00');
    }
  });

  it('soft-deleted verified payment excluded; another gang never receives its cash', async () => {
    await pool.query("update public.payments set verified_at='2026-11-03T10:00:00+07',deleted_at=now() where id=$1", [payment]);
    expect((await readPeriodCash(db, gang, range)).transferIn).toBe('0.00');
    await pool.query('update public.payments set deleted_at=null where id=$1', [payment]);
    expect((await readPeriodCash(db, crypto.randomUUID(), range)).cashInBySession).toEqual([]);
    expect((await readPeriodCash(db, gang, range)).transferIn).toBe(paymentTotal);
  });

  it('public report separates session-date cohort from verified-period cash, without losing money across October + November', async () => {
    h.userId = owner;
    // Charge was written in November, but its SESSION was in October: cohort must stay October.
    await pool.query("update public.session_charges set created_at='2026-11-05T10:00:00+07' where id=$1", [chargeIds[0]]);
    const oct = await financeReport(gang, { from: '2026-10-01', to: '2026-10-31' });
    const nov = await financeReport(gang, { from: '2026-11-01', to: '2026-11-30' });
    const both = await financeReport(gang, { from: '2026-10-01', to: '2026-11-30' });
    expect(oct.success && nov.success && both.success).toBe(true);
    if (!oct.success || !nov.success || !both.success) throw new Error('report failed');
    expect(oct.data.report.charged).toBe(paymentTotal);
    expect(oct.data.report.outstanding).toBe('0.00'); // lifetime verified allocations, despite cash coming next month
    expect(oct.data.report.collected).toBe('0.00');
    expect(oct.data.actualCost).toBe(paymentTotal);
    expect(nov.data.report.charged).toBe('0.00');
    expect(nov.data.report.collected).toBe(paymentTotal);
    expect(nov.data.cashInBySession).toHaveLength(3);
    const sum = (values: string[]) => fromSatang(sumSatang(values.map(toSatang)));
    expect(sum([oct.data.transferIn, nov.data.transferIn])).toBe(both.data.transferIn);
    expect(both.data.transferIn).toBe(paymentTotal);
    expect(sum(nov.data.cashInBySession.map((s) => s.amount))).toBe(nov.data.transferIn);
    expect(Number.isFinite(Date.parse(oct.data.outstandingAsOf))).toBe(true);
  }, 20000);

  it('cash identity matches existing finance domain; credit is subset, only overpayment/cash_payout affect cash', async () => {
    const { rows: [g] } = await pool.query<{ id: string }>('select id from public.create_gang($1,$2)', [owner, `cash-domain-${crypto.randomUUID()}`]);
    const gid = g.id;
    const { rows: [m] } = await pool.query<{ id: string }>(`insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member') returning id`, [gid, member]);
    const { rows: [date] } = await pool.query<{ day: string }>(`select (now() at time zone 'Asia/Bangkok')::date::text as day`);
    await pool.query('select public.credit_topup($1,$2,20,$3,$4)', [gid, member, 'not cash', owner]);
    const { rows: [cc] } = await pool.query<{ id: string }>(`insert into public.session_charges(gang_id,type,gang_member_id,billing_month,amount,created_by)
      values($1,'monthly_fee',$2,date_trunc('month',now())::date,20,$3) returning id`, [gid, m.id, owner]);
    const { rows: [tc] } = await pool.query<{ id: string }>(`insert into public.session_charges(gang_id,type,gang_member_id,billing_month,amount,created_by)
      values($1,'monthly_fee',$2,(date_trunc('month',now())+interval '1 month')::date,100,$3) returning id`, [gid, m.id, owner]);
    const { rows: [p] } = await pool.query<{ id: string }>('select id from public.create_payment_for_charges($1,$2,$3::uuid[],$4)', [gid, member, [tc.id], owner]);
    await pool.query("select public.transition_payment($1,'submitted',$2)", [p.id, member]);
    await pool.query("select public.transition_payment($1,'verified',$2)", [p.id, owner]);
    await pool.query('select public.set_payment_received_amount($1,110,$2)', [p.id, owner]);
    await pool.query('select public.record_overpayment($1,null,$2,$3)', [p.id, 'ten excess cash', owner]);
    await pool.query('select public.credit_cash_payout($1,$2,4,$3,$4)', [gid, member, 'cash out', owner]);
    await pool.query("select public.add_payment_adjustment($1,'credit',-5,$2,null,$3)", [cc.id, 'debt reduction', owner]);
    await pool.query('select public.credit_return_charge($1,null,$2,$3)', [cc.id, 'noncash return', owner]);
    await pool.query("select public.add_payment_adjustment($1,'refund',-3,$2,$3,$4)", [tc.id, 'cash refund', p.id, owner]);
    for (const [table, amount] of [['gang_incomes', '7.00'], ['gang_expenses', '2.00']]) {
      await pool.query(`insert into public.${table}(gang_id,category,amount,occurred_on,created_by) values($1,'fixture',$2,$3,$4)`, [gid, amount, date.day, owner]);
    }
    h.userId = owner;
    const actual = await financeReport(gid, { from: date.day, to: date.day });
    expect(actual.success).toBe(true);
    if (!actual.success) throw new Error('cash report failed');
    const charges: ReportCharge[] = [
      { chargeId: cc.id, amount: '20.00', allocated: ['20.00'], creditAllocated: ['20.00'], adjustments: ['-5.00','5.00'], refunds: [], roundingSurplus: '0.00' },
      { chargeId: tc.id, amount: '100.00', allocated: ['100.00'], adjustments: ['-3.00'], refunds: ['-3.00'], roundingSurplus: '0.00' },
    ];
    const expected = calculateFinanceReport({ charges, otherIncomes: ['7.00'], expenses: ['2.00'], overpayments: ['10.00'], memberPayouts: ['-4.00'] });
    expect(actual.data.report).toEqual(expected);
    expect(actual.data.creditAllocated).toBe('20.00');
    expect(actual.data.refunds).toBe('3.00');
    expect(actual.data.report.overpaymentIn).toBe('10.00'); // not admin_topup20 or charge_return5
    const netIdentity = fromSatang(sumSatang(actual.data.cashInBySession.map((s) => toSatang(s.amount)))
      - toSatang(actual.data.refunds) + toSatang(actual.data.report.overpaymentIn) + toSatang(actual.data.report.otherIncome)
      - toSatang(actual.data.report.expense) - toSatang(actual.data.report.memberPayouts));
    expect(actual.data.report.netCash).toBe(netIdentity);
  });

  it('refund cash follows adjustment date independently of cohort; >1000 refund rows remain complete', async () => {
    await pool.query(`insert into public.payment_adjustments(session_charge_id,type,amount,reason,created_by,created_at)
      select $1,'refund',-0.01,'November refund pagination',$2,'2026-11-10T00:00:00+07' from generate_series(1,1001)`, [chargeIds[0], owner]);
    await pool.query(`insert into public.payment_adjustments(session_charge_id,type,amount,reason,created_by,created_at)
      values($1,'refund',-2,'December refund',$2,'2026-12-01T00:00:00+07')`, [chargeIds[0], owner]);
    await pool.query(`update public.session_charges set breakdown=jsonb_build_object('rounding_surplus','1.00') where id=$1`, [chargeIds[0]]);
    h.userId = owner;
    const november = await financeReport(gang, { from: '2026-11-01', to: '2026-11-30' });
    const october = await financeReport(gang, { from: '2026-10-01', to: '2026-10-31' });
    expect(november.success && october.success).toBe(true);
    if (!november.success || !october.success) throw new Error('refund report failed');
    const { rows: [raw] } = await pool.query<{ refunds: string }>(`select (-sum(amount))::numeric(12,2)::text as refunds from public.payment_adjustments
      where session_charge_id=$1 and type='refund' and created_at >= '2026-11-01T00:00:00+07' and created_at < '2026-12-01T00:00:00+07'`, [chargeIds[0]]);
    expect(november.data.refunds).toBe(raw.refunds);
    expect(november.data.report.collected).toBe(fromSatang(toSatang(paymentTotal) - toSatang(raw.refunds)));
    expect(october.data.refunds).toBe('0.00');
    expect(october.data.report.roundingSurplus).toBe('1.00');
    expect(october.data.actualCost).toBe(fromSatang(toSatang(paymentTotal) - toSatang('1.00')));
    const { rows: [out] } = await pool.query<{ amount: string }>('select public.charge_outstanding($1)::text as amount', [chargeIds[0]]);
    expect(october.data.report.credit).toBe(out.amount); // includes December adjustment: balances explicitly AS OF NOW
  });

  it('report permissions and query errors fail closed, never empty successful reports', async () => {
    h.userId = member;
    const forbidden = await financeReport(gang, { from: '2026-11-01', to: '2026-11-30' });
    expect(forbidden.success).toBe(false);
    if (!forbidden.success) expect(forbidden.error.code).toBe('FORBIDDEN');
    h.userId = crypto.randomUUID();
    expect((await financeReport(gang, { from: '2026-11-01', to: '2026-11-30' })).success).toBe(false);
    h.userId = owner;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const table of ['payments','session_charges','payment_adjustments','credit_ledger','gang_incomes','gang_expenses']) {
        h.failTable = table;
        expect((await financeReport(gang, { from: '2026-11-01', to: '2026-11-30' })).success).toBe(false);
      }
    } finally { h.failTable = ''; log.mockRestore(); }
  });
});
