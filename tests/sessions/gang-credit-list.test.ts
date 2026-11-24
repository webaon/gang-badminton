/** WO-6.5a full-gang credit pagination: >1000 current members and wallets, local DB, no reset. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient, visibleCount } from '../helpers/db';
const h = vi.hoisted(() => ({ userId: '', failTable: '' }));
vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => {
  const db = serviceClient();
  if (!h.failTable) return db;
  return new Proxy(db, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key);
    return (table: string) => {
      if (table !== h.failTable) return db.from(table);
      const result = Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected failure' } });
      const chain: unknown = new Proxy({}, { get: (_, prop) => prop === 'then' ? result.then.bind(result) : () => chain });
      return chain;
    };
  } });
} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
import { listGangCredits } from '@/server/actions/credit';

let gang: string, owner: string, stranger: string, members: string[], expected: string;
beforeAll(async () => {
  const { rows: users } = await pool.query<{ id: string }>(
    `insert into auth.users(id,email) select gen_random_uuid(), 'credits-' || gen_random_uuid() || '@example.com' from generate_series(1,1009) returning id`);
  [owner, stranger, ...members] = users.map((u) => u.id);
  const { rows: [g] } = await pool.query<{ id: string }>('select id from public.create_gang($1,$2)', [owner, `credit-list-${crypto.randomUUID()}`]);
  gang = g.id;
  await pool.query(`insert into public.gang_members(gang_id,user_id,role) select $1,u,'member' from unnest($2::uuid[]) u`, [gang, members]);
  await pool.query(`select public.credit_topup($1,u,1.01,'pagination fixture',$3) from unnest($2::uuid[]) u`, [gang, members.slice(0,1005), owner]);
  const { rows: [r] } = await pool.query<{ total: string }>('select sum(balance)::text as total from public.credit_balances where gang_id=$1', [gang]);
  expected = r.total;
}, 30000);
afterAll(async () => { await pool.end(); });

describe('WO-6.5a listGangCredits', () => {
  it('returns every positive wallet plus all active eligible members including zero/no wallet', async () => {
    h.userId = owner;
    const result = await listGangCredits(gang);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('credit list failed');
    expect(result.data.members).toHaveLength(1005);
    expect(new Set(result.data.members.map((m) => m.userId)).size).toBe(1005);
    expect(result.data.totalOwed).toBe(expected);
    expect(result.data.eligibleMembers).toHaveLength(1008); // owner plus 1007 members
    expect(new Set(result.data.eligibleMembers.map((m) => m.userId)).size).toBe(1008);
    for (const id of [owner, ...members.slice(1005)]) {
      expect(result.data.eligibleMembers.find((m) => m.userId === id)?.balance).toBe('0.00');
    }
    expect(result.data.members.every((m) => m.balance === '1.01')).toBe(true);
  });

  it('member and stranger denied; real RLS hides other-member wallets from member/outsider', async () => {
    for (const actor of [members[1006], stranger]) {
      h.userId = actor;
      const result = await listGangCredits(gang);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('FORBIDDEN');
      expect(await visibleCount(actor, 'select 1 from public.credit_balances where gang_id=$1', [gang])).toBe(0);
    }
    expect(await visibleCount(owner, 'select 1 from public.credit_balances where gang_id=$1', [gang])).toBe(1005);
  });

  it('query errors are never converted into successful empty lists', async () => {
    h.userId = owner;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const table of ['credit_balances', 'gang_members']) {
        h.failTable = table;
        const result = await listGangCredits(gang);
        expect(result.success).toBe(false);
      }
    } finally { h.failTable = ''; log.mockRestore(); }
  });
});
