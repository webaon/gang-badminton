/**
 * WO-B5b-2 DoD (ADR-010 · Q2/Q3/Q4) — ช่องเข้า/ออกของเครดิต
 *
 *   1. credit_topup (ให้เครดิต): แอดมิน/โอเนอร์ · เหตุผลบังคับ · ไม่สร้างเงินสด (ไม่มี payment) · audit
 *   2. credit_cash_payout: ≤ ยอดคงเหลือ ไม่งั้น INSUFFICIENT_CREDIT · สมาชิกที่ออกแล้วรับคืนได้
 *   3. credit_return_charge: ย้ายยอดต้องคืนของ charge เข้าเครดิต · ≤ min(ต้องคืน, เงินที่ได้รับจริง) · ไม่เบิ้ล
 *   4. add_payment_adjustment refund: เพดานนับเฉพาะ allocation source=transfer และหัก credit_return
 *   5. concurrency (20 รอบ): return ซ้ำ · return แข่ง refund · return/topup/payout/apply_credit/ปิดรอบ ไม่ deadlock seq ไม่เพี้ยน
 *   6. payment_adjustments.credit_return บวกเท่านั้น · สร้างผ่าน add_payment_adjustment ไม่ได้
 *   7. EXECUTE matrix
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, runConcurrently } from '../helpers/db';
import { fromSatang, toSatang } from '@/domain/billing/money';

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
    [`flw-${crypto.randomUUID()}@example.com`],
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
    `ก๊วน-flw-${crypto.randomUUID()}`,
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

let counter = 0;

/** หนี้ monthly_fee (เดือนไม่ซ้ำ) — ⚠️ ผ่าน trigger หักเครดิตอัตโนมัติถ้าสมาชิกมีเครดิต */
async function charge(gangId: string, memberId: string, amount: string): Promise<string> {
  const n = counter++;
  const month = new Date(Date.UTC(1990 + Math.floor(n / 12), n % 12, 1)).toISOString().slice(0, 10);
  const {
    rows: [c],
  } = await pool.query<{ id: string }>(
    `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
     values ($1, 'monthly_fee', $2, $3::date, $4) returning id`,
    [gangId, memberId, month, amount],
  );
  return c.id;
}

