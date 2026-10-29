/**
 * WO-B5a DoD (ADR-010) — เครดิตสมาชิก: credit_ledger · apply_credit · หักอัตโนมัติเมื่อมีหนี้ใหม่
 *
 *   1. ledger append-only + CHECK (ติดลบ/เครื่องหมายผิดไม่ได้)
 *   2. record_overpayment: สิทธิ์แอดมิน · สลิปต้อง verified · หนึ่งสลิปครั้งเดียว
 *   3. apply_credit: ไม่เกินหนี้ · ไม่เกินเครดิต · เฉพาะ charge ของตัวเอง · ledger ยอดค้างเดิมตรงหลังหัก
 *   4. หักอัตโนมัติ: close_session_with_charges + commit_monthly_fees (ไม่แก้สองฟังก์ชัน) · guest ข้าม
 *   5. concurrency: ยอดไม่ติดลบภายใต้ apply_credit พร้อมกัน 20 รอบ · โอนเกินซ้ำพร้อมกัน · ปิดรอบสองนัดพร้อมกันไม่ deadlock
 *   6. RLS + EXECUTE matrix
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, runConcurrently } from '../helpers/db';
import { ledgerLineOf } from '@/domain/billing/ledger';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`cr-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

type Gang = { gangId: string; owner: string };

async function newGang(): Promise<Gang> {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนเครดิต-${crypto.randomUUID()}`,
  ]);
  return { gangId: gang.id, owner };
}

type Member = { userId: string; memberId: string };

async function addMember(gangId: string, role = 'member'): Promise<Member> {
  const userId = await newUser();
  const {
    rows: [m],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3) returning id`,
    [gangId, userId, role],
  );
  return { userId, memberId: m.id };
}

let monthCounter = 0;

/** หนี้ก้อนหนึ่งของสมาชิก (monthly_fee — เดือนไม่ซ้ำ) · ⚠️ ผ่าน trigger หักอัตโนมัติถ้าสมาชิกมีเครดิตอยู่ */
async function charge(gangId: string, memberId: string, amount: string): Promise<string> {
  const month = new Date(Date.UTC(2020, monthCounter++, 1)).toISOString().slice(0, 10);
  const {
    rows: [c],
  } = await pool.query<{ id: string }>(
    `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
     values ($1, 'monthly_fee', $2, $3::date, $4) returning id`,
    [gangId, memberId, month, amount],
  );
  return c.id;
}

async function verifiedPayment(gangId: string, payer: string, amount: string, actor: string): Promise<string> {
  const {
    rows: [p],
  } = await pool.query<{ id: string }>(
    `insert into public.payments (gang_id, payer_user_id, amount, created_by)
     values ($1, $2, $3, $4) returning id`,
    [gangId, payer, amount, actor],
  );
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payer]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, actor]);
  return p.id;
}

/** ให้เครดิต `amount` แก่สมาชิกผ่านทางจริง (สลิป verified → โอนเกิน) */
async function giveCredit(g: Gang, userId: string, amount: string): Promise<string> {
  const paymentId = await verifiedPayment(g.gangId, userId, '1.00', g.owner);
  await pool.query(`select public.record_overpayment($1, $2, 'ทดสอบโอนเกิน', $3)`, [
    paymentId,
    amount,
    g.owner,
  ]);
  return paymentId;
}

const outstanding = async (chargeId: string) =>
  (await pool.query<{ o: string }>(`select public.charge_outstanding($1)::text o`, [chargeId])).rows[0].o;

const balanceCache = async (gangId: string, userId: string) =>
  (
    await pool.query<{ b: string }>(
      `select balance::text b from public.credit_balances where gang_id = $1 and user_id = $2`,
      [gangId, userId],
    )
  ).rows[0]?.b ?? '0.00';

const balanceDerived = async (gangId: string, userId: string) =>
  (
    await pool.query<{ b: string }>(`select public.credit_balance_of($1, $2)::text b`, [gangId, userId])
  ).rows[0].b;

/** 🔴 invariant ของเครดิต: cache = Σ ledger · ≥ 0 · balance_after ของแถวสุดท้าย = ยอด · ทุกแถวเดินต่อกันถูก */
async function expectCreditConsistent(gangId: string, userId: string, note = '') {
  const cache = await balanceCache(gangId, userId);
  const derived = await balanceDerived(gangId, userId);
  expect(cache, `cache = Σ ledger ${note}`).toBe(derived);
  expect(toSatang(derived), `≥ 0 ${note}`).toBeGreaterThanOrEqual(0);

  const { rows } = await pool.query<{ amount: string; balance_after: string }>(
    `select amount::text, balance_after::text from public.credit_ledger
      where gang_id = $1 and user_id = $2 order by created_at, id`,
    [gangId, userId],
  );
  let running = 0;
  for (const r of rows) {
    running += toSatang(r.amount);
    expect(toSatang(r.balance_after), `balance_after ต่อเนื่อง ${note}`).toBe(running);
  }
  expect(fromSatang(running)).toBe(derived);
}

