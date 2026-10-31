/**
 * WO-B5b-3 DoD (ADR-010 Q5 ข · ADR-012) — leave_gang หักเครดิตกับหนี้ค้างก่อนออก
 *
 *   1. เครดิต 100 ค้าง 60 ⇒ ออกแล้วเครดิต 40 ค้าง 0 · เครดิต 30 ค้าง 60 ⇒ เครดิต 0 ค้าง 30 · ไม่มีเครดิต ⇒ เหมือนเดิม
 *   2. หักเก่าก่อน · ledger/seq ถูก · เครดิตที่เหลือแอดมินจ่ายคืนเงินสดได้หลังออก (cash_payout)
 *   3. "ออกได้เสมอ" ไม่เปลี่ยน: ออกไม่ได้ (owner คนสุดท้าย) ⇒ เครดิต/หนี้ไม่ถูกแตะ
 *   4. event สาธารณะ 'gang.member_left' ไม่มียอดเงิน · audit.credit_applied (แอดมิน) มี
 *   5. concurrency 20 รอบ: ออกพร้อม payout / apply_credit มือ / ปิดรอบ(auto-apply) / topup ไม่ deadlock
 *   6. ห้ามให้เครดิตตัวเอง (admin/owner ⇒ FORBIDDEN · คนอื่นผ่าน)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, runConcurrently } from '../helpers/db';
import { fromSatang, toSatang } from '@/domain/billing/money';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`lv-${crypto.randomUUID()}@example.com`],
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
    `ก๊วน-lv-${crypto.randomUUID()}`,
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

/** ⚠️ ถ้าสมาชิกมีเครดิตอยู่แล้ว trigger หักอัตโนมัติทันที — ในเทสต์นี้สร้างหนี้ "ก่อน" ให้เครดิตเสมอ */
async function charge(gangId: string, memberId: string, amount: string): Promise<string> {
  const n = counter++;
  const month = new Date(Date.UTC(1960 + Math.floor(n / 12), n % 12, 1)).toISOString().slice(0, 10);
  const {
    rows: [c],
  } = await pool.query<{ id: string }>(
    `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
     values ($1, 'monthly_fee', $2, $3::date, $4) returning id`,
    [gangId, memberId, month, amount],
  );
  return c.id;
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

type LeaveResult = {
  member_id: string;
  cancelled_registrations: number;
  outstanding_charges: number;
  outstanding_amount: string;
  credit_applied: string;
  credit_balance: string;
};

const leave = async (gangId: string, userId: string): Promise<LeaveResult> =>
  (
    await pool.query<{ r: LeaveResult }>(`select public.leave_gang($1, $2, 'cid-lv') r`, [gangId, userId])
  ).rows[0].r;

const outstanding = async (chargeId: string) =>
  (await pool.query<{ o: string }>(`select public.charge_outstanding($1)::text o`, [chargeId])).rows[0].o;

const balanceOf = async (gangId: string, userId: string) =>
  (await pool.query<{ b: string }>(`select public.credit_balance_of($1, $2)::text b`, [gangId, userId])).rows[0].b;

const isMember = async (gangId: string, userId: string) =>
  (
    await pool.query(`select 1 from public.gang_members where gang_id = $1 and user_id = $2 and deleted_at is null`, [
      gangId,
      userId,
    ])
  ).rowCount === 1;

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
  const { rows: cache } = await pool.query<{ b: string }>(
    `select balance::text b from public.credit_balances where gang_id = $1 and user_id = $2`,
    [gangId, userId],
  );
  if (cache[0]) expect(cache[0].b, `cache row ${note}`).toBe(fromSatang(running));
}

// ---------------------------------------------------------------------------
// 1. หักเครดิตกับหนี้ก่อนออก
// ---------------------------------------------------------------------------

