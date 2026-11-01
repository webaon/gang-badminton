/** WO-6.5a queue + debtor names. Real DB, no reset, auth mocked; former-profile RLS probed separately. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient, visibleCount } from '../helpers/db';
const h = vi.hoisted(() => ({ userId: '', hiddenProfile: '', adminCalls: 0, failTable: '' }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => { h.adminCalls += 1; return serviceClient(); } }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => {
  const db = serviceClient();
  return new Proxy(db, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key);
    return (table: string) => {
      if (table === h.failTable) {
        const result = Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected failure' } });
        const chain: unknown = new Proxy({}, { get: (_, prop) => prop === 'then' ? result.then.bind(result) : () => chain });
        return chain;
      }
      const builder = db.from(table);
      if (table !== 'profiles' || !h.hiddenProfile) return builder;
      return new Proxy(builder, { get(t, prop) {
        if (prop !== 'select') return Reflect.get(t, prop);
        return (columns: string) => builder.select(columns).neq('id', h.hiddenProfile);
      } });
    };
  } });
} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
import { adminPaymentList } from '@/server/actions/payment-list';
import { adminLedger } from '@/server/actions/payment-admin';

let owner: string, member: string, stranger: string, gang: string, sessionId: string, charge: string, gm: string;
let submitted: string[];
beforeAll(async () => {
  const { rows: users } = await pool.query<{ id: string }>(`insert into auth.users(id,email)
    select gen_random_uuid(),'queue-' || gen_random_uuid() || '@example.com' from generate_series(1,3) returning id`);
  [owner, member, stranger] = users.map((u) => u.id);
  const { rows: [g] } = await pool.query<{ id: string }>('select id from public.create_gang($1,$2)', [owner, `queue-${crypto.randomUUID()}`]);
  gang = g.id;
  const { rows: [m] } = await pool.query<{ id: string }>(`insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member') returning id`, [gang, member]);
  gm = m.id;
  await pool.query(`update public.profiles set display_name='ชื่อสมาชิกในก๊วน' where id=$1`, [member]);
  const { rows: [s] } = await pool.query<{ id: string }>(`insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,court_count,created_by)
    values($1,'นัดในคิว',now(),now()+interval '2 hours',4,1,$2) returning id`, [gang, owner]);
  sessionId = s.id;
  const { rows: [r] } = await pool.query<{ id: string }>(`insert into public.session_registrations(session_id,user_id,status,ordering,created_by)
    values($1,$2,'confirmed',1,$3) returning id`, [sessionId, member, owner]);
  const { rows: [c] } = await pool.query<{ id: string }>(`insert into public.session_charges(gang_id,type,session_id,registration_id,amount,created_by)
    values($1,'session',$2,$3,10,$4) returning id`, [gang, sessionId, r.id, owner]);
  charge = c.id;
  const { rows: payments } = await pool.query<{ id: string }>(`insert into public.payments(gang_id,payer_user_id,amount,created_by)
    select $1,$2,10,$3 from generate_series(1,1005) returning id`, [gang, member, owner]);
  submitted = payments.slice(0,1001).map((p) => p.id).sort();
  await pool.query(`insert into public.payment_allocations(payment_id,session_charge_id,amount)
    select u,$2,10 from unnest($1::uuid[]) u`, [payments.map((p) => p.id), charge]);
  await pool.query(`select public.transition_payment(u,'submitted',$2) from unnest($1::uuid[]) u`, [submitted, member]);
  await pool.query(`update public.payments set submitted_at='2026-11-03T00:00:00.000001Z' where id=any($1::uuid[])`, [submitted]);
  for (const [id, state] of [[payments[1002].id, 'verified'], [payments[1003].id, 'rejected']]) {
    await pool.query("select public.transition_payment($1,'submitted',$2)", [id, member]);
    await pool.query('select public.transition_payment($1,$2,$3,$4)', [id, state, owner, state === 'rejected' ? 'retry' : null]);
  }
  await pool.query('update public.payments set deleted_at=now() where id=$1', [payments[1004].id]);
}, 30000);
afterAll(async () => { await pool.end(); });

describe('WO-6.5a adminPaymentList + displayName', () => {
  it('submitted oldest first, ties use id; >1000 complete unique rows; counts are full scope on every page', async () => {
    h.userId = owner;
    let cursor: string | undefined;
    const all: string[] = [];
    do {
      const result = await adminPaymentList(gang, { cursor, pageSize: 400, filter: { status: 'submitted', sessionId } });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('queue failed');
      expect(result.data.counts).toEqual({ submitted: 1001, pending: 1, verified: 1, rejected: 1 });
      expect(result.data.rows.every((r) => r.payerDisplayName === 'ชื่อสมาชิกในก๊วน' && r.amount === '10.00' && r.sessionTitles[0] === 'นัดในคิว')).toBe(true);
      all.push(...result.data.rows.map((r) => r.paymentId));
      cursor = result.data.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual(submitted);
    expect(new Set(all).size).toBe(1001);
  }, 20000);

  it('timestamp order beats UUID order and opaque cursor crosses tied submitted timestamps exactly', async () => {
    // Last UUID becomes the oldest submitted record. The id-only scan would get this wrong.
    const oldest = submitted[submitted.length - 1];
    await pool.query(`update public.payments set submitted_at='2026-11-03T00:00:00.000000Z' where id=$1`, [oldest]);
    const first = await adminPaymentList(gang, { pageSize: 1 });
    expect(first.success && first.data.rows[0].paymentId).toBe(oldest);
    if (!first.success || !first.data.nextCursor) throw new Error('missing queue cursor');
    const next = await adminPaymentList(gang, { pageSize: 1, cursor: first.data.nextCursor });
    expect(next.success && next.data.rows[0].paymentId).toBe(submitted[0]);
    const none = await adminPaymentList(gang, { filter: { sessionId: crypto.randomUUID() } });
    expect(none.success && none.data).toEqual({ rows: [], nextCursor: null, counts: { submitted: 0, verified: 0, rejected: 0, pending: 0 } });
  });

  it('ledger uses member name, guest uses guestName, former member still named via narrowly scoped fallback', async () => {
    const { rows: [guest] } = await pool.query<{ id: string }>(`insert into public.session_registrations(session_id,guest_name,status,ordering,created_by)
      values($1,'แขกทดสอบ','confirmed',2,$2) returning id`, [sessionId, owner]);
    await pool.query(`insert into public.session_charges(gang_id,type,session_id,registration_id,amount,created_by)
      values($1,'session',$2,$3,20,$4)`, [gang, sessionId, guest.id, owner]);
    let result = await adminLedger(gang);
    expect(result.success && result.data.rows.find((r) => r.id === charge)?.displayName).toBe('ชื่อสมาชิกในก๊วน');
    expect(result.success && result.data.rows.find((r) => r.guestName === 'แขกทดสอบ')?.displayName).toBe('แขกทดสอบ');
    await pool.query('update public.gang_members set deleted_at=now() where id=$1', [gm]);
    expect(await visibleCount(owner, 'select 1 from public.profiles where id=$1', [member])).toBe(0);
    // Emulate precisely this RLS profile exclusion in the otherwise service-backed action test.
    h.hiddenProfile = member; h.adminCalls = 0;
    result = await adminLedger(gang);
    expect(result.success && result.data.rows.find((r) => r.id === charge)?.displayName).toBe('ชื่อสมาชิกในก๊วน');
    expect(h.adminCalls).toBe(1);
    const list = await adminPaymentList(gang, { pageSize: 1 });
    expect(list.success && list.data.rows[0].payerDisplayName).toBe('ชื่อสมาชิกในก๊วน');
    h.hiddenProfile = '';
  });

  it('denies member/outsider before name fallback; validates page/cursor and propagates DB errors', async () => {
    h.adminCalls = 0;
    for (const actor of [member, stranger]) {
      h.userId = actor;
      const result = await adminPaymentList(gang);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(h.adminCalls).toBe(0);
    h.userId = owner;
    expect((await adminPaymentList(gang, { pageSize: 501 })).success).toBe(false);
    expect((await adminPaymentList(gang, { cursor: 'bad' })).success).toBe(false);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const table of ['payments', 'payment_allocations', 'session_charges', 'profiles']) {
        h.failTable = table;
        expect((await adminPaymentList(gang)).success).toBe(false);
      }
    } finally { h.failTable = ''; log.mockRestore(); }
  });
});