const applyCredit = (g: Gang, userId: string, ids: string[] | null = null, actor: string | null = null) =>
  pool
    .query<{ r: { applied: string; remaining: string; payment_id: string | null; charge_count: number } }>(
      `select public.apply_credit($1, $2, $3::uuid[], $4) r`,
      [g.gangId, userId, ids, actor],
    )
    .then((x) => x.rows[0].r);

// ---------------------------------------------------------------------------
// 1. schema: append-only + CHECK
// ---------------------------------------------------------------------------

describe('WO-B5a — credit_ledger เป็น append-only', () => {
  it('🔴 UPDATE / DELETE / TRUNCATE ไม่ได้แม้เป็น superuser (trigger กัน)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await giveCredit(g, m.userId, '50.00');

    await expect(
      pool.query(`update public.credit_ledger set amount = 999 where user_id = $1`, [m.userId]),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      pool.query(`delete from public.credit_ledger where user_id = $1`, [m.userId]),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(pool.query(`truncate public.credit_ledger`)).rejects.toThrow(/FORBIDDEN/);
    await expectCreditConsistent(g.gangId, m.userId);
  });

  it('CHECK: balance_after ติดลบไม่ได้ · เครื่องหมายต้องตรงชนิด · ต้องมี payment · โอนเกินต้องมีเหตุผล', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await verifiedPayment(g.gangId, m.userId, '10.00', g.owner);
    const ins = (type: string, amount: string, after: string, reason: string | null, payment: string | null) =>
      pool.query(
        `insert into public.credit_ledger (gang_id, user_id, type, amount, balance_after, payment_id, reason)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [g.gangId, m.userId, type, amount, after, payment, reason],
      );

    await expect(ins('applied', '-10', '-5', null, pay)).rejects.toThrow(/balance_after/);
    await expect(ins('overpayment', '-10', '0', 'x', pay)).rejects.toThrow(/sign_matches_type/);
    await expect(ins('applied', '10', '10', null, pay)).rejects.toThrow(/sign_matches_type/);
    await expect(ins('overpayment', '10', '10', 'x', null)).rejects.toThrow(/payment_required/);
    await expect(ins('overpayment', '10', '10', '  ', pay)).rejects.toThrow(/overpayment_reason/);
    await expect(ins('refund', '-10', '0', null, pay)).rejects.toThrow(/check constraint/);

    await expect(
      pool.query(`update public.credit_balances set balance = -1 where user_id = $1`, [m.userId]),
    ).resolves.toBeDefined(); // ยังไม่มีแถว → 0 แถว ไม่ error
    await giveCredit(g, m.userId, '5.00');
    await expect(
      pool.query(`update public.credit_balances set balance = -1 where user_id = $1`, [m.userId]),
    ).rejects.toThrow(/balance_check|credit_balances/);
  });

  it('payment_allocations.source: แถวเดิมเป็น transfer · ค่าอื่นนอก transfer/credit ไม่ได้', async () => {
    const { rows } = await pool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'payment_allocations' and column_name = 'source'`,
    );
    expect(rows[0].column_default).toContain('transfer');

    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    const pay = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);
    await expect(
      pool.query(
        `insert into public.payment_allocations (payment_id, session_charge_id, amount, source)
         values ($1, $2, 10, 'bonus')`,
        [pay, c],
      ),
    ).rejects.toThrow(/source/);
  });
});

// ---------------------------------------------------------------------------
// 2. record_overpayment
// ---------------------------------------------------------------------------

