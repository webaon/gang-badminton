/**
 * WO-B5b-1 (N1) DoD — credit_ledger.seq: ลำดับรายการเครดิตต่อ (gang,user) ไม่ซ้ำ ไม่ข้าม ไม่ขึ้นกับนาฬิกา
 *
 *   1. backfill: ข้อมูลเดิมทั้งฐานได้ seq 1..n ต่อคน เรียงตามที่เกิดจริง · last_seq = n · balance_after เดินต่อกันถูก
 *   2. เขียนใต้ FOR UPDATE: record_overpayment + apply_credit พร้อมกัน 20 รอบ ⇒ seq ไม่ซ้ำไม่ข้าม ยอดไม่ติดลบ
 *      · ปิดรอบ (auto-apply) ชนกับ record_overpayment พร้อมกัน ⇒ ไม่ deadlock (40P01)
 *   3. ทรานแซกชันที่ล้ม (สลิปซ้ำ) ไม่กิน seq · apply_credit ที่ไม่มีอะไรให้หักไม่กิน seq
 *   4. NOT NULL / UNIQUE / append-only ยังบังคับอยู่ (trigger เปิดคืนหลัง backfill)
 *   5. ผู้อ่าน (getMyCredit) เรียงด้วย seq แม้ created_at สลับลำดับ
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, runConcurrently } from '../helpers/db';
import { toSatang } from '@/domain/billing/money';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`seq-${crypto.randomUUID()}@example.com`],
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
    `ก๊วน-seq-${crypto.randomUUID()}`,
  ]);
  return { gangId: gang.id, owner };
}

async function addMember(gangId: string): Promise<{ userId: string; memberId: string }> {
  const userId = await newUser();
  const {
    rows: [m],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
    [gangId, userId],
  );
  return { userId, memberId: m.id };
}

let monthCounter = 0;

async function charge(gangId: string, memberId: string, amount: string): Promise<string> {
  const month = new Date(Date.UTC(2010, monthCounter++ % 120, 1 + Math.floor(monthCounter / 120))).toISOString().slice(0, 10);
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
    `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, $3, $4) returning id`,
    [gangId, payer, amount, actor],
  );
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, payer]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, actor]);
  return p.id;
}

const overpay = (paymentId: string, amount: string, actor: string) =>
  pool.query(`select public.record_overpayment($1, $2, 'ทดสอบ seq', $3)`, [paymentId, amount, actor]);

const lastSeq = async (gangId: string, userId: string) =>
  Number(
    (
      await pool.query<{ s: string }>(
        `select last_seq::text s from public.credit_balances where gang_id = $1 and user_id = $2`,
        [gangId, userId],
      )
    ).rows[0]?.s ?? '0',
  );

/** seq ต้องเป็น 1..n ไม่ซ้ำไม่ข้าม · last_seq = n · balance_after ตามลำดับ seq เดินต่อกัน = ยอด cache */
async function expectSeqConsistent(gangId: string, userId: string, note = '') {
  const { rows } = await pool.query<{ seq: string; amount: string; balance_after: string }>(
    `select seq::text, amount::text, balance_after::text from public.credit_ledger
      where gang_id = $1 and user_id = $2 order by seq`,
    [gangId, userId],
  );
  rows.forEach((r, i) => expect(Number(r.seq), `seq ไม่ซ้ำไม่ข้าม ${note}`).toBe(i + 1));
  expect(await lastSeq(gangId, userId), `last_seq = จำนวนรายการ ${note}`).toBe(rows.length);
  let running = 0;
  for (const r of rows) {
    running += toSatang(r.amount);
    expect(toSatang(r.balance_after), `balance_after ต่อเนื่องตาม seq ${note}`).toBe(running);
  }
  const cache = (
    await pool.query<{ b: string }>(
      `select balance::text b from public.credit_balances where gang_id = $1 and user_id = $2`,
      [gangId, userId],
    )
  ).rows[0]?.b;
  if (rows.length > 0) expect(toSatang(cache!), `cache = Σ ledger ${note}`).toBe(running);
}

