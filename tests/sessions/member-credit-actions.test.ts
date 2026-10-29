/**
 * WO-B5a — server actions ของเครดิตสมาชิก (อ่านผ่าน can() + บันทึกโอนเกิน)
 * เรียก action จริงกับ DB local · mock เฉพาะ auth/headers/cache (แบบเดียวกับ close-breakdown.test.ts)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { pool, serviceClient, reloadPostgrestSchema } from '../helpers/db';

const h = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => serviceClient() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => serviceClient() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { getMyCredit, getMemberCredit, listGangCredits, recordOverpayment } from '@/server/actions/credit';

beforeAll(async () => {
  await reloadPostgrestSchema();
});
afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`cra-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function setup() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-${crypto.randomUUID()}`]);
  const add = async (role = 'member') => {
    const u = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`, [gang.id, u, role]);
    return u;
  };
  const member = await add();
  const other = await add();
  const admin = await add('admin');

  const pay = async (payer: string) => {
    const {
      rows: [p],
    } = await pool.query<{ id: string }>(
      `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, 150, $3) returning id`,
      [gang.id, payer, owner],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payer]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, owner]);
    return p.id;
  };
  return { gangId: gang.id, owner, member, other, admin, pay };
}

describe('WO-B5a — server actions เครดิต', () => {
  it('🔴 แอดมินบันทึกโอนเกิน → ผู้โอนเห็นยอดและรายการของตัวเอง · เงินเป็น string', async () => {
    const s = await setup();
    const payment = await s.pay(s.member);

    h.userId = s.admin;
    const rec = await recordOverpayment(payment, '50.50', 'โอน 200.50 แทน 150');
    expect(rec).toEqual({ success: true, data: { balanceAfter: '50.50' } });

    h.userId = s.member;
    const mine = await getMyCredit(s.gangId);
    expect(mine.success).toBe(true);
    if (mine.success) {
      expect(mine.data.balance).toBe('50.50');
      expect(mine.data.entries).toHaveLength(1);
      expect(mine.data.entries[0]).toMatchObject({
        type: 'overpayment',
        amount: '50.50',
        balanceAfter: '50.50',
        reason: 'โอน 200.50 แทน 150',
        paymentId: payment,
      });
    }

    // คนที่ไม่มีเครดิต → 0.00 ไม่ใช่ error
    h.userId = s.other;
    const none = await getMyCredit(s.gangId);
    expect(none.success && none.data.balance).toBe('0.00');
  });

  it('🔴 member บันทึกโอนเกินไม่ได้ (FORBIDDEN) · คนนอกก๊วนก็ไม่ได้ · รูปแบบจำนวนเงินผิด/ไม่มีเหตุผล = VALIDATION_ERROR', async () => {
    const s = await setup();
    const payment = await s.pay(s.member);

    for (const actor of [s.member, s.other, await newUser()]) {
      h.userId = actor;
      const res = await recordOverpayment(payment, '10.00', 'x');
      expect(res.success, actor).toBe(false);
      if (!res.success) expect(res.error.code).toBe('FORBIDDEN');
    }

    h.userId = s.admin;
    for (const [amount, reason] of [
      ['abc', 'x'],
      ['-5', 'x'],
      ['1.234', 'x'],
      ['10.00', '  '],
    ] as const) {
      const res = await recordOverpayment(payment, amount, reason);
      expect(res.success, amount).toBe(false);
      if (!res.success) expect(res.error.code).toBe('VALIDATION_ERROR');
    }
    h.userId = s.member;
    const mine = await getMyCredit(s.gangId);
    expect(mine.success && mine.data.balance).toBe('0.00');
  });

  it('getMemberCredit: แอดมินดูของคนอื่นได้ · member ดูของคนอื่นไม่ได้ · ดูของตัวเองผ่าน read.self', async () => {
    const s = await setup();
    h.userId = s.admin;
    await recordOverpayment(await s.pay(s.member), '20.00', 'ทดสอบ');

    h.userId = s.admin;
    const asAdmin = await getMemberCredit(s.gangId, s.member);
    expect(asAdmin.success && asAdmin.data.balance).toBe('20.00');

    h.userId = s.other;
    const denied = await getMemberCredit(s.gangId, s.member);
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('FORBIDDEN');

    h.userId = s.member;
    const self = await getMemberCredit(s.gangId, s.member);
    expect(self.success && self.data.balance).toBe('20.00');
  });

  it('listGangCredits: แอดมินเห็นเฉพาะคนที่มียอด > 0 + ผลรวม "เงินที่ก๊วนติดสมาชิก" · member ไม่ได้', async () => {
    const s = await setup();
    h.userId = s.admin;
    await recordOverpayment(await s.pay(s.member), '20.10', 'a');
    await recordOverpayment(await s.pay(s.other), '30.20', 'b');

    const list = await listGangCredits(s.gangId);
    expect(list.success).toBe(true);
    if (list.success) {
      expect(list.data.totalOwed).toBe('50.30');
      expect(list.data.members.map((m) => [m.userId, m.balance])).toEqual([
        [s.other, '30.20'],
        [s.member, '20.10'],
      ]);
    }

    h.userId = s.member;
    const denied = await listGangCredits(s.gangId);
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('FORBIDDEN');
  });
});