describe('WO-B5a — record_overpayment (โอนเกิน · แอดมินยืนยัน)', () => {
  it('แอดมินบันทึก → เครดิตเข้าให้ผู้โอน · ledger + cache ตรงกัน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await verifiedPayment(g.gangId, m.userId, '150.00', g.owner);

    const {
      rows: [row],
    } = await pool.query<{ type: string; amount: string; balance_after: string; user_id: string }>(
      `select type, amount::text, balance_after::text, user_id
         from public.record_overpayment($1, 50, 'โอน 200 แทน 150', $2)`,
      [pay, g.owner],
    );
    expect(row).toEqual({ type: 'overpayment', amount: '50.00', balance_after: '50.00', user_id: m.userId });
    expect(await balanceCache(g.gangId, m.userId)).toBe('50.00');
    await expectCreditConsistent(g.gangId, m.userId);

    // ส่วนเกินสลิปใหม่ → ทบยอด
    const pay2 = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);
    await pool.query(`select public.record_overpayment($1, 25.50, 'อีกครั้ง', $2)`, [pay2, g.owner]);
    expect(await balanceCache(g.gangId, m.userId)).toBe('75.50');
    await expectCreditConsistent(g.gangId, m.userId);
  });

  it('🔴 member ธรรมดา / actor ว่าง / แอดมินก๊วนอื่น → FORBIDDEN · ไม่มีเครดิตเกิด', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const other = await addMember(g.gangId);
    const foreignAdmin = (await newGang()).owner;
    const pay = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);

    for (const actor of [other.userId, m.userId, null, foreignAdmin]) {
      await expect(
        pool.query(`select public.record_overpayment($1, 10, 'x', $2)`, [pay, actor]),
        String(actor),
      ).rejects.toThrow(/FORBIDDEN/);
    }
    expect(await balanceCache(g.gangId, m.userId)).toBe('0.00');
  });

  it('สลิปยังไม่ verified / ไม่มีสลิป / ผู้โอนออกจากก๊วนแล้ว / ยอดไม่ถูกต้อง / ไม่มีเหตุผล → ปฏิเสธ', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);

    const {
      rows: [pending],
    } = await pool.query<{ id: string }>(
      `insert into public.payments (gang_id, payer_user_id, amount) values ($1, $2, 100) returning id`,
      [g.gangId, m.userId],
    );
    await expect(
      pool.query(`select public.record_overpayment($1, 10, 'x', $2)`, [pending.id, g.owner]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(
      pool.query(`select public.record_overpayment($1, 10, 'x', $2)`, [crypto.randomUUID(), g.owner]),
    ).rejects.toThrow(/PAYMENT_NOT_FOUND/);

    const ok = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);
    for (const amount of ['0', '-5', '1.005']) {
      await expect(
        pool.query(`select public.record_overpayment($1, $2, 'x', $3)`, [ok, amount, g.owner]),
        amount,
      ).rejects.toThrow(/VALIDATION_ERROR/);
    }
    await expect(
      pool.query(`select public.record_overpayment($1, 10, '   ', $2)`, [ok, g.owner]),
    ).rejects.toThrow(/VALIDATION_ERROR/);

    await pool.query(`select public.leave_gang($1, $2)`, [g.gangId, m.userId]);
    await expect(
      pool.query(`select public.record_overpayment($1, 10, 'x', $2)`, [ok, g.owner]),
    ).rejects.toThrow(/NOT_GANG_MEMBER/);
    expect(await balanceCache(g.gangId, m.userId)).toBe('0.00');
  });

  it('🔴 สลิปเดียวบันทึกซ้ำไม่ได้ (เครดิตไม่เบิ้ล)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);
    await pool.query(`select public.record_overpayment($1, 30, 'ครั้งแรก', $2)`, [pay, g.owner]);
    let detail = '';
    await expect(
      pool.query(`select public.record_overpayment($1, 30, 'ซ้ำ', $2)`, [pay, g.owner]).catch((e: { detail?: string }) => {
        detail = e.detail ?? '';
        throw e;
      }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
    expect(detail).toContain('สลิปนี้บันทึกยอดโอนเกินไปแล้ว');
    expect(await balanceCache(g.gangId, m.userId)).toBe('30.00');
  });

  it('🔴 กดพร้อมกัน 4 ทาง × 10 รอบ → สำเร็จใบเดียว เครดิตไม่เบิ้ล', async () => {
    for (let i = 0; i < 10; i++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const pay = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);

      const results = await runConcurrently(4, (c) =>
        c.query(`select public.record_overpayment($1, 40, 'พร้อมกัน', $2)`, [pay, g.owner]),
      );
      expect(results.filter((r) => r.status === 'fulfilled'), `round ${i}`).toHaveLength(1);
      expect(await balanceCache(g.gangId, m.userId), `round ${i}`).toBe('40.00');
      await expectCreditConsistent(g.gangId, m.userId, `round ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. apply_credit
// ---------------------------------------------------------------------------

describe('WO-B5a — apply_credit: ไม่เกินหนี้ · ไม่เกินเครดิต · ledger ยอดค้างตรง', () => {
  it('เครดิต < หนี้ → หักหมดเครดิต หนี้เหลือ · allocation source=credit · payment verified', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '150.00');
    await giveCredit(g, m.userId, '40.00');

    const r = await applyCredit(g, m.userId, [c], g.owner);
    expect(r.applied).toBe('40.00');
    expect(r.remaining).toBe('0.00');
    expect(r.charge_count).toBe(1);

    expect(await outstanding(c)).toBe('110.00');
    expect(await balanceCache(g.gangId, m.userId)).toBe('0.00');
    await expectCreditConsistent(g.gangId, m.userId);

    const { rows: alloc } = await pool.query<{ source: string; amount: string; status: string; payer: string }>(
      `select a.source, a.amount::text, p.status, p.payer_user_id payer
         from public.payment_allocations a join public.payments p on p.id = a.payment_id
        where a.session_charge_id = $1`,
      [c],
    );
    expect(alloc).toEqual([{ source: 'credit', amount: '40.00', status: 'verified', payer: m.userId }]);
  });

  it('เครดิต > หนี้ → หักเท่าหนี้ เหลือเครดิต · เรียกซ้ำไม่หักเพิ่ม (หนี้ 0 แล้ว)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '150.00');
    await giveCredit(g, m.userId, '500.00');

    const r = await applyCredit(g, m.userId, [c]);
    expect(r.applied).toBe('150.00');
    expect(r.remaining).toBe('350.00');
    expect(await outstanding(c)).toBe('0.00');

    const again = await applyCredit(g, m.userId, [c]);
    expect(again.applied).toBe('0.00');
    expect(again.payment_id).toBeNull();
    expect(await balanceCache(g.gangId, m.userId)).toBe('350.00');
    await expectCreditConsistent(g.gangId, m.userId);
  });

  it('หลาย charge → เรียงเก่า→ใหม่ จนเครดิตหมด (ไม่ระบุ id = ทุกหนี้ที่ค้าง)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c1 = await charge(g.gangId, m.memberId, '100.00');
    const c2 = await charge(g.gangId, m.memberId, '100.00');
    const c3 = await charge(g.gangId, m.memberId, '100.00');
    await giveCredit(g, m.userId, '250.00');

    const r = await applyCredit(g, m.userId);
    expect(r.applied).toBe('250.00');
    expect(r.charge_count).toBe(3);
    expect(await outstanding(c1)).toBe('0.00');
    expect(await outstanding(c2)).toBe('0.00');
    expect(await outstanding(c3)).toBe('50.00');
    await expectCreditConsistent(g.gangId, m.userId);
  });

  it('🔴 ใช้กับ charge ของคนอื่น / ข้ามก๊วน ไม่ได้ → CHARGE_NOT_FOUND · เครดิตไม่ขยับ', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const b = await addMember(g.gangId);
    const bCharge = await charge(g.gangId, b.memberId, '100.00');
    const foreign = await newGang();
    const fm = await addMember(foreign.gangId);
    const fCharge = await charge(foreign.gangId, fm.memberId, '100.00');
    await giveCredit(g, a.userId, '100.00');

    await expect(applyCredit(g, a.userId, [bCharge])).rejects.toThrow(/CHARGE_NOT_FOUND/);
    await expect(applyCredit(g, a.userId, [fCharge])).rejects.toThrow(/CHARGE_NOT_FOUND/);
    expect(await balanceCache(g.gangId, a.userId)).toBe('100.00');
    expect(await outstanding(bCharge)).toBe('100.00');
  });

  it('ไม่มีเครดิต → ไม่เกิดอะไร (ไม่มี payment ไม่มี allocation)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    const r = await applyCredit(g, m.userId, [c]);
    expect(r.applied).toBe('0.00');
    const { rows } = await pool.query(`select 1 from public.payment_allocations where session_charge_id = $1`, [c]);
    expect(rows).toHaveLength(0);
  });

  it('🔴 ledger ยอดค้างเดิม (domain ledgerLineOf) ตรงกับ charge_outstanding() หลังหักเครดิต + มี adjustment ผสม', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '200.00');
    await giveCredit(g, m.userId, '60.00');
    await applyCredit(g, m.userId, [c]);
    // payment_adjustments type='credit' (ปรับลดหนี้ก้อนเดียว) อยู่ร่วมกันได้ ไม่เกี่ยวกับ credit_ledger
    await pool.query(`select public.add_payment_adjustment($1, 'credit', -20, 'ลดให้', null, $2)`, [c, g.owner]);

    const { rows: alloc } = await pool.query<{ amount: string }>(
      `select a.amount::text from public.payment_allocations a join public.payments p on p.id = a.payment_id
        where a.session_charge_id = $1 and p.status = 'verified'`,
      [c],
    );
    const { rows: adj } = await pool.query<{ amount: string }>(
      `select amount::text from public.payment_adjustments where session_charge_id = $1`,
      [c],
    );
    const line = ledgerLineOf({
      chargeId: c,
      amount: '200.00',
      allocated: alloc.map((a) => a.amount),
      adjustments: adj.map((a) => a.amount),
    });
    expect(line.outstanding).toBe('120.00'); // 200 − 60(credit) − 20(adjustment)
    expect(await outstanding(c)).toBe(line.outstanding);
    // เครดิตสมาชิกไม่ถูกแตะโดย adjustment
    expect(await balanceCache(g.gangId, m.userId)).toBe('0.00');
    await expectCreditConsistent(g.gangId, m.userId);
  });

  it('"เก็บได้จริง" แยกได้: Σ allocation source=transfer ไม่รวมส่วนที่จ่ายด้วยเครดิต', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '150.00');
    await giveCredit(g, m.userId, '50.00');
    await applyCredit(g, m.userId, [c]); // credit 50
    const cash = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);
    await pool.query(
      `insert into public.payment_allocations (payment_id, session_charge_id, amount) values ($1, $2, 100)`,
      [cash, c],
    );

    expect(await outstanding(c)).toBe('0.00');
    const { rows } = await pool.query<{ source: string; total: string }>(
      `select a.source, sum(a.amount)::text total
         from public.payment_allocations a join public.payments p on p.id = a.payment_id
        where a.session_charge_id = $1 and p.status = 'verified' group by a.source order by a.source`,
      [c],
    );
    expect(rows).toEqual([
      { source: 'credit', total: '50.00' },
      { source: 'transfer', total: '100.00' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. หักอัตโนมัติ
// ---------------------------------------------------------------------------

/** นัด flat_rate 150 ที่เล่นจบแล้ว — คืน registration ของแต่ละคน (null = guest) */
async function playedSession(g: Gang, people: (string | null)[]) {
  const snapshot = {
    snapshot_version: 1,
    pricing_plan: { id: null, name: 'เหมาจ่าย', type: 'flat_rate', params: { amount_per_person: '150.00' } },
    rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
    promptpay_id: '0812345678',
    cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' },
    skill_levels: [],
  };
  const {
    rows: [s],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'เครดิต', now() - interval '3 hours', now() - interval '1 hour', $2, $3::jsonb, $4) returning id`,
    [g.gangId, people.length + 4, JSON.stringify(snapshot), g.owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [s.id, g.owner]);

  const regs: string[] = [];
  for (const userId of people) {
    let regId: string;
    if (userId === null) {
      const {
        rows: [r],
      } = await pool.query<{ id: string }>(
        `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
         values ($1, 'แขก', 'confirmed', 0, $2) returning id`,
        [s.id, g.owner],
      );
      regId = r.id;
    } else {
      const {
        rows: [r],
      } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [s.id, userId]);
      regId = r.id;
    }
    await pool.query(`select public.check_in_registration($1, $2)`, [regId, g.owner]);
    regs.push(regId);
  }
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [s.id, g.owner]);
  return { sessionId: s.id, regs };
}

const closeWith = (g: Gang, sessionId: string, regs: string[], amount = '150.00', status = 'in_play') =>
  pool.query(`select public.close_session_with_charges($1, $2::jsonb, $3, 'billing', $4)`, [
    sessionId,
    JSON.stringify(regs.map((id) => ({ registration_id: id, amount, breakdown: { reason: 'attended' } }))),
    status,
    g.owner,
  ]);

const chargeOfReg = async (regId: string) =>
  (await pool.query<{ id: string }>(`select id from public.session_charges where registration_id = $1`, [regId]))
    .rows[0].id;

describe('WO-B5a — หักอัตโนมัติเมื่อมีหนี้ใหม่', () => {
  it('🔴 ปิดรอบ: เครดิต 100 vs หนี้ 150 → เหลือค้าง 50 · เครดิต 500 → หนี้ 0 เหลือ 350 · guest ข้าม · คนไม่มีเครดิตไม่ถูกแตะ', async () => {
    const g = await newGang();
    const poor = await addMember(g.gangId); // เครดิต 100
    const rich = await addMember(g.gangId); // เครดิต 500
    const none = await addMember(g.gangId); // ไม่มีเครดิต
    await giveCredit(g, poor.userId, '100.00');
    await giveCredit(g, rich.userId, '500.00');

    const s = await playedSession(g, [poor.userId, rich.userId, none.userId, null]);
    await closeWith(g, s.sessionId, s.regs);

    const [cPoor, cRich, cNone, cGuest] = await Promise.all(s.regs.map(chargeOfReg));
    expect(await outstanding(cPoor)).toBe('50.00');
    expect(await outstanding(cRich)).toBe('0.00');
    expect(await outstanding(cNone)).toBe('150.00');
    expect(await outstanding(cGuest)).toBe('150.00');

    expect(await balanceCache(g.gangId, poor.userId)).toBe('0.00');
    expect(await balanceCache(g.gangId, rich.userId)).toBe('350.00');
    await expectCreditConsistent(g.gangId, poor.userId);
    await expectCreditConsistent(g.gangId, rich.userId);

    const { rows } = await pool.query<{ source: string; n: string }>(
      `select a.source, count(*)::text n from public.payment_allocations a
         join public.session_charges c on c.id = a.session_charge_id
        where c.session_id = $1 group by a.source`,
      [s.sessionId],
    );
    expect(rows).toEqual([{ source: 'credit', n: '2' }]);

    // ยอดรวมของนัด (charges) ไม่ถูกแก้ — ADR-001: การหักเกิดที่ ledger ไม่ใช่ที่ amount
    const { rows: total } = await pool.query<{ t: string }>(
      `select sum(amount)::text t from public.session_charges where session_id = $1`,
      [s.sessionId],
    );
    expect(total[0].t).toBe('600.00');
  });

  it('ค่าสมาชิกรายเดือน (commit_monthly_fees) ถูกหักด้วย · รันซ้ำ (idempotent) ไม่หักซ้ำ', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await giveCredit(g, m.userId, '1000.00');

    const fees = JSON.stringify([{ gang_member_id: m.memberId, amount: '300.00', breakdown: {} }]);
    await pool.query(`select * from public.commit_monthly_fees($1, '2031-03-01'::date, $2::jsonb, $3)`, [
      g.gangId,
      fees,
      g.owner,
    ]);
    const { rows: [fee] } = await pool.query<{ id: string }>(
      `select id from public.session_charges where gang_member_id = $1 and billing_month = '2031-03-01'`,
      [m.memberId],
    );
    expect(await outstanding(fee.id)).toBe('0.00');
    expect(await balanceCache(g.gangId, m.userId)).toBe('700.00');

    await pool.query(`select * from public.commit_monthly_fees($1, '2031-03-01'::date, $2::jsonb, $3)`, [
      g.gangId,
      fees,
      g.owner,
    ]);
    expect(await balanceCache(g.gangId, m.userId)).toBe('700.00');
    await expectCreditConsistent(g.gangId, m.userId);
  });

  it('เครดิตของก๊วนอื่นไม่ถูกใช้: สมาชิกสองก๊วน — หักเฉพาะก๊วนที่เกิดหนี้', async () => {
    const g1 = await newGang();
    const g2 = await newGang();
    const u = await newUser();
    const m1 = (await pool.query<{ id: string }>(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
      [g1.gangId, u],
    )).rows[0].id;
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [g2.gangId, u]);
    await giveCredit(g2, u, '300.00'); // เครดิตอยู่ก๊วน 2

    const c = await charge(g1.gangId, m1, '100.00'); // หนี้เกิดที่ก๊วน 1
    expect(await outstanding(c)).toBe('100.00');
    expect(await balanceCache(g2.gangId, u)).toBe('300.00');
  });

  it('หนี้ที่ค้างอยู่ก่อนมีเครดิตไม่ถูกหักเอง (ต้องเรียก apply_credit เอง)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const old = await charge(g.gangId, m.memberId, '100.00');
    await giveCredit(g, m.userId, '100.00');
    expect(await outstanding(old)).toBe('100.00');

    const fresh = await charge(g.gangId, m.memberId, '60.00');
    expect(await outstanding(fresh)).toBe('0.00'); // หนี้ใหม่ถูกหัก
    expect(await outstanding(old)).toBe('100.00'); // หนี้เก่ายังค้าง
    expect(await balanceCache(g.gangId, m.userId)).toBe('40.00');
  });

  it('close_session_with_charges ซ้ำ (CHARGES_ALREADY_COMMITTED) ไม่ทำให้เครดิตถูกหักซ้ำ', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await giveCredit(g, m.userId, '400.00');
    const s = await playedSession(g, [m.userId]);
    await closeWith(g, s.sessionId, s.regs);
    expect(await balanceCache(g.gangId, m.userId)).toBe('250.00');

    await expect(closeWith(g, s.sessionId, s.regs, '150.00', 'billing')).rejects.toThrow();
    expect(await balanceCache(g.gangId, m.userId)).toBe('250.00');
  });
});

