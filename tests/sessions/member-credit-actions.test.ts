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

import {
  getMyCredit,
  getMemberCredit,
  listGangCredits,
  recordOverpayment,
  topUpCredit,
  payOutCredit,
  returnChargeToCredit,
} from '@/server/actions/credit';
import { leaveGang } from '@/server/actions/members';

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

  const pay = async (payer: string, excess?: string) => {
    const {
      rows: [p],
    } = await pool.query<{ id: string }>(
      `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, 150, $3) returning id`,
      [gang.id, payer, owner],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payer]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, owner]);
    // [Q1] แอดมินกรอกยอดที่โอนจริง = 150 + ส่วนเกิน
    if (excess) {
      await pool.query(`select public.set_payment_received_amount($1, 150 + $2::numeric, $3)`, [p.id, excess, owner]);
    }
    return p.id;
  };
  return { gangId: gang.id, owner, member, other, admin, pay };
}

describe('WO-B5a — server actions เครดิต', () => {
  it('🔴 แอดมินบันทึกโอนเกิน → ผู้โอนเห็นยอดและรายการของตัวเอง · เงินเป็น string', async () => {
    const s = await setup();
    const payment = await s.pay(s.member, '50.50');

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
    await recordOverpayment(await s.pay(s.member, '20.00'), '20.00', 'ทดสอบ');

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
    await recordOverpayment(await s.pay(s.member, '20.10'), '20.10', 'a');
    await recordOverpayment(await s.pay(s.other, '30.20'), '30.20', 'b');

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

describe('WO-B5b-2 — server actions ช่องเข้า/ออกของเครดิต', () => {
  it('🔴 แอดมินให้เครดิต → สมาชิกเห็นรายการ admin_topup · member ให้ไม่ได้ (FORBIDDEN) · ยอด/เหตุผลผิด = VALIDATION_ERROR', async () => {
    const s = await setup();

    h.userId = s.admin;
    const ok = await topUpCredit(s.gangId, s.member, '75.25', 'ชดเชยนัดที่ยกเลิก');
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.balanceAfter).toBe('75.25');

    h.userId = s.member;
    const mine = await getMyCredit(s.gangId);
    expect(mine.success && mine.data.entries[0]).toMatchObject({ type: 'admin_topup', amount: '75.25', seq: 1 });

    for (const actor of [s.member, s.other]) {
      h.userId = actor;
      const res = await topUpCredit(s.gangId, s.member, '10.00', 'x');
      expect(res.success, actor).toBe(false);
      if (!res.success) expect(res.error.code).toBe('FORBIDDEN');
    }
    h.userId = s.admin;
    for (const [amount, reason] of [
      ['abc', 'x'],
      ['-5', 'x'],
      ['10.00', '  '],
    ] as const) {
      const res = await topUpCredit(s.gangId, s.member, amount, reason);
      expect(res.success, amount).toBe(false);
      if (!res.success) expect(res.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('🔴 จ่ายคืนเงินสด: ≤ ยอดคงเหลือ · เกิน = INSUFFICIENT_CREDIT (code ใหม่ใน docs/errors.md) · member จ่ายคืนไม่ได้', async () => {
    const s = await setup();
    h.userId = s.admin;
    await topUpCredit(s.gangId, s.member, '50.00', 'ให้เครดิต');

    const over = await payOutCredit(s.gangId, s.member, '50.01', 'คืนเงิน');
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.code).toBe('INSUFFICIENT_CREDIT');

    const ok = await payOutCredit(s.gangId, s.member, '20.00', 'คืนเงินสดที่สนาม');
    expect(ok.success && ok.data.balanceAfter).toBe('30.00');

    h.userId = s.member;
    const denied = await payOutCredit(s.gangId, s.member, '1.00', 'x');
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('FORBIDDEN');
  });

  it('🔴 ย้ายยอดต้องคืนของ charge เข้าเครดิต: ลดหนี้ (credit) ก่อน แล้วย้าย · ซ้ำไม่ได้ · member ไม่ได้ · charge ไม่มีจริง = CHARGE_NOT_FOUND', async () => {
    const s = await setup();
    const {
      rows: [m],
    } = await pool.query<{ id: string }>(
      `select id from public.gang_members where gang_id = $1 and user_id = $2`,
      [s.gangId, s.member],
    );
    const {
      rows: [c],
    } = await pool.query<{ id: string }>(
      `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
       values ($1, 'monthly_fee', $2, '1985-01-01', 120) returning id`,
      [s.gangId, m.id],
    );
    const {
      rows: [p],
    } = await pool.query<{ id: string }>(`select id from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`, [
      s.gangId,
      s.member,
      [c.id],
      s.owner,
    ]);
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, s.member]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, s.owner]);
    await pool.query(`select public.add_payment_adjustment($1, 'credit', -120, 'ยกเลิกค่ารายเดือน', null, $2)`, [c.id, s.owner]);

    h.userId = s.member;
    const denied = await returnChargeToCredit(c.id, null, 'x');
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('FORBIDDEN');

    h.userId = s.admin;
    const ok = await returnChargeToCredit(c.id, null, 'ย้ายเข้าเครดิต');
    expect(ok.success && ok.data.balanceAfter).toBe('120.00');

    const again = await returnChargeToCredit(c.id, null, 'ซ้ำ');
    expect(again.success).toBe(false);
    if (!again.success) expect(again.error.code).toBe('VALIDATION_ERROR');

    const missing = await returnChargeToCredit(crypto.randomUUID(), null, 'x');
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.code).toBe('CHARGE_NOT_FOUND');

    h.userId = s.member;
    const mine = await getMyCredit(s.gangId);
    expect(mine.success && mine.data.balance).toBe('120.00');
    expect(mine.success && mine.data.entries[0]).toMatchObject({ type: 'charge_return', amount: '120.00' });
  });
});

describe('WO-B5b-3 — leaveGang action คืนยอดเครดิตสุทธิ', () => {
  it('🔴 ออกจากก๊วนพร้อมเครดิต+หนี้ ⇒ creditApplied/creditBalance/outstandingAmount เป็น string ตรงกับ DB', async () => {
    const s = await setup();
    const {
      rows: [m],
    } = await pool.query<{ id: string }>(`select id from public.gang_members where gang_id = $1 and user_id = $2`, [s.gangId, s.member]);
    await pool.query(
      `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
       values ($1, 'monthly_fee', $2, '1955-01-01', 60)`,
      [s.gangId, m.id],
    );
    h.userId = s.admin;
    await topUpCredit(s.gangId, s.member, '100.00', 'ชดเชย');

    h.userId = s.member;
    const res = await leaveGang(s.gangId);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toMatchObject({
        creditApplied: '60.00',
        creditBalance: '40.00',
        outstandingCharges: 0,
        outstandingAmount: '0.00',
      });
    }
  });
});