describe('WO-B5b-3 Q5 ข — leave_gang หักเครดิตกับหนี้ค้างก่อนออก', () => {
  it('🔴 เครดิต 100 ค้าง 60 ⇒ หัก 60 · เครดิตเหลือ 40 · ค้าง 0 · ออกสำเร็จ', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '60.00');
    await giveCredit(g, m.userId, '100.00');
    expect(await outstanding(c)).toBe('60.00'); // ให้เครดิตภายหลังไม่หักย้อนหลังเอง

    const r = await leave(g.gangId, m.userId);
    expect(r).toMatchObject({
      credit_applied: '60.00',
      credit_balance: '40.00',
      outstanding_charges: 0,
      outstanding_amount: '0.00',
    });
    expect(await outstanding(c)).toBe('0.00');
    expect(await balanceOf(g.gangId, m.userId)).toBe('40.00');
    expect(await isMember(g.gangId, m.userId)).toBe(false);
    await expectLedgerConsistent(g.gangId, m.userId);
  });

  it('🔴 เครดิต 30 ค้าง 60 ⇒ หัก 30 · เครดิต 0 · ค้าง 30 (1 รายการ) · ออกได้', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const c = await charge(g.gangId, m.memberId, '60.00');
    await giveCredit(g, m.userId, '30.00');

    const r = await leave(g.gangId, m.userId);
    expect(r).toMatchObject({
      credit_applied: '30.00',
      credit_balance: '0.00',
      outstanding_charges: 1,
      outstanding_amount: '30.00',
    });
    expect(await outstanding(c)).toBe('30.00');
    expect(await isMember(g.gangId, m.userId)).toBe(false);
    await expectLedgerConsistent(g.gangId, m.userId);
  });

  it('ไม่มีเครดิต ⇒ เหมือนเดิม: ไม่หักอะไร · ledger ว่าง · ยอดค้างแจ้งตามจริง', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await charge(g.gangId, m.memberId, '80.00');

    const r = await leave(g.gangId, m.userId);
    expect(r).toMatchObject({
      credit_applied: '0.00',
      credit_balance: '0.00',
      outstanding_charges: 1,
      outstanding_amount: '80.00',
    });
    const { rows } = await pool.query(`select 1 from public.credit_ledger where gang_id = $1 and user_id = $2`, [g.gangId, m.userId]);
    expect(rows).toHaveLength(0);
  });

  it('หักเก่าก่อน (A 50, B 50, เครดิต 70 ⇒ A จ่ายครบ · B เหลือ 30) · หนี้ของนัดที่ผูก registration ก็หัก', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const a = await charge(g.gangId, m.memberId, '50.00');
    const b = await charge(g.gangId, m.memberId, '50.00');
    await giveCredit(g, m.userId, '70.00');

    const r = await leave(g.gangId, m.userId);
    expect(r).toMatchObject({ credit_applied: '70.00', credit_balance: '0.00', outstanding_charges: 1, outstanding_amount: '30.00' });
    expect(await outstanding(a)).toBe('0.00');
    expect(await outstanding(b)).toBe('30.00');
  });

  it('เครดิตเกินหนี้/ไม่มีหนี้ ⇒ เครดิตที่เหลือค้างที่ก๊วน และแอดมินจ่ายคืนเงินสดให้คนที่ออกแล้วได้ (cash_payout)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await giveCredit(g, m.userId, '50.00');

    const r = await leave(g.gangId, m.userId);
    expect(r).toMatchObject({ credit_applied: '0.00', credit_balance: '50.00', outstanding_charges: 0 });
    expect(await isMember(g.gangId, m.userId)).toBe(false);

    const { rows } = await pool.query<{ balance_after: string; type: string }>(
      `select balance_after::text, type from public.credit_cash_payout($1, $2, 50.00, 'คืนเงินสดหลังออกจากก๊วน', $3)`,
      [g.gangId, m.userId, g.owner],
    );
    expect(rows[0]).toEqual({ balance_after: '0.00', type: 'cash_payout' });
    // ให้เครดิตเพิ่มกับคนที่ออกแล้วไม่ได้ (ไม่ใช่สมาชิก)
    await expect(
      pool.query(`select public.credit_topup($1, $2, 5.00, 'x', $3)`, [g.gangId, m.userId, g.owner]),
    ).rejects.toThrow(/NOT_GANG_MEMBER/);
    await expectLedgerConsistent(g.gangId, m.userId);
  });

  it('🔴 ออกไม่ได้ (owner คนสุดท้าย) ⇒ เครดิต/หนี้/payment ไม่ถูกแตะเลย (ทั้งก้อน rollback)', async () => {
    const g = await newGang();
    const {
      rows: [om],
    } = await pool.query<{ id: string }>(`select id from public.gang_members where gang_id = $1 and user_id = $2`, [g.gangId, g.owner]);
    const c = await charge(g.gangId, om.id, '60.00');
    // เครดิตของ owner: ให้ผ่านแอดมินคนอื่น (ห้ามให้ตัวเอง)
    const admin = await addMember(g.gangId, 'admin');
    await pool.query(`select public.credit_topup($1, $2, 100.00, 'ชดเชย', $3)`, [g.gangId, g.owner, admin.userId]);
    const payBefore = (await pool.query<{ n: string }>(`select count(*)::text n from public.payments where gang_id = $1`, [g.gangId])).rows[0].n;

    await expect(leave(g.gangId, g.owner)).rejects.toThrow(/VALIDATION_ERROR/);

    expect(await outstanding(c)).toBe('60.00');
    expect(await balanceOf(g.gangId, g.owner)).toBe('100.00');
    expect((await pool.query<{ n: string }>(`select count(*)::text n from public.payments where gang_id = $1`, [g.gangId])).rows[0].n).toBe(payBefore);
    expect(await isMember(g.gangId, g.owner)).toBe(true);
  });

  it('🔴 event สาธารณะ gang.member_left ไม่มียอดเงิน · audit.credit_applied (แอดมินเท่านั้น) มียอดที่หัก', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await charge(g.gangId, m.memberId, '40.00');
    await giveCredit(g, m.userId, '25.00');
    await leave(g.gangId, m.userId);

    const { rows: left } = await pool.query<{ payload: Record<string, unknown> }>(
      `select payload from public.event_logs where gang_id = $1 and event_type = 'gang.member_left'`,
      [g.gangId],
    );
    expect(left).toHaveLength(1);
    expect(JSON.stringify(left[0].payload)).not.toMatch(/credit|outstanding|amount|25|40/);

    const { rows: audit } = await pool.query<{ payload: { applied: number } }>(
      `select payload from public.event_logs where gang_id = $1 and event_type = 'audit.credit_applied'`,
      [g.gangId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].payload.applied).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 2. concurrency
// ---------------------------------------------------------------------------

describe('WO-B5b-3 — concurrency', () => {
  it('🔴 ออกพร้อม payout / apply_credit มือ / ปิดรอบ(auto-apply) / topup ของคนเดียวกัน 20 รอบ — ไม่ deadlock · ledger ถูก · ออกสำเร็จเสมอ', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      const admin = await addMember(g.gangId, 'admin');
      await charge(g.gangId, m.memberId, '70.00');
      await charge(g.gangId, m.memberId, '70.00');
      await giveCredit(g, m.userId, '100.00');

      const jobs: ((c: import('pg').PoolClient) => Promise<unknown>)[] = [
        (c) => c.query(`select public.leave_gang($1, $2, 'cid-race')`, [g.gangId, m.userId]),
        (c) => c.query(`select public.credit_cash_payout($1, $2, 20.00, 'ชน', $3)`, [g.gangId, m.userId, g.owner]),
        (c) => c.query(`select public.apply_credit($1, $2, null, $3)`, [g.gangId, m.userId, g.owner]),
        (c) => c.query(`select public.credit_topup($1, $2, 15.00, 'ชน', $3)`, [g.gangId, m.userId, admin.userId]),
        async () => {
          await charge(g.gangId, m.memberId, '9.00'); // trigger auto-apply
        },
      ];
      const results = await runConcurrently(jobs.length, (c, i) => jobs[i](c));

      for (const [i, r] of results.entries()) {
        const msg = r.status === 'rejected' ? String((r as PromiseRejectedResult).reason?.message) : '';
        expect(msg, `round ${round} job ${i}`).not.toMatch(/deadlock/i);
        // การปฏิเสธเชิงธุรกิจที่ยอมรับได้: topup หลังออก (NOT_GANG_MEMBER) · payout เกินเครดิตที่เหลือ
        if (i === 0) expect(r.status, `leave ต้องสำเร็จเสมอ round ${round}: ${msg}`).toBe('fulfilled');
        else if (r.status === 'rejected') {
          expect(msg, `round ${round} job ${i}`).toMatch(/INSUFFICIENT_CREDIT|NOT_GANG_MEMBER|VALIDATION_ERROR/);
        }
      }
      expect(await isMember(g.gangId, m.userId), `round ${round}`).toBe(false);
      await expectLedgerConsistent(g.gangId, m.userId, `round ${round}`);

      // ไม่มี charge ไหนจ่ายเกินหนี้ (outstanding ติดลบ = เครดิตเบิ้ลออกไปเป็น allocation เกิน)
      const { rows: neg } = await pool.query(
        `select 1 from public.session_charges c
          where c.gang_id = $1 and public.charge_outstanding(c.id) < 0`,
        [g.gangId],
      );
      expect(neg, `round ${round}`).toHaveLength(0);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 3. ห้ามให้เครดิตตัวเอง
// ---------------------------------------------------------------------------

describe('WO-B5b-3 — credit_topup ห้ามให้ตัวเอง (actor ≠ recipient)', () => {
  it('🔴 admin และ owner ให้เครดิตตัวเอง ⇒ FORBIDDEN · ให้คนอื่น/แอดมินให้ owner ผ่าน', async () => {
    const g = await newGang();
    const admin = await addMember(g.gangId, 'admin');
    const m = await addMember(g.gangId);

    for (const self of [g.owner, admin.userId]) {
      let detail = '';
      await expect(
        pool
          .query(`select public.credit_topup($1, $2, 10.00, 'ให้ตัวเอง', $3)`, [g.gangId, self, self])
          .catch((e: { detail?: string }) => {
            detail = e.detail ?? '';
            throw e;
          }),
        self,
      ).rejects.toThrow(/FORBIDDEN/);
      expect(detail).toContain('ตัวเอง');
      expect(await balanceOf(g.gangId, self)).toBe('0.00');
    }

    await pool.query(`select public.credit_topup($1, $2, 10.00, 'ให้สมาชิก', $3)`, [g.gangId, m.userId, g.owner]);
    await pool.query(`select public.credit_topup($1, $2, 10.00, 'แอดมินให้ owner', $3)`, [g.gangId, g.owner, admin.userId]);
    await pool.query(`select public.credit_topup($1, $2, 10.00, 'owner ให้แอดมิน', $3)`, [g.gangId, admin.userId, g.owner]);
    expect(await balanceOf(g.gangId, g.owner)).toBe('10.00');
    expect(await balanceOf(g.gangId, admin.userId)).toBe('10.00');
  });
});

// ---------------------------------------------------------------------------
// 4. EXECUTE matrix
// ---------------------------------------------------------------------------

describe('WO-B5b-3 — EXECUTE matrix', () => {
  it('🔴 leave_gang / credit_topup: service_role เท่านั้น · ไม่มี overload ซ้ำ', async () => {
    const { rows } = await pool.query<{ sig: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text sig, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('leave_gang', 'credit_topup')`,
    );
    expect(new Set(rows.map((r) => r.sig)).size).toBe(2);
    for (const r of rows) expect(r.ok, `${r.sig} → ${r.role}`).toBe(r.role === 'service_role');
  });
});