// ---------------------------------------------------------------------------
// 5. concurrency
// ---------------------------------------------------------------------------

describe('WO-B5a — concurrency', () => {
  it('🔴 apply_credit พร้อมกัน 4 ทาง × 20 รอบ → ยอดไม่ติดลบ · หักรวมไม่เกินเครดิต · allocation ตรงกับ ledger', async () => {
    for (let i = 0; i < 20; i++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const charges: string[] = [];
      for (let k = 0; k < 4; k++) charges.push(await charge(g.gangId, m.memberId, '80.00'));
      await giveCredit(g, m.userId, '100.00');

      const results = await runConcurrently(4, (c, idx) =>
        c.query(`select public.apply_credit($1, $2, $3::uuid[], $4) r`, [g.gangId, m.userId, [charges[idx]], g.owner]),
      );
      for (const r of results) expect(r.status, `round ${i}`).toBe('fulfilled');

      expect(await balanceCache(g.gangId, m.userId), `round ${i}`).toBe('0.00');
      await expectCreditConsistent(g.gangId, m.userId, `round ${i}`);

      const outs = await Promise.all(charges.map(outstanding));
      for (const o of outs) expect(toSatang(o), `round ${i} หนี้ไม่ติดลบ`).toBeGreaterThanOrEqual(0);
      const paid = sumSatang(outs.map((o) => 8000 - toSatang(o)));
      expect(fromSatang(paid), `round ${i} หักรวม = เครดิต`).toBe('100.00');
    }
  });

  it('apply_credit แข่งกับ record_overpayment → cache = Σ ledger เสมอ · ไม่ติดลบ', async () => {
    for (let i = 0; i < 10; i++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const c = await charge(g.gangId, m.memberId, '120.00');
      await giveCredit(g, m.userId, '50.00');
      const pay = await verifiedPayment(g.gangId, m.userId, '100.00', g.owner);

      await runConcurrently(3, (cl, idx) =>
        idx === 0
          ? cl.query(`select public.record_overpayment($1, 70, 'แข่ง', $2)`, [pay, g.owner])
          : cl.query(`select public.apply_credit($1, $2, $3::uuid[], $4)`, [g.gangId, m.userId, [c], g.owner]),
      );
      await expectCreditConsistent(g.gangId, m.userId, `round ${i}`);
      expect(toSatang(await outstanding(c))).toBeGreaterThanOrEqual(0);
    }
  });

  it('🔴 ปิดรอบสองนัดของก๊วนเดียวกันพร้อมกัน (คนทับกัน เรียงคนละลำดับ) → ไม่ deadlock · เครดิตไม่ติดลบ', async () => {
    for (let i = 0; i < 10; i++) {
      const g = await newGang();
      const users: Member[] = [];
      for (let k = 0; k < 4; k++) users.push(await addMember(g.gangId));
      for (const u of users) await giveCredit(g, u.userId, '200.00');

      const ids = users.map((u) => u.userId);
      const s1 = await playedSession(g, ids);
      const s2 = await playedSession(g, [...ids].reverse());

      const results = await runConcurrently(2, (c, idx) => {
        const s = idx === 0 ? s1 : s2;
        return c.query(`select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`, [
          s.sessionId,
          JSON.stringify(s.regs.map((id) => ({ registration_id: id, amount: '150.00', breakdown: {} }))),
          g.owner,
        ]);
      });

      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason.code, `round ${i}: ${r.reason.message}`).not.toBe('40P01');
        expect(r.status, `round ${i}`).toBe('fulfilled');
      }
      for (const u of users) {
        // เครดิต 200 − (150 + 150) → หนี้รวม 300 ต้องหักได้สูงสุด 200
        expect(await balanceCache(g.gangId, u.userId), `round ${i}`).toBe('0.00');
        await expectCreditConsistent(g.gangId, u.userId, `round ${i}`);
      }
      const { rows } = await pool.query<{ o: string }>(
        `select sum(public.charge_outstanding(id))::text o from public.session_charges
          where session_id in ($1, $2)`,
        [s1.sessionId, s2.sessionId],
      );
      // หนี้รวม 8 ก้อน × 150 = 1200 · หักด้วยเครดิต 4 × 200 = 800 → ค้าง 400
      expect(rows[0].o, `round ${i}`).toBe('400.00');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. RLS + EXECUTE
// ---------------------------------------------------------------------------

describe('WO-B5a — RLS + EXECUTE matrix', () => {
  it('🔴 สมาชิกเห็นเครดิตของตัวเองเท่านั้น · แอดมินเห็นทั้งก๊วน · คนนอก/ผู้ออกเห็นไม่ได้', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const b = await addMember(g.gangId);
    const leaver = await addMember(g.gangId);
    await giveCredit(g, a.userId, '10.00');
    await giveCredit(g, b.userId, '20.00');
    await giveCredit(g, leaver.userId, '30.00');
    await pool.query(`select public.leave_gang($1, $2)`, [g.gangId, leaver.userId]);
    const outsider = await newUser();

    const seen = (userId: string, table: string) =>
      asRole('authenticated', userId, async (c) => {
        const { rows } = await c.query<{ user_id: string }>(
          `select user_id from public.${table} where gang_id = $1 order by user_id`,
          [g.gangId],
        );
        return rows.map((r) => r.user_id).sort();
      });

    for (const table of ['credit_ledger', 'credit_balances']) {
      expect(await seen(a.userId, table), `${table} a`).toEqual([a.userId]);
      expect(await seen(b.userId, table), `${table} b`).toEqual([b.userId]);
      expect(await seen(g.owner, table), `${table} admin`).toEqual([a.userId, b.userId, leaver.userId].sort());
      expect(await seen(outsider, table), `${table} outsider`).toEqual([]);
      expect(await seen(leaver.userId, table), `${table} leaver`).toEqual([]);
    }
    // anon ไม่เห็นอะไรเลย (ไม่มี grant) — แยก transaction ต่อ query เพราะ error ทำให้ txn abort
    for (const table of ['credit_ledger', 'credit_balances']) {
      await asRole('anon', null, async (c) => {
        await expect(c.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it('🔴 authenticated เขียนตรงไม่ได้ (INSERT/UPDATE/DELETE ทั้งสองตาราง) แม้เป็นเจ้าของยอด/แอดมิน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await giveCredit(g, m.userId, '10.00');
    const pay = await verifiedPayment(g.gangId, m.userId, '10.00', g.owner);

    for (const actor of [m.userId, g.owner]) {
      await asRole('authenticated', actor, async (c) => {
        await expect(
          c.query(
            `insert into public.credit_ledger (gang_id, user_id, type, amount, balance_after, payment_id, reason)
             values ($1, $2, 'overpayment', 999, 999, $3, 'โกง')`,
            [g.gangId, m.userId, pay],
          ),
        ).rejects.toThrow(/permission denied/);
      });
      await asRole('authenticated', actor, async (c) => {
        await expect(
          c.query(`update public.credit_balances set balance = 999 where user_id = $1`, [m.userId]),
        ).rejects.toThrow(/permission denied/);
      });
      await asRole('authenticated', actor, async (c) => {
        await expect(c.query(`delete from public.credit_ledger where user_id = $1`, [m.userId])).rejects.toThrow(
          /permission denied/,
        );
      });
    }
    expect(await balanceCache(g.gangId, m.userId)).toBe('10.00');
  });

  it('🔴 EXECUTE: anon/authenticated เรียกฟังก์ชันเครดิตไม่ได้ · service_role เรียกได้เฉพาะ 3 ตัวหลัก', async () => {
    const { rows } = await pool.query<{ fn: string; role: string; ok: boolean }>(
      `select p.proname fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('apply_credit', 'record_overpayment', 'credit_balance_of',
                            'session_charges_auto_apply_credit', 'credit_ledger_forbid_change')`,
    );
    expect(rows).toHaveLength(15);
    for (const r of rows) {
      if (r.role === 'anon' || r.role === 'authenticated') expect(r.ok, `${r.fn} → ${r.role}`).toBe(false);
    }
    for (const fn of ['apply_credit', 'record_overpayment', 'credit_balance_of']) {
      expect(rows.find((r) => r.fn === fn && r.role === 'service_role')!.ok, fn).toBe(true);
    }
  });

  it('🔴 service_role อ่านตารางเครดิตได้อย่างเดียว — เขียนตรงไม่ได้ (เขียนผ่าน DB function เท่านั้น)', async () => {
    const { rows } = await pool.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'service_role' and table_name in ('credit_ledger', 'credit_balances')
        order by 1, 2`,
    );
    expect(rows).toEqual([
      { table_name: 'credit_balances', privilege_type: 'SELECT' },
      { table_name: 'credit_ledger', privilege_type: 'SELECT' },
    ]);
  });
});