describe('WO-B5b-1 N1 — backfill ข้อมูลเดิม', () => {
  it('🔴 ทุก (gang,user) ที่มีเครดิตในฐานนี้: seq = 1..n ไม่ซ้ำไม่ข้าม และ last_seq = n', async () => {
    const { rows: bad } = await pool.query<{ gang_id: string; user_id: string; n: string; mx: string; dist: string; ls: string | null }>(
      `select l.gang_id, l.user_id, count(*)::text n, max(l.seq)::text mx, count(distinct l.seq)::text dist,
              (select b.last_seq::text from public.credit_balances b where b.gang_id = l.gang_id and b.user_id = l.user_id) ls
         from public.credit_ledger l
        group by l.gang_id, l.user_id
       having count(*) <> max(l.seq) or count(*) <> count(distinct l.seq) or min(l.seq) <> 1
           or count(*) <> (select b.last_seq from public.credit_balances b where b.gang_id = l.gang_id and b.user_id = l.user_id)`,
    );
    expect(bad).toEqual([]);
    // หมายเหตุ: ไม่ตรวจ balance_after ทั้งฐานที่นี่ — ข้อมูลเก่าก่อน 0046 มีแถวที่ created_at สลับลำดับกับลำดับล็อกจริง
    // (นี่คืออาการของ N1 เอง) และ ledger แก้ไม่ได้ ⇒ backfill เก็บลำดับตาม created_at ตามที่ตกลง · แถวใหม่ตรวจโดย expectSeqConsistent
  });

  it('🔴 SQL backfill ใน migration จัดลำดับตาม (created_at,id) ถูก แม้ seq เดิมเพี้ยน (จำลองใน txn แล้ว rollback)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    for (const amt of ['10.00', '20.00', '30.00']) {
      await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), amt, g.owner);
    }
    const before = (
      await pool.query<{ id: string }>(
        `select id from public.credit_ledger where gang_id = $1 and user_id = $2 order by created_at, id`,
        [g.gangId, m.userId],
      )
    ).rows.map((r) => r.id);

    const c = await pool.connect();
    try {
      await c.query('begin');
      // superuser + replica ⇒ ข้าม trigger append-only เฉพาะใน txn นี้ (ไม่ล็อกตาราง)
      await c.query(`set local session_replication_role = replica`);
      await c.query(`update public.credit_ledger set seq = 1000 + seq where gang_id = $1 and user_id = $2`, [g.gangId, m.userId]);
      await c.query(`update public.credit_balances set last_seq = 0 where gang_id = $1 and user_id = $2`, [g.gangId, m.userId]);
      // ===== ส่วน backfill เดียวกับ 20260818000046 (กรองเฉพาะก๊วนของเทสต์) =====
      await c.query(
        `with numbered as (
           select id, row_number() over (partition by gang_id, user_id order by created_at, id) as rn
             from public.credit_ledger where gang_id = $1
         )
         update public.credit_ledger l set seq = n.rn from numbered n where n.id = l.id`,
        [g.gangId],
      );
      await c.query(
        `update public.credit_balances b
            set last_seq = coalesce((select max(l.seq) from public.credit_ledger l
                                      where l.gang_id = b.gang_id and l.user_id = b.user_id), 0)
          where b.gang_id = $1`,
        [g.gangId],
      );
      const { rows } = await c.query<{ id: string; seq: string }>(
        `select id, seq::text from public.credit_ledger where gang_id = $1 and user_id = $2 order by seq`,
        [g.gangId, m.userId],
      );
      expect(rows.map((r) => r.id)).toEqual(before);
      expect(rows.map((r) => r.seq)).toEqual(['1', '2', '3']);
      const { rows: b } = await c.query<{ s: string }>(
        `select last_seq::text s from public.credit_balances where gang_id = $1 and user_id = $2`,
        [g.gangId, m.userId],
      );
      expect(b[0].s).toBe('3');
    } finally {
      await c.query('rollback');
      c.release();
    }
    await expectSeqConsistent(g.gangId, m.userId, 'หลัง rollback ข้อมูลกลับเดิม');
  });
});

