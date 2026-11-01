/** WO-6.5a: real PostgREST + pooled DB, fixture-only writes, no reset.
 * Session identity mocked; action predicates exercised with a service client (explicitly bypasses RLS).
 * RLS itself is probed separately with SET LOCAL ROLE via visibleCount.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient, visibleCount } from '../helpers/db';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';

const h = vi.hoisted(() => ({ userId: '', failTable: '' }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => {
  const real = serviceClient();
  if (!h.failTable) return real;
  return new Proxy(real, { get(target, prop) {
    if (prop !== 'from') return Reflect.get(target, prop);
    return (table: string) => {
      if (table !== h.failTable) return real.from(table);
      const fail = { data: null, error: { message: 'injected query failure', code: 'XX000' } };
      const chain: unknown = new Proxy({}, { get: (_, key) => key === 'then' ? Promise.resolve(fail).then.bind(Promise.resolve(fail)) : () => chain });
      return chain;
    };
  } });
} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
import { adminLedger, adminPaymentDetail, chargeHistory } from '@/server/actions/payment-admin';

async function user() {
  const { rows: [r] } = await pool.query<{ id: string }>(
    `insert into auth.users(id,email) values(gen_random_uuid(),$1) returning id`, [`admin-read-${crypto.randomUUID()}@example.com`]);
  return r.id;
}
let gang: string, owner: string, member: string, admin: string, outsider: string, gm: string;
let ids: string[], payment: string;
beforeAll(async () => {
  owner = await user(); member = await user(); admin = await user(); outsider = await user();
  const { rows: [g] } = await pool.query<{ id: string }>('select id from public.create_gang($1,$2)', [owner, `admin-read-${crypto.randomUUID()}`]);
  gang = g.id;
  for (const [id, role] of [[member, 'member'], [admin, 'admin']]) {
    const { rows: [m] } = await pool.query<{ id: string }>(
      'insert into public.gang_members(gang_id,user_id,role) values($1,$2,$3) returning id', [gang, id, role]);
    if (id === member) gm = m.id;
  }
  // >1000 visible rows in THIS gang, rather than relying on unrelated shared fixtures.
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.session_charges(gang_id,type,gang_member_id,billing_month,amount,created_by,created_at)
     select $1,'monthly_fee',$2, date '1900-01-01' + (i * interval '1 month'),10,$3,
       now() - make_interval(days => case when i % 3 = 0 then 31 when i % 3 = 1 then 8 else 0 end)
       from generate_series(0,1006) i returning id`, [gang, gm, owner]);
  ids = rows.map((r) => r.id).sort();
  const { rows: [p] } = await pool.query<{ id: string }>(
    'select id from public.create_payment_for_charges($1,$2,$3::uuid[],$4)', [gang, member, ids, owner]);
  payment = p.id;
  await pool.query("select public.transition_payment($1,'submitted',$2)", [payment, member]);
}, 30000);
afterAll(async () => { await pool.end(); });

const total = (values: string[]) => fromSatang(sumSatang(values.map(toSatang)));

describe('WO-6.5a first three finance readers', () => {
  it('adminPaymentDetail reads >1000 allocations, string money, resumable review and comparison', async () => {
    h.userId = admin;
    let res = await adminPaymentDetail(payment);
    expect(res.success).toBe(true);
    if (!res.success) throw new Error('detail failed');
    expect(res.data.allocations).toHaveLength(1007);
    expect(new Set(res.data.allocations.map((a) => a.chargeId)).size).toBe(1007);
    expect(total(res.data.allocations.map((a) => a.amount))).toBe('10070.00');
    expect(res.data.amount).toBe('10070.00');
    expect(res.data.comparison).toBe('unknown');
    expect(res.data.permissions.verify).toBe(true);
    expect(res.data.slip).toBeNull();
    expect(res.data.allocations[0].charge?.amount).toBe('10.00');
    await pool.query('select public.set_payment_received_amount($1,$2,$3)', [payment, '10080.25', owner]);
    res = await adminPaymentDetail(payment);
    expect(res.success && res.data).toMatchObject({ receivedAmount: '10080.25', comparison: 'over', overpaymentAmount: '10.25', overpayment: null });
    await pool.query("select public.transition_payment($1,'verified',$2)", [payment, owner]);
    const ready = await adminPaymentDetail(payment);
    expect(ready.success && ready.data.permissions).toMatchObject({ verify: false, reject: false, recordOverpayment: true });
    await pool.query('select public.record_overpayment($1,$2,$3,$4)', [payment, null, 'actual excess', owner]);
    const recorded = await adminPaymentDetail(payment);
    expect(recorded.success && recorded.data.overpayment?.amount).toBe('10.25');
    expect(recorded.success && recorded.data.permissions.recordOverpayment).toBe(false);
  }, 20000);

  it('adminLedger walks >1000 unique rows; summary covers whole filtered scope, not current page', async () => {
    h.userId = admin;
    let cursor: string | undefined;
    const found: string[] = [];
    let pages = 0;
    do {
      const res = await adminLedger(gang, { cursor, pageSize: 499 });
      expect(res.success).toBe(true);
      if (!res.success) throw new Error('ledger failed');
      expect(res.data.summary.charged).toBe('10070.00');
      expect(res.data.summary.paid).toBe('10070.00');
      expect(res.data.summary.transferPaid).toBe('10070.00');
      expect(res.data.summary.creditPaid).toBe('0.00');
      expect(res.data.summary.debtors).toBe(0);
      found.push(...res.data.rows.map((r) => r.id));
      cursor = res.data.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(found).toEqual(ids);
  }, 20000);

  it('chargeHistory reads >1000 adjustments and shows reduced/pending/returned without retrying step one', async () => {
    h.userId = admin;
    const charge = ids[0];
    await pool.query(
      `insert into public.payment_adjustments(session_charge_id,type,amount,reason,created_by)
       select $1,'correction',0.01,'history pagination',$2 from generate_series(1,1001)`, [charge, owner]);
    let result = await chargeHistory(charge);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('history failed');
    expect(result.data.adjustments).toHaveLength(1001);
    expect(total(result.data.adjustments.map((a) => a.amount))).toBe('10.01');
    const { rows: [db] } = await pool.query<{ outstanding: string }>('select public.charge_outstanding($1)::text as outstanding', [charge]);
    expect(result.data.outstanding).toBe(db.outstanding);
    await pool.query("select public.add_payment_adjustment($1,'credit',-12,$2,null,$3)", [charge, 'reduce only, step 1', owner]);
    result = await chargeHistory(charge);
    expect(result.success && result.data.creditReturn).toMatchObject({ debtReduced: true, state: 'pending_credit_return', returnedAmount: '0.00', canReturn: true });
    await pool.query('select public.credit_return_charge($1,null,$2,$3)', [charge, 'step 2 only', owner]);
    result = await chargeHistory(charge);
    expect(result.success && result.data.creditReturn).toMatchObject({ state: 'returned', returnedAmount: '1.99', canReturn: false });
    expect(result.success && result.data.adjustments.filter((a) => a.type === 'credit_return')).toHaveLength(1);
  }, 20000);

  it('aging 0–7 / 8–30 / >30 uses Bangkok calendar days; debtor count dedupes a member across charges', async () => {
    // Remove this fixture's wallet credit before making new debts (auto-apply is intentionally active).
    await pool.query('select public.credit_cash_payout($1,$2,$3,$4,$5)', [gang, member, '12.24', 'fixture payout', owner]);
    // All remaining verified charges are settled. Make 3 new monthly charges, one in each bucket.
    const { rows: debt } = await pool.query<{ id: string }>(
      `insert into public.session_charges(gang_id,type,gang_member_id,billing_month,amount,created_by,created_at)
       select $1,'monthly_fee',$2,date '2100-01-01' + (i * interval '1 month'),20,$3,
       (((now() at time zone 'Asia/Bangkok')::date - (case i when 0 then 7 when 1 then 8 else 31 end))::timestamp at time zone 'Asia/Bangkok')
       from generate_series(0,2) i returning id`, [gang, gm, owner]);
    h.userId = admin;
    const res = await adminLedger(gang, { pageSize: 1, filter: { status: 'outstanding' } });
    expect(res.success && res.data.summary).toMatchObject({ outstanding: '60.00', debtors: 1, aging: {
      '0-7': { outstanding: '20.00', debtors: 1 }, '8-30': { outstanding: '20.00', debtors: 1 }, '>30': { outstanding: '20.00', debtors: 1 },
    } });
    const filtered = await adminLedger(gang, { filter: { aging: '8-30', status: 'outstanding' } });
    expect(filtered.success && filtered.data.rows).toHaveLength(1);
    expect(filtered.success && filtered.data.summary.outstanding).toBe('20.00');
    for (const c of debt) {
      const history = await chargeHistory(c.id);
      const { rows: [db] } = await pool.query<{ amount: string }>('select public.charge_outstanding($1)::text as amount', [c.id]);
      expect(history.success && history.data.outstanding).toBe(db.amount);
    }
  }, 20000);

  it('verified credit is a subset of paid, not transfer cash', async () => {
    h.userId = owner;
    await pool.query('select public.credit_topup($1,$2,15,$3,$4)', [gang, member, 'noncash credit', owner]);
    const { rows: [applied] } = await pool.query<{ result: { payment_id: string } }>(
      'select public.apply_credit($1,$2,null,$3) as result', [gang, member, owner]);
    const result = await adminLedger(gang);
    expect(result.success && result.data.summary).toMatchObject({ paid: '10085.00', transferPaid: '10070.00', creditPaid: '15.00', outstanding: '45.00' });
    const detail = await adminPaymentDetail(applied.result.payment_id);
    expect(detail.success && detail.data).toMatchObject({ source: 'credit', amount: '15.00', status: 'verified', permissions: { setReceivedAmount: false, verify: false, recordOverpayment: false } });
  });

  it('session aging uses starts_at in Bangkok, not the newly created charge timestamp', async () => {
    const { rows: [s] } = await pool.query<{ id: string }>(
      `insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,court_count,created_by)
       values($1,'aging session',(((now() at time zone 'Asia/Bangkok')::date - 30)::timestamp + interval '10 minutes') at time zone 'Asia/Bangkok',
       (((now() at time zone 'Asia/Bangkok')::date - 30)::timestamp + interval '2 hours') at time zone 'Asia/Bangkok',4,1,$2) returning id`, [gang, owner]);
    const { rows: [r] } = await pool.query<{ id: string }>(
      `insert into public.session_registrations(session_id,user_id,status,ordering,created_by) values($1,$2,'confirmed',1,$3) returning id`, [s.id, member, owner]);
    await pool.query(`insert into public.session_charges(gang_id,type,session_id,registration_id,amount,created_by) values($1,'session',$2,$3,10,$4)`, [gang, s.id, r.id, owner]);
    h.userId = admin;
    const res = await adminLedger(gang, { filter: { sessionId: s.id, aging: '8-30' } });
    expect(res.success && res.data.rows).toHaveLength(1);
    expect(res.success && res.data.rows[0]).toMatchObject({ daysOutstanding: 30, aging: '8-30', outstanding: '10.00' });
    expect(res.success && res.data.summary.charged).toBe('10.00');
  });

  it('member and outsider cannot call any admin reader, including member-owned payment/charge', async () => {
    for (const actor of [member, outsider]) {
      h.userId = actor;
      for (const result of [await adminPaymentDetail(payment), await adminLedger(gang), await chargeHistory(ids[0])]) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.code).toBe('FORBIDDEN');
      }
    }
    // Verify real RLS separately (action tests above deliberately bypass it).
    expect(await visibleCount(outsider, 'select 1 from public.session_charges where gang_id=$1', [gang])).toBe(0);
    expect(await visibleCount(admin, 'select 1 from public.session_charges where gang_id=$1', [gang])).toBeGreaterThan(1000);
  });

  it('query failures must return an error, never successful []/zero totals', async () => {
    h.userId = admin;
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const table of ['gang_members', 'session_charges', 'payment_allocations', 'payment_adjustments']) {
        h.failTable = table;
        const result = await adminLedger(gang);
        expect(result.success).toBe(false);
      }
    } finally { h.failTable = ''; warn.mockRestore(); }
  });

  it('invalid cursor/filter/page sizes fail closed', async () => {
    h.userId = owner;
    expect((await adminLedger(gang, { cursor: 'bad' })).success).toBe(false);
    expect((await adminLedger(gang, { pageSize: 1001 })).success).toBe(false);
    expect((await adminLedger(gang, { filter: { sessionId: 'bad' } })).success).toBe(false);
    expect((await adminPaymentDetail(crypto.randomUUID())).success).toBe(false);
    expect((await chargeHistory(crypto.randomUUID())).success).toBe(false);
  });
});
