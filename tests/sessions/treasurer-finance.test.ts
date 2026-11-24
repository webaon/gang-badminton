/**
 * WO-R-roles-2a DoD (ADR-015 · ขั้น MIGRATE กลุ่มการเงิน · migration 0051) — เหรัญญิกทำงานการเงินได้จริงผ่าน RLS/DB function
 *
 *   A. ผู้ถือ 'treasurer' อ่านการเงินทั้งก๊วนได้ (payments, allocations, charges, adjustments, credit_*, expenses, incomes, สลิป,
 *      event_logs เฉพาะ payment.* / audit.credit_*) และเขียน expenses/incomes + ตรวจ/แก้สลิปได้ (payments.update)
 *   B. เหรัญญิกเรียก DB function การเงินได้ (set_payment_received_amount, record_overpayment, credit_cash_payout,
 *      credit_return_charge) แต่ credit_topup (Q2ก) ไม่ได้ · ผู้จัดคิว/สมาชิกธรรมดา/อดีตเหรัญญิก/เหรัญญิกก๊วนอื่น/คนนอก ไม่ได้ทุกช่อง
 *   C. Q6ก: event_logs ที่เหรัญญิกเห็น = (ไม่ใช่ admin-only) ∪ payment.* ∪ audit.credit_* — ไม่เห็น audit อื่น (รวม audit.role_*)
 *   D. ถอนชุดสิทธิ์/ออกจากก๊วน ⇒ หลุดทันทีทั้ง RLS และ DB function
 *   E. TS ↔ DB ไม่ drift: can({role:'member', extra}) ตรงกับ has_gang_permission ทุก action
 *   F. concurrency 20 รอบ: เหรัญญิกทำงานการเงินพร้อมกับถูกถอน/ออกจากก๊วน ⇒ ไม่ deadlock · หลังถอนแล้วทำไม่ได้
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, runConcurrently } from '../helpers/db';
import { can } from '@/domain/permissions/can';
import { ACTIONS, FEATURES, type GangFeatures } from '@/domain/permissions/types';
import { ROLE_PRESETS, isDelegableAction } from '@/domain/permissions/delegable';

afterAll(async () => {
  await pool.end();
});

const ALL_ON = Object.fromEntries(FEATURES.map((f) => [f, true])) as GangFeatures;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`tf-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
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

const assign = (gangId: string, userId: string, key: string, actor: string) =>
  pool.query(`select public.assign_gang_role($1, $2, $3, $4, 'cid-tf')`, [gangId, userId, key, actor]);

let monthCounter = 0;
const nextMonth = () => {
  const n = monthCounter++;
  return new Date(Date.UTC(1900 + Math.floor(n / 12), n % 12, 1)).toISOString().slice(0, 10);
};

type World = {
  gangId: string;
  orgId: string;
  owner: string;
  treasurer: Member;
  scheduler: Member;
  both: Member;
  plain: Member; // payer — เจ้าของหนี้/สลิป
  ex: Member; // เคยเป็นเหรัญญิก ถูกถอนแล้ว
  outsider: string;
  otherGangTreasurer: Member;
  otherGangId: string;
  chargeId: string;
  paymentId: string; // ของ plain (verified)
  submittedPaymentId: string; // ของ plain (submitted) — ให้กรอกยอดโอนจริง
  overPaymentId: string; // verified + received 130 — ให้ record_overpayment
  returnChargeId: string; // จ่ายแล้วแต่ถูกลดหนี้ — ให้ย้ายเข้าเครดิต
  payoutUser: Member; // มีเครดิต 50 ไม่มีหนี้
  adjustmentId: string;
};

async function newPayment(gangId: string, owner: string, payer: string, amount: number, verified: boolean) {
  const {
    rows: [p],
  } = await pool.query<{ id: string }>(
    `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, $3, $4) returning id`,
    [gangId, payer, amount, owner],
  );
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payer]);
  if (verified) await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, owner]);
  return p.id;
}

async function buildWorld(): Promise<World> {
  const owner = await newUser();
  const {
    rows: [g],
  } = await pool.query<{ id: string; org_id: string }>(`select id, org_id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-tf-${crypto.randomUUID()}`,
  ]);
  const [treasurer, scheduler, both, plain, ex, payoutUser] = [
    await addMember(g.id),
    await addMember(g.id),
    await addMember(g.id),
    await addMember(g.id),
    await addMember(g.id),
    await addMember(g.id),
  ];
  const outsider = await newUser();

  const other = await (async () => {
    const o = await newUser();
    const {
      rows: [og],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [o, `ก๊วน-tf-other-${crypto.randomUUID()}`]);
    const t = await addMember(og.id);
    await assign(og.id, t.userId, 'treasurer', o);
    return { gangId: og.id, treasurer: t };
  })();

  await assign(g.id, treasurer.userId, 'treasurer', owner);
  await assign(g.id, scheduler.userId, 'scheduler', owner);
  await assign(g.id, both.userId, 'treasurer', owner);
  await assign(g.id, both.userId, 'scheduler', owner);
  await assign(g.id, ex.userId, 'treasurer', owner);
  await pool.query(`select public.revoke_gang_role($1, $2, 'treasurer', $3, 'cid-tf')`, [g.id, ex.userId, owner]);

  // หนี้ของ plain + สลิป verified
  const {
    rows: [ch],
  } = await pool.query<{ id: string }>(
    `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
     values ($1, 'monthly_fee', $2, $3::date, 100) returning id`,
    [g.id, plain.memberId, nextMonth()],
  );
  const {
    rows: [pay],
  } = await pool.query<{ id: string }>(`select id from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`, [
    g.id,
    plain.userId,
    [ch.id],
    owner,
  ]);
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [pay.id, plain.userId]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [pay.id, owner]);
  const {
    rows: [adj],
  } = await pool.query<{ id: string }>(
    `select (public.add_payment_adjustment($1, 'credit', -5, 'ส่วนลด', null, $2)).id id`,
    [ch.id, owner],
  );

  const submittedPaymentId = await newPayment(g.id, owner, plain.userId, 100, false);
  const overPaymentId = await newPayment(g.id, owner, plain.userId, 100, true);
  await pool.query(`select public.set_payment_received_amount($1, 130, $2)`, [overPaymentId, owner]);

  // ย้ายเข้าเครดิต: charge ที่จ่ายแล้วถูกลดหนี้
  const {
    rows: [rc],
  } = await pool.query<{ id: string }>(
    `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
     values ($1, 'monthly_fee', $2, $3::date, 50) returning id`,
    [g.id, plain.memberId, nextMonth()],
  );
  const {
    rows: [rp],
  } = await pool.query<{ id: string }>(`select id from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`, [
    g.id,
    plain.userId,
    [rc.id],
    owner,
  ]);
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [rp.id, plain.userId]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [rp.id, owner]);
  await pool.query(`select public.add_payment_adjustment($1, 'credit', -50, 'ยกเลิก', null, $2)`, [rc.id, owner]);

  await pool.query(`select public.credit_topup($1, $2, 50, 'เตรียม', $3)`, [g.id, payoutUser.userId, owner]);

  await pool.query(`insert into public.gang_expenses (gang_id, category, amount) values ($1, 'ค่าสนาม', 100)`, [g.id]);
  await pool.query(`insert into public.gang_incomes (gang_id, category, amount) values ($1, 'สปอนเซอร์', 500)`, [g.id]);
  await pool.query(
    `insert into storage.objects (bucket_id, name, owner) values ('payment-slips', $1, $2)`,
    [`${g.id}/${crypto.randomUUID()}.png`, plain.userId],
  );

  return {
    gangId: g.id,
    orgId: g.org_id,
    owner,
    treasurer,
    scheduler,
    both,
    plain,
    ex,
    outsider,
    otherGangTreasurer: other.treasurer,
    otherGangId: other.gangId,
    chargeId: ch.id,
    paymentId: pay.id,
    submittedPaymentId,
    overPaymentId,
    returnChargeId: rc.id,
    payoutUser,
    adjustmentId: adj.id,
  };
}

let worldP: Promise<World> | null = null;
const world = () => (worldP ??= buildWorld());

/** นับแถวที่ผู้ใช้เห็นผ่าน RLS (authenticated จริง) */
async function visible(userId: string, sql: string): Promise<number> {
  return asRole('authenticated', userId, async (c) => {
    const { rows } = await c.query<{ n: string }>(`select count(*)::text n from (${sql}) q`);
    return Number(rows[0].n);
  });
}