describe('WO-B5b-1 N1 — ออกเลขใต้ FOR UPDATE', () => {
  it('เรียงตามที่เกิดจริง: โอนเกิน → หัก → โอนเกิน ⇒ seq 1,2,3 และ balance_after ตรง', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), '100.00', g.owner);
    await charge(g.gangId, m.memberId, '30.00'); // auto-apply = seq 2
    await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), '5.00', g.owner);

    const { rows } = await pool.query<{ seq: string; type: string; balance_after: string }>(
      `select seq::text, type, balance_after::text from public.credit_ledger where gang_id = $1 and user_id = $2 order by seq`,
      [g.gangId, m.userId],
    );
    expect(rows.map((r) => [r.seq, r.type, r.balance_after])).toEqual([
      ['1', 'overpayment', '100.00'],
      ['2', 'applied', '70.00'],
      ['3', 'overpayment', '75.00'],
    ]);
    await expectSeqConsistent(g.gangId, m.userId);
  });

  it('🔴 สลิปซ้ำ (ล้ม) และ apply_credit ที่ไม่มีอะไรให้หัก ไม่กิน seq → ไม่มีช่องว่าง', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await verifiedPayment(g.gangId, m.userId, '1.00', g.owner);
    await overpay(pay, '10.00', g.owner);
    await expect(overpay(pay, '10.00', g.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await pool.query(`select public.apply_credit($1, $2, null, $3)`, [g.gangId, m.userId, g.owner]); // ไม่มีหนี้
    expect(await lastSeq(g.gangId, m.userId)).toBe(1);
    await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), '1.00', g.owner);
    expect(await lastSeq(g.gangId, m.userId)).toBe(2);
    await expectSeqConsistent(g.gangId, m.userId);
  });

  it('🔴 concurrency: โอนเกิน ×3 + apply_credit มือ ×3 + ปิดรอบ (auto-apply) ×2 พร้อมกัน 20 รอบ — seq ไม่ซ้ำไม่ข้าม ไม่ติดลบ ไม่ 40P01', async () => {
    for (let round = 0; round < 20; round++) {
      const g = await newGang();
      const m = await addMember(g.gangId);
      await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), '40.00', g.owner);
      const pays = await Promise.all(
        [0, 1, 2].map(() => verifiedPayment(g.gangId, m.userId, '1.00', g.owner)),
      );
      // หนี้ 2 ก้อนเกิดตอนมีเครดิต 40 อยู่ ⇒ auto-apply หักไปแล้ว: ใช้ amount ใหญ่เกินเครดิตเพื่อให้เหลือหนี้ให้ apply มือแย่ง
      await charge(g.gangId, m.memberId, '25.00');
      await charge(g.gangId, m.memberId, '25.00');

      const jobs: ((c: import('pg').PoolClient) => Promise<unknown>)[] = [
        ...pays.map((p) => (c: import('pg').PoolClient) =>
          c.query(`select public.record_overpayment($1, 7.00, 'ชน', $2)`, [p, g.owner]),
        ),
        ...[0, 1, 2].map(() => (c: import('pg').PoolClient) =>
          c.query(`select public.apply_credit($1, $2, null, $3)`, [g.gangId, m.userId, g.owner]),
        ),
        ...[0, 1].map(() => async () => {
          await charge(g.gangId, m.memberId, '9.00'); // trigger auto-apply
        }),
      ];
      const results = await runConcurrently(jobs.length, (c, i) => jobs[i](c));
      for (const [i, r] of results.entries()) {
        const reason = r.status === 'rejected' ? String((r.reason as Error).message) : '';
        expect(r.status, `round ${round} job ${i}: ${reason}`).toBe('fulfilled');
      }
      await expectSeqConsistent(g.gangId, m.userId, `round ${round}`);
    }
  }, 120_000);
});

describe('WO-B5b-1 N1 — schema ยังบังคับอยู่', () => {
  it('seq NOT NULL (เขียนตรงโดยไม่มี seq ไม่ได้) · UNIQUE (gang,user,seq) · append-only ยังกัน UPDATE/DELETE', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    const pay = await verifiedPayment(g.gangId, m.userId, '1.00', g.owner);
    await overpay(pay, '10.00', g.owner);

    await expect(
      pool.query(
        `insert into public.credit_ledger (gang_id, user_id, type, amount, balance_after, payment_id, reason)
         values ($1, $2, 'overpayment', 5, 15, $3, 'x')`,
        [g.gangId, m.userId, await verifiedPayment(g.gangId, m.userId, '1.00', g.owner)],
      ),
    ).rejects.toThrow(/seq/);

    await expect(
      pool.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, payment_id, reason)
         values ($1, $2, 1, 'overpayment', 5, 15, $3, 'x')`,
        [g.gangId, m.userId, await verifiedPayment(g.gangId, m.userId, '1.00', g.owner)],
      ),
    ).rejects.toThrow(/credit_ledger_member_seq_key/);

    await expect(
      pool.query(
        `insert into public.credit_ledger (gang_id, user_id, seq, type, amount, balance_after, payment_id, reason)
         values ($1, $2, 0, 'overpayment', 5, 15, $3, 'x')`,
        [g.gangId, m.userId, await verifiedPayment(g.gangId, m.userId, '1.00', g.owner)],
      ),
    ).rejects.toThrow(/seq_positive/);

    await expect(
      pool.query(`update public.credit_ledger set seq = 9 where user_id = $1`, [m.userId]),
    ).rejects.toThrow(/FORBIDDEN/);
    await expect(pool.query(`delete from public.credit_ledger where user_id = $1`, [m.userId])).rejects.toThrow(/FORBIDDEN/);
    await expectSeqConsistent(g.gangId, m.userId);
  });
});

describe('WO-B5b-1 N1 — ผู้อ่านเรียงด้วย seq', () => {
  it('🔴 ลำดับตาม seq (ที่ getMyCredit ใช้ order seq desc) ให้ balance_after ถูก: ล่าสุดก่อน', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId);
    await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), '10.00', g.owner);
    await overpay(await verifiedPayment(g.gangId, m.userId, '1.00', g.owner), '20.00', g.owner);

    // ตรวจ SQL ชุดเดียวกับที่ server/actions/credit.ts ใช้ (select ... order by seq desc) — action เองถูกครอบโดย member-credit-actions.test.ts
    const { rows } = await pool.query<{ seq: string; balance_after: string }>(
      `select seq::text, balance_after::text from public.credit_ledger
        where gang_id = $1 and user_id = $2 order by seq desc limit 50`,
      [g.gangId, m.userId],
    );
    expect(rows.map((r) => [r.seq, r.balance_after])).toEqual([
      ['2', '30.00'],
      ['1', '10.00'],
    ]);
  });
});