/** สลิปที่โอนจริงครอบ charge (source=transfer, verified) */
async function payByTransfer(g: Gang, m: Member, chargeId: string): Promise<string> {
  const {
    rows: [p],
  } = await pool.query<{ id: string }>(
    `select id from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
    [g.gangId, m.userId, [chargeId], g.owner],
  );
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, m.userId]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, g.owner]);
  return p.id;
}

async function giveCredit(g: Gang, userId: string, amount: string): Promise<void> {
  const {
    rows: [p],
  } = await pool.query<{ id: string }>(
    `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, 1, $3) returning id`,
    [g.gangId, userId, g.owner],
  );
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, userId]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, g.owner]);
  await pool.query(`select public.set_payment_received_amount($1, 1 + $2::numeric, $3)`, [p.id, amount, g.owner]);
  await pool.query(`select public.record_overpayment($1, null, 'ทดสอบ', $2)`, [p.id, g.owner]);
}

const outstanding = async (chargeId: string) =>
  (await pool.query<{ o: string }>(`select public.charge_outstanding($1)::text o`, [chargeId])).rows[0].o;

const balanceOf = async (gangId: string, userId: string) =>
  (await pool.query<{ b: string }>(`select public.credit_balance_of($1, $2)::text b`, [gangId, userId])).rows[0].b;

const adjust = (chargeId: string, type: string, amount: string, actor: string, reason = 'ทดสอบ') =>
  pool.query(`select public.add_payment_adjustment($1, $2, $3, $4, null, $5)`, [chargeId, type, amount, reason, actor]);

const topup = (g: string, u: string, amount: string | number | null, actor: string | null, reason = 'ชดเชย') =>
  pool.query<{ amount: string; balance_after: string; seq: string; type: string }>(
    `select amount::text, balance_after::text, seq::text, type from public.credit_topup($1, $2, $3, $4, $5)`,
    [g, u, amount, reason, actor],
  );

const payout = (g: string, u: string, amount: string | number | null, actor: string | null, reason = 'คืนเงินสด') =>
  pool.query<{ amount: string; balance_after: string; seq: string; type: string }>(
    `select amount::text, balance_after::text, seq::text, type from public.credit_cash_payout($1, $2, $3, $4, $5)`,
    [g, u, amount, reason, actor],
  );

const returnCharge = (chargeId: string, amount: string | number | null, actor: string | null, reason = 'คิดผิด') =>
  pool.query<{ amount: string; balance_after: string; type: string; charge_id: string; seq: string }>(
    `select amount::text, balance_after::text, type, charge_id, seq::text from public.credit_return_charge($1, $2, $3, $4)`,
    [chargeId, amount, reason, actor],
  );

/** seq ไม่ซ้ำไม่ข้าม · balance_after ต่อเนื่องตาม seq · cache = Σ */
async function expectLedgerConsistent(gangId: string, userId: string, note = '') {
  const { rows } = await pool.query<{ seq: string; amount: string; balance_after: string }>(
    `select seq::text, amount::text, balance_after::text from public.credit_ledger
      where gang_id = $1 and user_id = $2 order by seq`,
    [gangId, userId],
  );
  let running = 0;
  rows.forEach((r, i) => {
    expect(Number(r.seq), `seq ${note}`).toBe(i + 1);
    running += toSatang(r.amount);
    expect(toSatang(r.balance_after), `balance_after ${note}`).toBe(running);
    expect(running, `≥ 0 ${note}`).toBeGreaterThanOrEqual(0);
  });
  expect(await balanceOf(gangId, userId), `cache = Σ ${note}`).toBe(fromSatang(running));
}

// ---------------------------------------------------------------------------
// 1. credit_topup
// ---------------------------------------------------------------------------

describe('WO-B5b-2 Q3 — credit_topup (ให้เครดิต)', () => {
  it('admin และ owner ให้เครดิตได้ · ledger admin_topup · seq ต่อเนื่อง · audit · ไม่มีเงินสดเกิด (ไม่มี payment)', async () => {
    const g = await newGang();
    const admin = await addMember(g.gangId, 'admin');
    const m = await addMember(g.gangId);

    const r1 = await topup(g.gangId, m.userId, '50.00', g.owner, 'ชดเชยนัดที่ยกเลิก');
    expect(r1.rows[0]).toEqual({ amount: '50.00', balance_after: '50.00', seq: '1', type: 'admin_topup' });
    const r2 = await topup(g.gangId, m.userId, 25.5, admin.userId);
    expect(r2.rows[0]).toMatchObject({ balance_after: '75.50', seq: '2' });

    await expectLedgerConsistent(g.gangId, m.userId);
    const { rows: audit } = await pool.query<{ actor_id: string; payload: { reason: string; amount: number } }>(
      `select actor_id, payload from public.event_logs
        where gang_id = $1 and event_type = 'audit.credit_topup' order by created_at`,
      [g.gangId],
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor_id: g.owner, payload: { reason: 'ชดเชยนัดที่ยกเลิก', amount: 50 } });

    // 🔴 ไม่ใช่เงินสดเข้า: ไม่มี payment/allocation ใดๆ เกิดขึ้น
    const { rows: pay } = await pool.query<{ n: string }>(`select count(*)::text n from public.payments where gang_id = $1`, [g.gangId]);
    expect(pay[0].n).toBe('0');
  });

  it('🔴 member ธรรมดา / actor ว่าง / แอดมินก๊วนอื่น → FORBIDDEN · ผู้รับต้องเป็นสมาชิกที่ยังอยู่', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const other = await addMember(g.gangId);
    const foreign = (await newGang()).owner;

    for (const actor of [m.userId, other.userId, null, foreign]) {
      await expect(topup(g.gangId, m.userId, '10.00', actor), String(actor)).rejects.toThrow(/FORBIDDEN/);
    }
    await expect(topup(g.gangId, await newUser(), '10.00', g.owner)).rejects.toThrow(/NOT_GANG_MEMBER/);
    await pool.query(`select public.leave_gang($1, $2)`, [g.gangId, other.userId]);
    await expect(topup(g.gangId, other.userId, '10.00', g.owner)).rejects.toThrow(/NOT_GANG_MEMBER/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
  });

  it('ยอด 0/ติดลบ/ทศนิยมเกิน/null และเหตุผลว่าง → VALIDATION_ERROR', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    for (const bad of ['0', '-5', '1.005', null]) {
      await expect(topup(g.gangId, m.userId, bad, g.owner), String(bad)).rejects.toThrow(/VALIDATION_ERROR/);
    }
    await expect(topup(g.gangId, m.userId, '10.00', g.owner, '   ')).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
  });

  it('เครดิตที่ให้ถูกหักอัตโนมัติกับหนี้ใหม่ได้ตามปกติ (ผ่านทางเดียวกับเครดิตโอนเกิน)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await topup(g.gangId, m.userId, '100.00', g.owner);
    const c = await charge(g.gangId, m.memberId, '60.00');
    expect(await outstanding(c)).toBe('0.00');
    expect(await balanceOf(g.gangId, m.userId)).toBe('40.00');
    await expectLedgerConsistent(g.gangId, m.userId);
  });
});

// ---------------------------------------------------------------------------
// 2. credit_cash_payout
// ---------------------------------------------------------------------------

describe('WO-B5b-2 Q4 — credit_cash_payout (จ่ายคืนเงินสด)', () => {
  it('จ่ายคืนได้ไม่เกินยอดคงเหลือ · หมดพอดีได้ · เกิน → INSUFFICIENT_CREDIT (ยอดไม่เปลี่ยน)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await topup(g.gangId, m.userId, '100.00', g.owner);

    const r = await payout(g.gangId, m.userId, '30.00', g.owner);
    expect(r.rows[0]).toEqual({ amount: '-30.00', balance_after: '70.00', seq: '2', type: 'cash_payout' });

    let detail = '';
    await expect(
      payout(g.gangId, m.userId, '70.01', g.owner).catch((e: { detail?: string }) => {
        detail = e.detail ?? '';
        throw e;
      }),
    ).rejects.toThrow(/INSUFFICIENT_CREDIT/);
    expect(detail).toContain('70');

    await payout(g.gangId, m.userId, '70.00', g.owner);
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
    await expect(payout(g.gangId, m.userId, '0.01', g.owner)).rejects.toThrow(/INSUFFICIENT_CREDIT/);
    await expectLedgerConsistent(g.gangId, m.userId);

    // คนที่ไม่เคยมีเครดิตเลข (ไม่มีแถวยอด) ก็ INSUFFICIENT_CREDIT
    const none = await addMember(g.gangId);
    await expect(payout(g.gangId, none.userId, '1.00', g.owner)).rejects.toThrow(/INSUFFICIENT_CREDIT/);
  });

  it('🔴 สมาชิกที่ออกจากก๊วนแล้วรับเงินคืนได้ · member/actor ว่าง/แอดมินก๊วนอื่น → FORBIDDEN · validation', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const other = await addMember(g.gangId);
    await topup(g.gangId, m.userId, '80.00', g.owner);
    await pool.query(`select public.leave_gang($1, $2)`, [g.gangId, m.userId]);

    for (const actor of [other.userId, m.userId, null, (await newGang()).owner]) {
      await expect(payout(g.gangId, m.userId, '10.00', actor), String(actor)).rejects.toThrow(/FORBIDDEN/);
    }
    for (const bad of ['0', '-5', '1.005', null]) {
      await expect(payout(g.gangId, m.userId, bad, g.owner), String(bad)).rejects.toThrow(/VALIDATION_ERROR/);
    }
    await expect(payout(g.gangId, m.userId, '10.00', g.owner, '')).rejects.toThrow(/VALIDATION_ERROR/);

    const r = await payout(g.gangId, m.userId, '80.00', g.owner);
    expect(r.rows[0].balance_after).toBe('0.00');
  });

  it('🔴 concurrency: จ่ายคืน ×6 พร้อมกัน ×20 รอบ — ยอดไม่ติดลบ · รวมที่จ่ายไม่เกินเครดิต · seq ไม่ข้าม', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      await topup(g.gangId, m.userId, '100.00', g.owner);

      const results = await runConcurrently(6, (c) =>
        c.query(`select public.credit_cash_payout($1, $2, 30.00, 'พร้อมกัน', $3)`, [g.gangId, m.userId, g.owner]),
      );
      expect(results.filter((r) => r.status === 'fulfilled'), `round ${round}`).toHaveLength(3); // 3×30 ≤ 100 < 4×30
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect(String((r as PromiseRejectedResult).reason?.message), `round ${round}`).toMatch(/INSUFFICIENT_CREDIT/);
      }
      expect(await balanceOf(g.gangId, m.userId), `round ${round}`).toBe('10.00');
      await expectLedgerConsistent(g.gangId, m.userId, `round ${round}`);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. credit_return_charge
// ---------------------------------------------------------------------------

describe('WO-B5b-2 Q2 — credit_return_charge (ย้ายยอดต้องคืนเข้าเครดิต)', () => {
  it('🔴 charge ที่โอนจ่ายแล้ว → ลดหนี้ (credit) ⇒ ต้องคืน 100 → ย้ายเข้าเครดิต: outstanding กลับ 0 · เครดิต +100 · เรียกซ้ำไม่ได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    await payByTransfer(g, m, c);
    expect(await outstanding(c)).toBe('0.00');

    await adjust(c, 'credit', '-100.00', g.owner, 'ยกเลิกค่ารายเดือน');
    expect(await outstanding(c)).toBe('-100.00'); // ก๊วนต้องคืน 100

    const r = await returnCharge(c, null, g.owner, 'ย้ายเข้าเครดิต');
    expect(r.rows[0]).toMatchObject({ amount: '100.00', balance_after: '100.00', type: 'charge_return', charge_id: c, seq: '1' });
    expect(await outstanding(c)).toBe('0.00'); // ต้องคืนไม่ค้างคู่กับเครดิต
    expect(await balanceOf(g.gangId, m.userId)).toBe('100.00');

    const { rows: adj } = await pool.query<{ type: string; amount: string }>(
      `select type, amount::text from public.payment_adjustments where session_charge_id = $1 order by created_at, id`,
      [c],
    );
    expect(adj.map((a) => [a.type, a.amount])).toEqual([
      ['credit', '-100.00'],
      ['credit_return', '100.00'],
    ]);

    // 🔴 เรียกซ้ำ → ไม่มียอดต้องคืนเหลือ ⇒ เครดิตไม่เบิ้ล
    await expect(returnCharge(c, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(returnCharge(c, '1.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('100.00');

    const { rows: audit } = await pool.query(
      `select 1 from public.event_logs where aggregate_id = $1 and event_type = 'audit.credit_charge_returned'`,
      [c],
    );
    expect(audit).toHaveLength(1);
    await expectLedgerConsistent(g.gangId, m.userId);
  });

  it('ย้ายบางส่วนได้ (40 แล้ว 60) · เกินยอดต้องคืนไม่ได้ · ยอดต้องไม่เป็น 0/ติดลบ/ทศนิยมเกิน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    await payByTransfer(g, m, c);
    await adjust(c, 'credit', '-100.00', g.owner);

    for (const bad of ['0', '-5', '1.005']) {
      await expect(returnCharge(c, bad, g.owner), bad).rejects.toThrow(/VALIDATION_ERROR/);
    }
    await expect(returnCharge(c, '100.01', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(returnCharge(c, '10.00', g.owner, '  ')).rejects.toThrow(/VALIDATION_ERROR/);

    expect((await returnCharge(c, '40.00', g.owner)).rows[0]).toMatchObject({ balance_after: '40.00' });
    expect(await outstanding(c)).toBe('-60.00');
    await expect(returnCharge(c, '60.01', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect((await returnCharge(c, '60.00', g.owner)).rows[0]).toMatchObject({ balance_after: '100.00' });
    expect(await outstanding(c)).toBe('0.00');
    await expectLedgerConsistent(g.gangId, m.userId);
  });

  it('🔴 ไม่มียอดต้องคืน (หนี้ยังเป็นบวก/0) หรือลดหนี้เกินหนี้ที่ยังไม่มีใครจ่ายเงินจริง → ปฏิเสธ (ไม่สร้างเครดิตจากอากาศ)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);

    const unpaid = await charge(g.gangId, m.memberId, '100.00');
    await expect(returnCharge(unpaid, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/); // ยังค้าง +100

    // แอดมินให้ส่วนลดเกินหนี้ (credit −150 บน charge 100 ที่ยังไม่มีใครจ่าย) ⇒ outstanding −50 แต่ไม่มีเงินเข้าจริง
    await adjust(unpaid, 'credit', '-150.00', g.owner, 'ส่วนลดเกินหนี้');
    expect(await outstanding(unpaid)).toBe('-50.00');
    await expect(returnCharge(unpaid, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(returnCharge(unpaid, '50.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
  });

  it('🔴 charge ที่จ่ายด้วยเครดิต: ลดหนี้แล้วย้ายกลับ → เงินคืนเข้าเครดิต (ไม่ใช่เงินสด) · refund เงินสดบน charge นี้ไม่ได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await giveCredit(g, m.userId, '100.00');
    const c = await charge(g.gangId, m.memberId, '100.00'); // หักอัตโนมัติ (source=credit)
    expect(await outstanding(c)).toBe('0.00');
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');

    // ❌ คืนเป็นเงินสดไม่ได้ — ไม่มี allocation source=transfer
    await expect(adjust(c, 'refund', '-50.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);

    await adjust(c, 'credit', '-100.00', g.owner, 'คิดผิด');
    const r = await returnCharge(c, null, g.owner);
    expect(r.rows[0]).toMatchObject({ amount: '100.00', type: 'charge_return' });
    expect(await balanceOf(g.gangId, m.userId)).toBe('100.00');
    expect(await outstanding(c)).toBe('0.00');
    await expectLedgerConsistent(g.gangId, m.userId);
  });

  it('🔴 เพดาน refund เงินสด: นับเฉพาะ transfer และหัก credit_return ที่ย้ายแล้ว (ไม่จ่ายซ้ำสองทาง)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    await payByTransfer(g, m, c);
    await adjust(c, 'credit', '-100.00', g.owner);
    await returnCharge(c, '60.00', g.owner); // 60 เข้าเครดิตแล้ว

    // เหลือคืนเงินสดได้อีก 40 เท่านั้น
    await expect(adjust(c, 'refund', '-40.01', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await adjust(c, 'refund', '-40.00', g.owner);
    await expect(adjust(c, 'refund', '-0.01', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('60.00');
  });

  it('เพดาน refund เดิมของการจ่ายด้วยการโอนล้วนไม่เปลี่ยน: คืนได้ถึงยอดที่โอน แต่ไม่เกิน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    await payByTransfer(g, m, c);
    await adjust(c, 'refund', '-70.00', g.owner);
    await expect(adjust(c, 'refund', '-30.01', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await adjust(c, 'refund', '-30.00', g.owner);
  });

  it('สิทธิ์/ข้อมูลผิด: FORBIDDEN · CHARGE_NOT_FOUND', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const other = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');
    await payByTransfer(g, m, c);
    await adjust(c, 'credit', '-100.00', g.owner);

    for (const actor of [m.userId, other.userId, null, (await newGang()).owner]) {
      await expect(returnCharge(c, null, actor), String(actor)).rejects.toThrow(/FORBIDDEN/);
    }
    await expect(returnCharge(crypto.randomUUID(), null, g.owner)).rejects.toThrow(/CHARGE_NOT_FOUND/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
  });

  it('🔴 concurrency: ย้ายเข้าเครดิต ×4 พร้อมกัน ×20 รอบ → สำเร็จใบเดียว เครดิต = 100 เสมอ ไม่เบิ้ล', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const c = await charge(g.gangId, m.memberId, '100.00');
      await payByTransfer(g, m, c);
      await adjust(c, 'credit', '-100.00', g.owner);

      const results = await runConcurrently(4, (cl) =>
        cl.query(`select public.credit_return_charge($1, null, 'พร้อมกัน', $2)`, [c, g.owner]),
      );
      expect(results.filter((r) => r.status === 'fulfilled'), `round ${round}`).toHaveLength(1);
      expect(await balanceOf(g.gangId, m.userId), `round ${round}`).toBe('100.00');
      expect(await outstanding(c), `round ${round}`).toBe('0.00');
      await expectLedgerConsistent(g.gangId, m.userId, `round ${round}`);
    }
  }, 120_000);

  it('🔴 concurrency: ย้ายเข้าเครดิต แข่ง refund เงินสด 20 รอบ → เงินที่ออกไป (เครดิต + เงินสด) ไม่เกินที่รับมา', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const c = await charge(g.gangId, m.memberId, '100.00');
      await payByTransfer(g, m, c);
      await adjust(c, 'credit', '-100.00', g.owner);

      await runConcurrently(2, (cl, i) =>
        i === 0
          ? cl.query(`select public.credit_return_charge($1, null, 'แข่ง', $2)`, [c, g.owner])
          : cl.query(`select public.add_payment_adjustment($1, 'refund', -100, 'แข่ง', null, $2)`, [c, g.owner]),
      );

      const credit = toSatang(await balanceOf(g.gangId, m.userId));
      const { rows } = await pool.query<{ r: string }>(
        `select coalesce(-sum(amount), 0)::text r from public.payment_adjustments where session_charge_id = $1 and type = 'refund'`,
        [c],
      );
      expect(credit + toSatang(rows[0].r), `round ${round}`).toBeLessThanOrEqual(toSatang('100.00'));
      await expectLedgerConsistent(g.gangId, m.userId, `round ${round}`);
    }
  }, 120_000);

  it('🔴 concurrency: return / topup / payout / apply_credit / ปิดรอบ(auto-apply) ของคนเดียวกันพร้อมกัน 20 รอบ — ไม่ deadlock (40P01) · ledger ถูก', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const paid = await charge(g.gangId, m.memberId, '100.00');
      await payByTransfer(g, m, paid);
      await adjust(paid, 'credit', '-100.00', g.owner);
      await topup(g.gangId, m.userId, '30.00', g.owner);
      const debt = await charge(g.gangId, m.memberId, '500.00'); // ใหญ่กว่าเครดิต → เหลือหนี้ให้ apply มือแย่ง

      const jobs: ((c: import('pg').PoolClient) => Promise<unknown>)[] = [
        (c) => c.query(`select public.credit_return_charge($1, null, 'ชน', $2)`, [paid, g.owner]),
        (c) => c.query(`select public.credit_topup($1, $2, 10.00, 'ชน', $3)`, [g.gangId, m.userId, g.owner]),
        (c) => c.query(`select public.credit_cash_payout($1, $2, 5.00, 'ชน', $3)`, [g.gangId, m.userId, g.owner]),
        (c) => c.query(`select public.apply_credit($1, $2, null, $3)`, [g.gangId, m.userId, g.owner]),
        async () => {
          await charge(g.gangId, m.memberId, '9.00'); // trigger auto-apply
        },
        (c) => c.query(`select public.add_payment_adjustment($1, 'correction', 1.00, 'ชน', null, $2)`, [debt, g.owner]),
      ];
      const results = await runConcurrently(jobs.length, (c, i) => jobs[i](c));
      for (const [i, r] of results.entries()) {
        const msg = r.status === 'rejected' ? String((r as PromiseRejectedResult).reason?.message) : '';
        // ยอมรับเฉพาะการปฏิเสธเชิงธุรกิจ (เช่น เครดิตไม่พอ/ไม่มียอดต้องคืน) — ห้ามเป็น deadlock
        expect(msg, `round ${round} job ${i}`).not.toMatch(/deadlock/i);
        if (r.status === 'rejected') expect(msg, `round ${round} job ${i}`).toMatch(/INSUFFICIENT_CREDIT|VALIDATION_ERROR/);
      }
      await expectLedgerConsistent(g.gangId, m.userId, `round ${round}`);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 4. payment_adjustments.credit_return
// ---------------------------------------------------------------------------

describe('WO-B5b-2 — payment_adjustments type credit_return', () => {
  it('บวกเท่านั้น · สร้างผ่าน add_payment_adjustment ไม่ได้ (ต้องผ่าน credit_return_charge)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '100.00');

    await expect(adjust(c, 'credit_return', '50.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(
      pool.query(
        `insert into public.payment_adjustments (session_charge_id, type, amount, reason) values ($1, 'credit_return', -10, 'x')`,
        [c],
      ),
    ).rejects.toThrow(/credit_return_positive/);
    await expect(
      pool.query(`insert into public.payment_adjustments (session_charge_id, type, amount, reason) values ($1, 'bogus', 10, 'x')`, [c]),
    ).rejects.toThrow(/type_check/);
  });
});

// ---------------------------------------------------------------------------
// 5. EXECUTE matrix
// ---------------------------------------------------------------------------

describe('WO-B5b-2 — EXECUTE matrix', () => {
  it('🔴 credit_topup / credit_cash_payout / credit_return_charge / add_payment_adjustment: service_role เท่านั้น · ไม่มี overload ซ้ำ', async () => {
    const { rows } = await pool.query<{ sig: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text sig, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('credit_topup', 'credit_cash_payout', 'credit_return_charge', 'add_payment_adjustment')`,
    );
    expect(new Set(rows.map((r) => r.sig)).size).toBe(4);
    for (const r of rows) expect(r.ok, `${r.sig} → ${r.role}`).toBe(r.role === 'service_role');
  });
});