/** ผลของคำสั่งเขียนในฐานะผู้ใช้จริง: 'allow' (กระทบ ≥1 แถว) | 'deny' (0 แถวหรือ 42501) | err:<code> */
async function write(userId: string, sql: string): Promise<string> {
  return asRole('authenticated', userId, async (c) => {
    try {
      const r = await c.query(sql);
      return r.rowCount && r.rowCount > 0 ? 'allow' : 'deny';
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'unknown';
      return code === '42501' ? 'deny' : `err:${code}`;
    }
  });
}

/** เรียก DB function ในฐานะ actor (service_role path) ใน txn แล้ว rollback — 'allow' | 'deny' (FORBIDDEN) | err:<message> */
async function tryFn(sql: string, params: unknown[]): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(sql, params);
    return 'allow';
  } catch (e) {
    const err = e as { message?: string; code?: string };
    if (err.code === 'P0001') return err.message === 'FORBIDDEN' ? 'deny' : `err:${err.message}`;
    return `sqlstate:${err.code}`;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

// ---------------------------------------------------------------------------
// A. RLS — อ่าน/เขียน
// ---------------------------------------------------------------------------

describe('R-roles-2a A — เหรัญญิกผ่าน RLS การเงิน', () => {
  it('🔴 อ่านการเงินทั้งก๊วนได้: เหรัญญิก/ถือสองชุด เห็นเท่า owner ทุกตาราง · ผู้จัดคิว/สมาชิกธรรมดา/อดีต/ก๊วนอื่น/คนนอก ไม่เห็นของคนอื่น', async () => {
    const w = await world();
    const g = w.gangId;
    const tables: Record<string, string> = {
      payments: `select 1 from public.payments where gang_id = '${g}'`,
      payment_allocations: `select 1 from public.payment_allocations where payment_id in (select id from public.payments where gang_id = '${g}')`,
      session_charges: `select 1 from public.session_charges where gang_id = '${g}'`,
      payment_adjustments: `select 1 from public.payment_adjustments where session_charge_id in (select id from public.session_charges where gang_id = '${g}')`,
      credit_ledger: `select 1 from public.credit_ledger where gang_id = '${g}'`,
      credit_balances: `select 1 from public.credit_balances where gang_id = '${g}'`,
      gang_expenses: `select 1 from public.gang_expenses where gang_id = '${g}'`,
      gang_incomes: `select 1 from public.gang_incomes where gang_id = '${g}'`,
      slips: `select 1 from storage.objects where bucket_id = 'payment-slips' and name like '${g}/%'`,
    };
    for (const [name, sql] of Object.entries(tables)) {
      const all = await visible(w.owner, sql);
      expect(all, `${name}: owner ต้องเห็นอย่างน้อย 1 แถว (fixture)`).toBeGreaterThan(0);
      expect(await visible(w.treasurer.userId, sql), `${name} ← เหรัญญิก`).toBe(all);
      expect(await visible(w.both.userId, sql), `${name} ← ถือสองชุด`).toBe(all);
      for (const [who, uid] of [
        ['ผู้จัดคิว', w.scheduler.userId],
        ['อดีตเหรัญญิก', w.ex.userId],
        ['เหรัญญิกก๊วนอื่น', w.otherGangTreasurer.userId],
        ['คนนอก', w.outsider],
      ] as const) {
        expect(await visible(uid, sql), `${name} ← ${who}`).toBe(0);
      }
    }
    // สมาชิกธรรมดา (เจ้าของหนี้/สลิป) เห็นเฉพาะของตัวเอง — ไม่ได้อะไรเพิ่ม
    const ownPayments = await visible(w.plain.userId, tables.payments);
    expect(ownPayments).toBe(await visible(w.owner, tables.payments)); // plain เป็นเจ้าของสลิปทั้งหมดใน fixture
    expect(await visible(w.plain.userId, tables.gang_expenses)).toBe(0);
    expect(await visible(w.plain.userId, tables.gang_incomes)).toBe(0);
    expect(await visible(w.plain.userId, tables.credit_ledger)).toBe(0); // plain ไม่มีเครดิต · ledger ของ payoutUser ต้องไม่รั่ว
  });

  it('🔴 เขียน expenses/incomes ได้เฉพาะผู้ถือ gang.finance.manage (เหรัญญิก) · คนอื่นทุกประเภทเขียนไม่ได้', async () => {
    const w = await world();
    const g = w.gangId;
    const ops = (tag: string) => [
      `insert into public.gang_expenses (gang_id, category, amount) values ('${g}', '${tag}', 1)`,
      `update public.gang_expenses set category = category where gang_id = '${g}'`,
      `delete from public.gang_expenses where gang_id = '${g}' and category = 'ค่าสนาม'`,
      `insert into public.gang_incomes (gang_id, category, amount) values ('${g}', '${tag}', 1)`,
      `update public.gang_incomes set category = category where gang_id = '${g}'`,
    ];
    for (const who of [w.treasurer.userId, w.both.userId]) {
      const res = [];
      for (const sql of ops('t')) res.push(await write(who, sql));
      expect(res).toEqual(['allow', 'allow', 'allow', 'allow', 'allow']);
    }
    for (const [name, uid] of [
      ['ผู้จัดคิว', w.scheduler.userId],
      ['สมาชิกธรรมดา', w.plain.userId],
      ['อดีตเหรัญญิก', w.ex.userId],
      ['เหรัญญิกก๊วนอื่น', w.otherGangTreasurer.userId],
      ['คนนอก', w.outsider],
    ] as const) {
      for (const sql of ops('x')) {
        expect(await write(uid, sql), `${name}: ${sql.slice(0, 45)}`).toBe('deny');
      }
    }
    // delete incomes: เหรัญญิกลบได้ (ใน txn ที่ rollback) · สมาชิกธรรมดาลบไม่ได้
    expect(await write(w.treasurer.userId, `delete from public.gang_incomes where gang_id = '${g}'`)).toBe('allow');
    expect(await write(w.plain.userId, `delete from public.gang_incomes where gang_id = '${g}'`)).toBe('deny');
  });

  it('🔴 payments: เหรัญญิกแก้สลิปของคนอื่นได้ (ตรวจสลิป) · ผู้จัดคิว/สมาชิกธรรมดา/อดีต/ก๊วนอื่น แก้สลิปคนอื่นไม่ได้ · สลิปในที่เก็บ: เหรัญญิกอัปเดต/ลบได้ ผู้อื่นไม่ได้', async () => {
    const w = await world();
    const g = w.gangId;
    const upd = `update public.payments set amount = amount where id = '${w.submittedPaymentId}'`;
    expect(await write(w.plain.userId, upd)).toBe('allow'); // เจ้าของสลิปเอง
    expect(await write(w.treasurer.userId, upd)).toBe('allow');
    expect(await write(w.both.userId, upd)).toBe('allow');
    for (const uid of [w.scheduler.userId, w.ex.userId, w.otherGangTreasurer.userId, w.outsider]) {
      expect(await write(uid, upd)).toBe('deny');
    }

    const slipUpd = `update storage.objects set name = name where bucket_id = 'payment-slips' and name like '${g}/%'`;
    const slipDel = `delete from storage.objects where bucket_id = 'payment-slips' and name like '${g}/%'`;
    expect(await write(w.treasurer.userId, slipUpd)).toBe('allow');
    // DELETE บน storage.objects ถูกปิดทุก role ในระบบนี้ (golden: owner ก็ deny) ⇒ เหรัญญิกต้องเท่ากับ owner ไม่เกิน
    expect(await write(w.treasurer.userId, slipDel)).toBe(await write(w.owner, slipDel));
    for (const uid of [w.scheduler.userId, w.ex.userId, w.otherGangTreasurer.userId, w.outsider]) {
      expect(await write(uid, slipUpd), 'อัปเดตสลิป').toBe('deny');
      expect(await write(uid, slipDel), 'ลบสลิป').toBe('deny');
    }
  });

  it('🔴 is_payment_visible: เหรัญญิกเห็นสลิปทุกใบ · ผู้จัดคิว/ก๊วนอื่น/คนนอกไม่เห็น', async () => {
    const w = await world();
    const vis = (uid: string) =>
      asRole('authenticated', uid, async (c) => (await c.query<{ v: boolean }>(`select public.is_payment_visible($1) v`, [w.paymentId])).rows[0].v);
    expect(await vis(w.treasurer.userId)).toBe(true);
    expect(await vis(w.plain.userId)).toBe(true);
    for (const uid of [w.scheduler.userId, w.ex.userId, w.otherGangTreasurer.userId, w.outsider]) expect(await vis(uid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. DB function
// ---------------------------------------------------------------------------

describe('R-roles-2a B — DB function การเงิน × actor', () => {
  it('🔴 set_payment_received_amount / record_overpayment / credit_cash_payout / credit_return_charge: เหรัญญิก+admin ผ่าน · คนอื่น FORBIDDEN', async () => {
    const w = await world();
    const cases: [string, string, (a: string | null) => unknown[]][] = [
      ['set_payment_received_amount', `select public.set_payment_received_amount($1, 120, $2)`, (a) => [w.submittedPaymentId, a]],
      ['record_overpayment', `select public.record_overpayment($1, null, 'ทดสอบ', $2)`, (a) => [w.overPaymentId, a]],
      ['credit_cash_payout', `select public.credit_cash_payout($1, $2, 1, 'ทดสอบ', $3)`, (a) => [w.gangId, w.payoutUser.userId, a]],
      ['credit_return_charge', `select public.credit_return_charge($1, null, 'ทดสอบ', $2)`, (a) => [w.returnChargeId, a]],
    ];
    for (const [name, sql, params] of cases) {
      for (const [who, uid] of [
        ['owner', w.owner],
        ['เหรัญญิก', w.treasurer.userId],
        ['ถือสองชุด', w.both.userId],
      ] as const) {
        expect(await tryFn(sql, params(uid)), `${name} ← ${who}`).toBe('allow');
      }
      for (const [who, uid] of [
        ['ผู้จัดคิว', w.scheduler.userId],
        ['สมาชิกธรรมดา', w.plain.userId],
        ['อดีตเหรัญญิก', w.ex.userId],
        ['เหรัญญิกก๊วนอื่น', w.otherGangTreasurer.userId],
        ['คนนอก', w.outsider],
        ['ไม่มี actor', null],
      ] as const) {
        expect(await tryFn(sql, params(uid)), `${name} ← ${who}`).toBe('deny');
      }
    }
  });

  it('🔴 credit_topup (Q2ก): เหรัญญิกให้เครดิตไม่ได้ (FORBIDDEN) ทั้งให้คนอื่นและตัวเอง · admin/owner ให้คนอื่นได้ · ห้ามให้ตัวเองทุกบทบาท', async () => {
    const w = await world();
    const topup = `select public.credit_topup($1, $2, 1, 'ทดสอบ', $3)`;
    expect(await tryFn(topup, [w.gangId, w.plain.userId, w.treasurer.userId])).toBe('deny');
    expect(await tryFn(topup, [w.gangId, w.treasurer.userId, w.treasurer.userId])).toBe('deny');
    expect(await tryFn(topup, [w.gangId, w.both.userId, w.both.userId])).toBe('deny');
    expect(await tryFn(topup, [w.gangId, w.plain.userId, w.scheduler.userId])).toBe('deny');
    expect(await tryFn(topup, [w.gangId, w.plain.userId, w.owner])).toBe('allow');
    expect(await tryFn(topup, [w.gangId, w.owner, w.owner])).toBe('deny'); // ตัวเอง
  });

  it('🔴 ผลจริงของเหรัญญิก: บันทึกยอดโอนจริง ⇒ record_overpayment สร้างเครดิต + audit ระบุ actor = เหรัญญิก (ไม่ใช่ owner)', async () => {
    const w = await world();
    const payer = await addMember(w.gangId);
    const pid = await newPayment(w.gangId, w.owner, payer.userId, 100, true);
    const t = w.treasurer.userId;
    await pool.query(`select public.set_payment_received_amount($1, 140, $2)`, [pid, t]);
    const {
      rows: [led],
    } = await pool.query<{ amount: string; created_by: string }>(
      `select (public.record_overpayment($1, null, 'โอนเกิน', $2)).amount::text amount, $2::uuid created_by`,
      [pid, t],
    );
    expect(led.amount).toBe('40.00');
    // audit.credit_* ที่ actor = เหรัญญิก (ไม่ใช่ owner) ต้องมีหลังบันทึก — ตรวจแบบกว้างเพราะชื่อ event ย่อยอาจเปลี่ยนตามเวอร์ชัน
    const { rows: any } = await pool.query<{ n: string }>(
      `select count(*)::text n from public.event_logs where gang_id = $1 and event_type like 'audit.credit\_%' and actor_id = $2`,
      [w.gangId, t],
    );
    expect(Number(any[0].n)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// C. Q6ก — event_logs
// ---------------------------------------------------------------------------

describe('R-roles-2a C — event_logs (Q6ก)', () => {
  it('🔴 เหรัญญิกเห็น (ไม่ใช่ admin-only) ∪ payment.* ∪ audit.credit_* เท่านั้น · ไม่เห็น audit.role_* / session.charges_committed / audit อื่น · ผู้จัดคิว/สมาชิกธรรมดาเห็นเฉพาะที่ไม่ใช่ admin-only', async () => {
    const w = await world();
    // เพิ่ม event ที่ต้องถูกซ่อนจากเหรัญญิก
    await pool.query(
      `insert into public.event_logs (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
       values ($1, 'audit.tf_probe', 'gang', $1, $2, '{}'::jsonb),
              ($1, 'session.charges_committed', 'gang', $1, $2, '{}'::jsonb),
              ($1, 'membership.fees_generated', 'gang', $1, $2, '{}'::jsonb)`,
      [w.gangId, w.owner],
    );
    const types = (uid: string) =>
      asRole('authenticated', uid, async (c) =>
        (
          await c.query<{ event_type: string }>(`select distinct event_type from public.event_logs where gang_id = $1`, [w.gangId])
        ).rows.map((r) => r.event_type).sort(),
      );
    const { rows: all } = await pool.query<{ event_type: string; admin_only: boolean; finance: boolean }>(
      `select distinct event_type, public.event_type_is_admin_only(event_type) admin_only, public.event_type_is_finance(event_type) finance
         from public.event_logs where gang_id = $1`,
      [w.gangId],
    );
    // finance ⊂ admin_only (ไม่งั้น policy เปิดกว้างกว่าที่ตั้งใจ)
    for (const r of all) if (r.finance) expect(r.admin_only, r.event_type).toBe(true);
    const expectedTreasurer = all.filter((r) => !r.admin_only || r.finance).map((r) => r.event_type).sort();
    const expectedPlain = all.filter((r) => !r.admin_only).map((r) => r.event_type).sort();

    const seenT = await types(w.treasurer.userId);
    expect(seenT).toEqual(expectedTreasurer);
    expect(seenT.some((t) => t.startsWith('payment.'))).toBe(true);
    expect(seenT.some((t) => t.startsWith('audit.credit_'))).toBe(true);
    for (const hidden of ['audit.role_assigned', 'audit.role_revoked', 'audit.tf_probe', 'session.charges_committed', 'membership.fees_generated']) {
      expect(seenT, hidden).not.toContain(hidden);
    }
    expect(await types(w.both.userId)).toEqual(expectedTreasurer);
    for (const uid of [w.scheduler.userId, w.plain.userId, w.ex.userId]) expect(await types(uid)).toEqual(expectedPlain);
    expect(await types(w.otherGangTreasurer.userId)).toEqual([]);
    expect(await types(w.outsider)).toEqual([]);
    expect((await types(w.owner)).length).toBe(all.length);
  });

  it('🔴 event_type_is_finance: payment.* และ audit.credit_* เท่านั้น (ไม่รวม audit.creditx / audit.payment_ / session.*)', async () => {
    const { rows } = await pool.query<{ t: string; v: boolean }>(
      `select t, public.event_type_is_finance(t) v from unnest($1::text[]) t`,
      [[
        'payment.verified', 'payment.created', 'audit.credit_topup', 'audit.credit_applied', 'audit.credit_cash_payout',
        'audit.creditx', 'audit.payment_adjusted', 'audit.role_assigned', 'session.charges_committed', 'registration.cancelled',
      ]],
    );
    const m = Object.fromEntries(rows.map((r) => [r.t, r.v]));
    expect(m).toMatchObject({
      'payment.verified': true,
      'payment.created': true,
      'audit.credit_topup': true,
      'audit.credit_applied': true,
      'audit.credit_cash_payout': true,
      'audit.creditx': false,
      'audit.payment_adjusted': false,
      'audit.role_assigned': false,
      'session.charges_committed': false,
      'registration.cancelled': false,
    });
  });
});

// ---------------------------------------------------------------------------
// D. หลุดทันที
// ---------------------------------------------------------------------------

describe('R-roles-2a D — ถอนชุดสิทธิ์/ออกจากก๊วน ⇒ หลุดทันทีทั้ง RLS และ DB function', () => {
  it('🔴 ถอน treasurer ⇒ statement ถัดไปอ่าน/เขียน/เรียกฟังก์ชันไม่ได้ · มอบใหม่ ⇒ ได้อีก', async () => {
    const w = await world();
    const m = await addMember(w.gangId);
    await assign(w.gangId, m.userId, 'treasurer', w.owner);
    const readSql = `select 1 from public.payments where gang_id = '${w.gangId}'`;
    const fn = `select public.set_payment_received_amount($1, 120, $2)`;
    const insertExp = `insert into public.gang_expenses (gang_id, category, amount) values ('${w.gangId}', 'd', 1)`;

    expect(await visible(m.userId, readSql)).toBeGreaterThan(0);
    expect(await write(m.userId, insertExp)).toBe('allow');
    expect(await tryFn(fn, [w.submittedPaymentId, m.userId])).toBe('allow');

    await pool.query(`select public.revoke_gang_role($1, $2, 'treasurer', $3, 'cid-tf')`, [w.gangId, m.userId, w.owner]);
    expect(await visible(m.userId, readSql)).toBe(0);
    expect(await write(m.userId, insertExp)).toBe('deny');
    expect(await tryFn(fn, [w.submittedPaymentId, m.userId])).toBe('deny');

    await assign(w.gangId, m.userId, 'treasurer', w.owner);
    expect(await visible(m.userId, readSql)).toBeGreaterThan(0);
  });

  it('🔴 เหรัญญิกออกจากก๊วน ⇒ เห็น/ทำอะไรไม่ได้ · กลับเข้ามาใหม่ไม่ได้สิทธิ์คืน', async () => {
    const w = await world();
    const m = await addMember(w.gangId);
    await assign(w.gangId, m.userId, 'treasurer', w.owner);
    await pool.query(`select public.leave_gang($1, $2, 'cid-tf')`, [w.gangId, m.userId]);
    expect(await visible(m.userId, `select 1 from public.payments where gang_id = '${w.gangId}'`)).toBe(0);
    expect(await visible(m.userId, `select 1 from public.gang_expenses where gang_id = '${w.gangId}'`)).toBe(0);
    expect(await tryFn(`select public.set_payment_received_amount($1, 120, $2)`, [w.submittedPaymentId, m.userId])).toBe('deny');
    const { rows: u } = await pool.query<{ email: string }>(`select email from auth.users where id = $1`, [m.userId]);
    await pool.query(`select public.add_gang_member_by_email($1, $2, 'member', $3, 'cid-tf')`, [w.gangId, u[0].email, w.owner]);
    expect(await visible(m.userId, `select 1 from public.gang_expenses where gang_id = '${w.gangId}'`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E. TS ↔ DB
// ---------------------------------------------------------------------------

describe('R-roles-2a E — can() รู้ชุดสิทธิ์ตรงกับ DB', () => {
  it('🔴 can({role:member, extra}) ตรงกับ has_gang_permission/actor_has_permission ทุก action × {เหรัญญิก, ผู้จัดคิว, ถือสองชุด, ไม่มีชุด}', async () => {
    const w = await world();
    const subjects: [string, string, readonly string[]][] = [
      ['เหรัญญิก', w.treasurer.userId, ROLE_PRESETS.treasurer],
      ['ผู้จัดคิว', w.scheduler.userId, ROLE_PRESETS.scheduler],
      ['ถือสองชุด', w.both.userId, [...ROLE_PRESETS.treasurer, ...ROLE_PRESETS.scheduler]],
      ['ไม่มีชุด', w.plain.userId, []],
      ['อดีตเหรัญญิก', w.ex.userId, []],
    ];
    for (const [name, uid, extra] of subjects) {
      for (const a of ACTIONS) {
        const ts = can({ role: 'member', features: ALL_ON, extra: extra as never }, a);
        const base = can({ role: 'member', features: ALL_ON }, a);
        const viaExtra = ts && !base; // ส่วนที่ชุดสิทธิ์เพิ่มให้
        const db = (
          await pool.query<{ v: boolean }>(`select public.actor_has_permission($1, $2, $3) v`, [w.gangId, uid, a])
        ).rows[0].v;
        expect(db, `${name}: ${a} (TS เพิ่ม=${viaExtra})`).toBe(viaExtra);
      }
    }
  });

  it('🔴 gangs_with_permission(action) ≡ { gang | has_gang_permission(gang, action) } ทุก identity × ก๊วน × action (policy ใช้รูป InitPlan ต้องความหมายเท่ากับตัวต่อแถว)', async () => {
    const w = await world();
    const orgAdmin = await newUser();
    await pool.query(`insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'admin')`, [w.orgId, orgAdmin]);
    const subjects: [string, string][] = [
      ['owner', w.owner],
      ['เหรัญญิก', w.treasurer.userId],
      ['ผู้จัดคิว', w.scheduler.userId],
      ['ถือสองชุด', w.both.userId],
      ['สมาชิกธรรมดา', w.plain.userId],
      ['อดีตเหรัญญิก', w.ex.userId],
      ['เหรัญญิกก๊วนอื่น', w.otherGangTreasurer.userId],
      ['แอดมินองค์กร', orgAdmin],
      ['คนนอก', w.outsider],
    ];
    let checked = 0;
    for (const [name, uid] of subjects) {
      await asRole('authenticated', uid, async (c) => {
        for (const gang of [w.gangId, w.otherGangId]) {
          for (const a of [...ACTIONS, 'foo.bar']) {
            const { rows } = await c.query<{ h: boolean; g: boolean }>(
              `select public.has_gang_permission($1, $2) h, $1::uuid = any (public.gangs_with_permission($2)) g`,
              [gang, a],
            );
            expect(rows[0].g, `${name} · ${gang === w.gangId ? 'ก๊วนนี้' : 'ก๊วนอื่น'} · ${a}`).toBe(rows[0].h);
            checked++;
          }
        }
      });
    }
    expect(checked).toBeGreaterThan(700);
    // anon ไม่ได้อะไรเลย
    const anon = await asRole('anon', null, async (c) => (await c.query<{ g: string[] }>(`select public.gangs_with_permission('payment.verify') g`)).rows[0].g);
    expect(anon).toEqual([]);
  });

  it('🔴 can(): extra ไม่มีผลกับ role อื่น/action ที่ห้าม delegate/ไม่ส่ง extra = พฤติกรรมเดิม', () => {
    const t = ROLE_PRESETS.treasurer;
    expect(can({ role: 'member', extra: t }, 'payment.verify')).toBe(true);
    expect(can({ role: 'member', extra: t }, 'credit.topup')).toBe(false);
    expect(can({ role: 'member' }, 'payment.verify')).toBe(false);
    expect(can({ role: null, extra: t }, 'payment.verify')).toBe(false);
    expect(can({ role: null, orgRole: 'admin', extra: [] }, 'payment.verify')).toBe(true);
    // ใส่ action ที่ห้าม delegate ใน extra ก็ไม่มีผล
    expect(can({ role: 'member', extra: ['gang.member.manage', 'gang.ownership.transfer', 'gang.update'] }, 'gang.member.manage')).toBe(false);
    expect(can({ role: 'member', extra: ['gang.member.manage'] }, 'gang.update')).toBe(false);
    // feature flag ยังตรวจก่อน
    expect(can({ role: 'member', features: { guests: false }, extra: ['registration.create.guest'] }, 'registration.create.guest')).toBe(false);
    expect(can({ role: 'member', features: { guests: true }, extra: ['registration.create.guest'] }, 'registration.create.guest')).toBe(true);
    expect(isDelegableAction('registration.create.guest')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. concurrency
// ---------------------------------------------------------------------------

const ROUNDS = 20;

describe(`R-roles-2a F — concurrency ${ROUNDS} รอบ`, () => {
  it('🔴 เหรัญญิกกรอกยอดโอนจริง/เขียนรายจ่ายพร้อมกับถูกถอน ⇒ ไม่ deadlock · สำเร็จเฉพาะก่อนถอน · หลังถอนครบทุกช่องปิด', async () => {
    const w = await world();
    for (let i = 0; i < ROUNDS; i++) {
      const m = await addMember(w.gangId);
      await assign(w.gangId, m.userId, 'treasurer', w.owner);
      const pid = await newPayment(w.gangId, w.owner, w.plain.userId, 100, false);

      const res = await runConcurrently(4, (c, k) => {
        switch (k) {
          case 0:
            return c.query(`select public.set_payment_received_amount($1, 120, $2)`, [pid, m.userId]);
          case 1:
            return c.query(`select public.revoke_gang_role($1, $2, 'treasurer', $3, 'cid-race')`, [w.gangId, m.userId, w.owner]);
          case 2:
            return c.query(`select public.set_payment_received_amount($1, 125, $2)`, [pid, m.userId]);
          default:
            return c.query(`select public.assign_gang_role($1, $2, 'scheduler', $3, 'cid-race')`, [w.gangId, m.userId, w.owner]);
        }
      });
      for (const r of res) {
        if (r.status === 'rejected') {
          const e = r.reason as { code?: string; message?: string };
          expect(e.code, `round ${i}: ${e.message}`).not.toBe('40P01');
          expect(e.message, `round ${i}`).toMatch(/FORBIDDEN|PAYMENT|VALIDATION/);
        }
      }
      expect(res[1].status, `revoke round ${i}`).toBe('fulfilled');
      expect(res[3].status, `assign scheduler round ${i}`).toBe('fulfilled');
      // หลังถอนเสร็จ: ปิดทุกช่อง
      expect(await tryFn(`select public.set_payment_received_amount($1, 130, $2)`, [pid, m.userId]), `round ${i}`).toBe('deny');
      expect(await visible(m.userId, `select 1 from public.payments where gang_id = '${w.gangId}' and payer_user_id <> '${m.userId}'`), `round ${i}`).toBe(0);
    }
  }, 180_000);

  it('🔴 เหรัญญิกหลายคนทำงานการเงินพร้อมกัน (กรอกยอด · บันทึกโอนเกิน · จ่ายคืนเงินสด · ย้ายเข้าเครดิต) กับ admin ให้เครดิต/ปิดรอบ ⇒ ไม่ deadlock · เครดิตไม่ติดลบ', async () => {
    const w = await world();
    for (let i = 0; i < ROUNDS; i++) {
      const payer = await addMember(w.gangId);
      const over = await newPayment(w.gangId, w.owner, payer.userId, 100, true);
      await pool.query(`select public.set_payment_received_amount($1, 130, $2)`, [over, w.owner]);
      const sub = await newPayment(w.gangId, w.owner, payer.userId, 100, false);
      const res = await runConcurrently(5, (c, k) => {
        switch (k) {
          case 0:
            return c.query(`select public.record_overpayment($1, null, 'race', $2)`, [over, w.treasurer.userId]);
          case 1:
            return c.query(`select public.record_overpayment($1, null, 'race', $2)`, [over, w.both.userId]);
          case 2:
            return c.query(`select public.set_payment_received_amount($1, 111, $2)`, [sub, w.treasurer.userId]);
          case 3:
            return c.query(`select public.credit_topup($1, $2, 5, 'race', $3)`, [w.gangId, payer.userId, w.owner]);
          default:
            return c.query(`select public.credit_cash_payout($1, $2, 1, 'race', $3)`, [w.gangId, w.payoutUser.userId, w.treasurer.userId]);
        }
      });
      for (const r of res) {
        if (r.status === 'rejected') {
          const e = r.reason as { code?: string; message?: string };
          expect(e.code, `round ${i}: ${e.message}`).not.toBe('40P01');
        }
      }
      // บันทึกโอนเกินเกิดครั้งเดียว (สลิปเดียว)
      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text n from public.credit_ledger where payment_id = $1 and type = 'overpayment'`,
        [over],
      );
      expect(Number(rows[0].n), `round ${i} overpayment once`).toBe(1);
      const { rows: neg } = await pool.query<{ n: string }>(`select count(*)::text n from public.credit_balances where gang_id = $1 and balance < 0`, [w.gangId]);
      expect(Number(neg[0].n), `round ${i}`).toBe(0);
    }
  }, 180_000);
});
