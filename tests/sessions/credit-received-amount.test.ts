/**
 * WO-B5b-1 DoD (ADR-010 · Q1/N2) — payments.received_amount + type ใหม่ของ credit_ledger
 *
 *   1. set_payment_received_amount: แอดมินเท่านั้น · สลิป submitted/verified · ยอดบวก ≤ 2 ตำแหน่ง · แก้ได้จนกว่าจะบันทึกโอนเกิน · audit
 *   2. received_amount เขียนตรงไม่ได้ (trigger) ทั้ง INSERT/UPDATE แม้เป็น superuser
 *   3. record_overpayment: ยอดคำนวณใน DB = received − amount · ไม่มี received/ไม่เกินยอด ⇒ ปฏิเสธ · p_amount ต้องตรง
 *   4. concurrency: กรอกยอดแข่งกับบันทึกโอนเกิน 20 รอบ ⇒ เครดิตตรงกับ received ที่ถูกล็อกเสมอ ไม่เบิ้ล
 *   5. credit_ledger: type ใหม่ + เครื่องหมาย + payment_id/charge_id/เหตุผล บังคับถูกต้อง
 *   6. EXECUTE matrix
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, runConcurrently } from '../helpers/db';
import { fromSatang, toSatang } from '@/domain/billing/money';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`rcv-${crypto.randomUUID()}@example.com`],
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
    `ก๊วน-rcv-${crypto.randomUUID()}`,
  ]);
  return { gangId: gang.id, owner };
}

async function addMember(gangId: string, role = 'member'): Promise<{ userId: string; memberId: string }> {
  const userId = await newUser();
  const {
    rows: [m],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3) returning id`,
    [gangId, userId, role],
  );
  return { userId, memberId: m.id };
}

async function payment(
  gangId: string,
  payer: string,
  amount: string,
  actor: string,
  to: 'pending' | 'submitted' | 'verified' = 'verified',
): Promise<string> {
  const {
    rows: [p],
  } = await pool.query<{ id: string }>(
    `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, $3, $4) returning id`,
    [gangId, payer, amount, actor],
  );
  if (to !== 'pending') await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payer]);
  if (to === 'verified') await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, actor]);
  return p.id;
}

const setReceived = (paymentId: string, received: string | number, actor: string | null) =>
  pool.query(`select public.set_payment_received_amount($1, $2, $3)`, [paymentId, received, actor]);

const record = (paymentId: string, amount: string | number | null, actor: string, reason = 'ทดสอบ') =>
  pool.query<{ amount: string; balance_after: string }>(
    `select amount::text, balance_after::text from public.record_overpayment($1, $2, $3, $4)`,
    [paymentId, amount, reason, actor],
  );

const receivedOf = async (paymentId: string) =>
  (
    await pool.query<{ r: string | null }>(`select received_amount::text r from public.payments where id = $1`, [paymentId])
  ).rows[0].r;

const balanceOf = async (gangId: string, userId: string) =>
  (
    await pool.query<{ b: string }>(`select public.credit_balance_of($1, $2)::text b`, [gangId, userId])
  ).rows[0].b;

let monthCounter = 0;
async function charge(gangId: string, memberId: string, amount = '100.00'): Promise<string> {
  const month = new Date(Date.UTC(2005, monthCounter % 120, 1 + Math.floor(monthCounter++ / 120))).toISOString().slice(0, 10);
  const {
    rows: [c],
  } = await pool.query<{ id: string }>(
    `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
     values ($1, 'monthly_fee', $2, $3::date, $4) returning id`,
    [gangId, memberId, month, amount],
  );
  return c.id;
}

// ---------------------------------------------------------------------------
// 1. set_payment_received_amount
// ---------------------------------------------------------------------------

describe('WO-B5b-1 Q1 — set_payment_received_amount', () => {
  it('แอดมินกรอกได้ทั้งสลิป submitted และ verified · แก้ซ้ำได้ก่อนบันทึกโอนเกิน · มี audit', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const sub = await payment(g.gangId, m.userId, '150.00', g.owner, 'submitted');
    const ver = await payment(g.gangId, m.userId, '150.00', g.owner, 'verified');

    expect(await receivedOf(sub)).toBeNull();
    await setReceived(sub, '200.00', g.owner);
    expect(await receivedOf(sub)).toBe('200.00');
    await setReceived(sub, '180.50', g.owner); // แอดมินแก้ตัวเลขที่กรอกผิด
    expect(await receivedOf(sub)).toBe('180.50');
    await setReceived(ver, 150, g.owner); // = ยอดสลิปพอดี (ไม่มีส่วนเกิน) กรอกได้
    expect(await receivedOf(ver)).toBe('150.00');

    const { rows: audit } = await pool.query<{ payload: Record<string, unknown>; actor_id: string }>(
      `select payload, actor_id from public.event_logs
        where aggregate_id = $1 and event_type = 'audit.payment_received_amount_set' order by created_at`,
      [sub],
    );
    expect(audit).toHaveLength(2);
    expect(audit[1].actor_id).toBe(g.owner);
    expect(audit[1].payload).toMatchObject({ received_amount: 180.5 });
  });

  it('🔴 member ธรรมดา / actor ว่าง / แอดมินก๊วนอื่น → FORBIDDEN · ค่าไม่เปลี่ยน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const other = await addMember(g.gangId);
    const foreign = (await newGang()).owner;
    const pay = await payment(g.gangId, m.userId, '100.00', g.owner);

    for (const actor of [m.userId, other.userId, null, foreign]) {
      await expect(setReceived(pay, '120.00', actor), String(actor)).rejects.toThrow(/FORBIDDEN/);
    }
    expect(await receivedOf(pay)).toBeNull();
  });

  it('สลิป pending / ไม่มีสลิป / ยอด 0, ติดลบ, ทศนิยมเกิน 2 ตำแหน่ง → ปฏิเสธ', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pending = await payment(g.gangId, m.userId, '100.00', g.owner, 'pending');
    await expect(setReceived(pending, '120.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(setReceived(crypto.randomUUID(), '120.00', g.owner)).rejects.toThrow(/PAYMENT_NOT_FOUND/);

    const ok = await payment(g.gangId, m.userId, '100.00', g.owner);
    for (const bad of ['0', '-5', '1.005']) {
      await expect(setReceived(ok, bad, g.owner), bad).rejects.toThrow(/VALIDATION_ERROR/);
    }
    await expect(setReceived(ok, null as unknown as string, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await receivedOf(ok)).toBeNull();
  });

  it('🔴 บันทึกโอนเกินเป็นเครดิตแล้ว → แก้ยอดที่โอนจริงไม่ได้อีก (ledger ผูกกับค่าเดิม)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await payment(g.gangId, m.userId, '100.00', g.owner);
    await setReceived(pay, '140.00', g.owner);
    await record(pay, null, g.owner);

    await expect(setReceived(pay, '999.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await receivedOf(pay)).toBe('140.00');
    expect(await balanceOf(g.gangId, m.userId)).toBe('40.00');
  });
});

// ---------------------------------------------------------------------------
// 2. received_amount เขียนตรงไม่ได้
// ---------------------------------------------------------------------------

describe('WO-B5b-1 Q1 — received_amount เขียนทางอื่นไม่ได้', () => {
  it('🔴 UPDATE ตรง / INSERT พร้อมค่า → FORBIDDEN แม้เป็น superuser · ผู้จ่ายแก้ผ่านสิทธิ์ authenticated ไม่ได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await payment(g.gangId, m.userId, '100.00', g.owner);

    await expect(
      pool.query(`update public.payments set received_amount = 999 where id = $1`, [pay]),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(
      pool.query(`insert into public.payments (gang_id, payer_user_id, amount, received_amount) values ($1, $2, 100, 500)`, [
        g.gangId,
        m.userId,
      ]),
    ).rejects.toThrow(/FORBIDDEN/);

    // ผู้จ่ายเองผ่าน role authenticated (RLS อาจกรองแถวเงียบๆ หรือ trigger ปฏิเสธ — ผลต้องเหมือนกัน: ค่าไม่เปลี่ยน)
    await asRole('authenticated', m.userId, async (c) => {
      await c
        .query(`update public.payments set received_amount = 999 where id = $1`, [pay])
        .catch(() => undefined);
    });
    await asRole('authenticated', g.owner, async (c) => {
      await c
        .query(`update public.payments set received_amount = 999 where id = $1`, [pay])
        .catch(() => undefined);
    });
    expect(await receivedOf(pay)).toBeNull();

    // การ UPDATE คอลัมน์อื่นของแถวที่มี received_amount ยังทำงานตามปกติ (trigger ไม่บล็อกโดยไม่จำเป็น)
    await setReceived(pay, '130.00', g.owner);
    await pool.query(`update public.payments set reject_reason = null where id = $1`, [pay]);
    expect(await receivedOf(pay)).toBe('130.00');
  });
});

// ---------------------------------------------------------------------------
// 3. record_overpayment คำนวณใน DB
// ---------------------------------------------------------------------------

describe('WO-B5b-1 N2 — record_overpayment คำนวณจาก received_amount', () => {
  it('p_amount = null ⇒ DB คำนวณ received − amount · ส่งค่าตรงกันก็ได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const a = await payment(g.gangId, m.userId, '150.00', g.owner);
    await setReceived(a, '200.50', g.owner);
    const r1 = await record(a, null, g.owner);
    expect(r1.rows[0]).toEqual({ amount: '50.50', balance_after: '50.50' });

    const b = await payment(g.gangId, m.userId, '99.99', g.owner);
    await setReceived(b, '100.00', g.owner);
    const r2 = await record(b, '0.01', g.owner); // ส่งมาตรง
    expect(r2.rows[0]).toEqual({ amount: '0.01', balance_after: '50.51' });
  });

  it('🔴 ไม่กรอกยอดที่โอนจริง → ปฏิเสธ (สลิป 1.00 บันทึกเครดิต 500 ไม่ได้อีก)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await payment(g.gangId, m.userId, '1.00', g.owner);

    let detail = '';
    await expect(
      record(pay, '500.00', g.owner).catch((e: { detail?: string }) => {
        detail = e.detail ?? '';
        throw e;
      }),
    ).rejects.toThrow(/VALIDATION_ERROR/);
    expect(detail).toContain('received_amount');
    await expect(record(pay, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
  });

  it('🔴 ยอดที่ส่งมาไม่เท่ากับส่วนเกินจริง (มากกว่า = เกิน · น้อยกว่า = ส่วนที่เหลือจะหลุด) → ปฏิเสธ · ไม่มีส่วนเกิน → ปฏิเสธ', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await payment(g.gangId, m.userId, '100.00', g.owner);
    await setReceived(pay, '130.00', g.owner);

    for (const given of ['30.01', '500.00', '29.99', '1.00']) {
      await expect(record(pay, given, g.owner), given).rejects.toThrow(/VALIDATION_ERROR/);
    }
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');

    // แก้ตัวเลขที่กรอกผิดแล้วบันทึกได้
    await setReceived(pay, '129.99', g.owner);
    expect((await record(pay, '29.99', g.owner)).rows[0].amount).toBe('29.99');

    const exact = await payment(g.gangId, m.userId, '100.00', g.owner);
    await setReceived(exact, '100.00', g.owner);
    await expect(record(exact, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    const under = await payment(g.gangId, m.userId, '100.00', g.owner);
    await setReceived(under, '80.00', g.owner);
    await expect(record(under, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('สลิปที่เกิดจากการใช้เครดิต (apply_credit) ไม่มี received_amount ⇒ บันทึกโอนเกินไม่ได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const topSlip = await payment(g.gangId, m.userId, '1.00', g.owner);
    await setReceived(topSlip, '51.00', g.owner);
    await record(topSlip, null, g.owner);
    await charge(g.gangId, m.memberId, '30.00'); // auto-apply สร้าง payment source=credit

    const { rows } = await pool.query<{ id: string }>(
      `select p.id from public.payments p
        join public.payment_allocations a on a.payment_id = p.id and a.source = 'credit'
       where p.gang_id = $1`,
      [g.gangId],
    );
    expect(rows).toHaveLength(1);
    await expect(record(rows[0].id, null, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await balanceOf(g.gangId, m.userId)).toBe('20.00');
  });
});

// ---------------------------------------------------------------------------
// 4. concurrency
// ---------------------------------------------------------------------------

describe('WO-B5b-1 — กรอกยอดแข่งกับบันทึกโอนเกิน', () => {
  it('🔴 20 รอบ: set(received ใหม่) ×2 + record ×2 พร้อมกัน ⇒ เครดิตที่เกิด = received ที่ถูกล็อกจริง · ไม่เบิ้ล · ค่าที่ค้างไม่เปลี่ยนหลังบันทึก', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const pay = await payment(g.gangId, m.userId, '100.00', g.owner);
      await setReceived(pay, '150.00', g.owner);

      const results = await runConcurrently(4, (c, i) =>
        i < 2
          ? c.query(`select public.set_payment_received_amount($1, $2, $3)`, [pay, i === 0 ? '170.00' : '190.00', g.owner])
          : c.query(`select public.record_overpayment($1, null, 'แข่ง', $2)`, [pay, g.owner]),
      );
      // ผลที่เป็นไปได้ต่อเงิน: record สำเร็จพอดี 1 ครั้ง (อีกครั้งโดนสลิปซ้ำ) — เว้นแต่ set ทั้งหมดแทรกหลัง record แล้วถูกปฏิเสธ
      const recorded = results.slice(2).filter((r) => r.status === 'fulfilled');
      expect(recorded, `round ${round}`).toHaveLength(1);

      const { rows: ledger } = await pool.query<{ amount: string }>(
        `select amount::text from public.credit_ledger where payment_id = $1 and type = 'overpayment'`,
        [pay],
      );
      expect(ledger, `round ${round}`).toHaveLength(1);
      const finalReceived = await receivedOf(pay);
      expect(
        fromSatang(toSatang(finalReceived!) - toSatang('100.00')),
        `ledger ตรงกับ received ที่ค้างอยู่ (set หลังบันทึกต้องถูกปฏิเสธ) round ${round}`,
      ).toBe(ledger[0].amount);
      expect(await balanceOf(g.gangId, m.userId), `round ${round}`).toBe(ledger[0].amount);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 5. credit_ledger — type ใหม่
// ---------------------------------------------------------------------------

describe('WO-B5b-1 — credit_ledger type ใหม่ (constraint)', () => {
  it('🔴 admin_topup / cash_payout / charge_return: เครื่องหมาย · payment_id · charge_id · เหตุผล บังคับถูก', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await payment(g.gangId, m.userId, '10.00', g.owner);
    const chargeId = await charge(g.gangId, m.memberId, '40.00');

    let seq = 900;
    const ins = (
      type: string,
      amount: string,
      after: string,
      reason: string | null,
      paymentId: string | null,
      charge: string | null,
    ) =>
      pool.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, payment_id, charge_id, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [g.gangId, m.userId, seq++, type, amount, after, paymentId, charge, reason],
      );

    // เหตุผลบังคับ
    await expect(ins('admin_topup', '50', '50', null, null, null)).rejects.toThrow(/reason_required/);
    await expect(ins('cash_payout', '-10', '0', '   ', null, null)).rejects.toThrow(/reason_required/);
    await expect(ins('charge_return', '40', '40', '', null, chargeId)).rejects.toThrow(/reason_required/);
    // เครื่องหมาย
    await expect(ins('admin_topup', '-50', '0', 'x', null, null)).rejects.toThrow(/sign_matches_type/);
    await expect(ins('cash_payout', '10', '10', 'x', null, null)).rejects.toThrow(/sign_matches_type/);
    await expect(ins('charge_return', '-40', '0', 'x', null, chargeId)).rejects.toThrow(/sign_matches_type/);
    // payment_id: ห้ามอ้างสลิปใน type ที่ไม่ได้มาจากสลิป · overpayment ต้องมี
    await expect(ins('admin_topup', '50', '50', 'x', pay, null)).rejects.toThrow(/payment_required/);
    await expect(ins('overpayment', '50', '50', 'x', null, null)).rejects.toThrow(/payment_required/);
    // charge_id: charge_return ต้องมี · type อื่นห้ามมี
    await expect(ins('charge_return', '40', '40', 'x', null, null)).rejects.toThrow(/charge_required/);
    await expect(ins('admin_topup', '50', '50', 'x', null, chargeId)).rejects.toThrow(/charge_required/);
    // type แปลก / balance ติดลบ
    await expect(ins('refund', '-10', '0', 'x', null, null)).rejects.toThrow(/check constraint/);
    await expect(ins('cash_payout', '-10', '-10', 'x', null, null)).rejects.toThrow(/check constraint/);

    // ถูกต้องทุกชนิด (seq ต่อเนื่องใน txn rollback เพื่อไม่ให้ยอดค้างในฐานร่วม)
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, reason)
         values ($1, $2, 1, 'admin_topup', 50, 50, 'ให้เครดิตชดเชย')`,
        [g.gangId, m.userId],
      );
      await c.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, reason)
         values ($1, $2, 2, 'cash_payout', -20, 30, 'จ่ายคืนเงินสด')`,
        [g.gangId, m.userId],
      );
      await c.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, charge_id, reason)
         values ($1, $2, 3, 'charge_return', 40, 70, $3, 'คิดผิด')`,
        [g.gangId, m.userId, chargeId],
      );
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text n from public.credit_ledger where gang_id = $1 and user_id = $2`,
        [g.gangId, m.userId],
      );
      expect(rows[0].n).toBe('3');
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(await balanceOf(g.gangId, m.userId)).toBe('0.00');
  });

  it('charge_id อ้าง charge ที่ไม่มีอยู่ไม่ได้ (FK)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await expect(
      pool.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, charge_id, reason)
         values ($1, $2, 1, 'charge_return', 40, 40, $3, 'x')`,
        [g.gangId, m.userId, crypto.randomUUID()],
      ),
    ).rejects.toThrow(/foreign key|violates/);
  });
});

// ---------------------------------------------------------------------------
// 6. EXECUTE matrix
// ---------------------------------------------------------------------------

describe('WO-B5b-1 — EXECUTE matrix', () => {
  it('🔴 set_payment_received_amount / record_overpayment: service_role เท่านั้น · guard trigger fn ไม่มีใครเรียกได้ · ไม่มี overload ซ้ำ', async () => {
    const { rows } = await pool.query<{ sig: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text sig, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('set_payment_received_amount', 'record_overpayment')`,
    );
    expect(new Set(rows.map((r) => r.sig)).size).toBe(2);
    for (const r of rows) expect(r.ok, `${r.sig} → ${r.role}`).toBe(r.role === 'service_role');

    const { rows: guard } = await pool.query<{ role: string; ok: boolean }>(
      `select r.role, has_function_privilege(r.role, 'public.guard_payment_received_amount()'::regprocedure, 'EXECUTE') ok
         from (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
    );
    for (const r of guard) expect(r.ok, r.role).toBe(false);
  });
});
