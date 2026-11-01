/** Q-R1 cash basis: real local PostgREST, fixture-only changes, no reset. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, serviceClient } from '../helpers/db';
import { financeRange } from '@/server/payments/report-range';
import { readPeriodCash } from '@/server/payments/report-cash';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';

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
});
