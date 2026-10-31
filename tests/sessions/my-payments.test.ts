/**
 * WO-R3 DoD — loader ฝั่งสมาชิก: myBalance / myChargeBreakdown / myPaymentForSession
 *
 * เรียก server action จริงกับ DB local (ห้าม db reset) · mock เฉพาะ auth/headers/cache แบบเดียวกับ close-breakdown.test.ts
 * ⚠️ `supabaseServer` ถูก mock เป็น service client ⇒ RLS ไม่ทำงานในเทสต์ action ⇒ เทสต์นี้พิสูจน์ "filter ที่ action ใส่เอง"
 *    (ซึ่งเข้มกว่า RLS สำหรับแอดมิน) · ส่วนที่ต้องพึ่ง RLS จริงพิสูจน์แยกด้วย `visibleCount()` (บทสุดท้าย)
 *
 *   1. ยอด myBalance = ledger เดิม (summarize ของ domain กับข้อมูลดิบจาก DB) — รวม verified/adjustment/เพื่อนจ่ายแทน
 *   2. สองนัดค้าง ⇒ myPaymentForSession คืนใบของแต่ละนัดถูก (บั๊ก pay/page.tsx)
 *   3. ไม่เห็นข้อมูลคนอื่น/ก๊วนอื่น — แม้ผู้เรียกเป็นแอดมินที่ RLS เปิดให้เห็นทั้งก๊วน
 *   4. breakdown: รวม = amount · ตรงกับ preview ที่แอดมินเห็นตอนปิดรอบ · ไม่ reconcile ⇒ null
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { pool, serviceClient, visibleCount } from '../helpers/db';
import { summarize, type LedgerEntry } from '@/domain/billing/ledger';
import { moneyFromDb } from '@/lib/supabase/money';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';

const h = vi.hoisted(() => ({ userId: '' }));

vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => serviceClient() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => serviceClient() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import {
  myBalance,
  myChargeBreakdown,
  myPaymentForSession,
  createMyPayment,
  createPaymentForCharges,
} from '@/server/actions/payments';
import { previewSessionCharges, closeSessionWithBilling } from '@/server/actions/billing';

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
    [`r3-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function newGang() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);
  return { owner, gangId: gang.id };
}

async function addMember(gangId: string, opts: { role?: string; monthly?: boolean } = {}): Promise<string> {
  const u = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role, is_monthly_member) values ($1, $2, $3, $4)`,
    [gangId, u, opts.role ?? 'member', opts.monthly ?? false],
  );
  return u;
}

type Person = { userId: string; who: 'attended' | 'no_check_in' };
type SessionOpts = {
  title: string;
  startedHoursAgo: number;
  kind: 'cps' | 'flat';
  guests?: number;
  shuttles?: string;
  flatAmount?: string;
};

/** สร้างนัด → ลงชื่อ → เช็คอิน → in_play → (preview) → ปิดรอบจริง ผ่าน action เดิม */
async function closedSession(g: { owner: string; gangId: string }, people: Person[], opts: SessionOpts) {
  const snapshot = {
    snapshot_version: 1,
    pricing_plan:
      opts.kind === 'cps'
        ? {
            id: null,
            name: 'ค่าสนาม+ลูก',
            type: 'court_plus_shuttle',
            params: { court_fee_total: '800.00', shuttle_price: '25.00' },
            monthly_member_pays_shuttle: true,
          }
        : {
            id: null,
            name: 'เหมาจ่าย',
            type: 'flat_rate',
            params: { amount_per_person: opts.flatAmount ?? '150.00' },
          },
    rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
    promptpay_id: '0812345678',
    cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' },
    skill_levels: [],
  };

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, court_count, snapshot, created_by)
     values ($1, $2, now() - make_interval(hours => $3::int), now() - make_interval(hours => $3::int) + interval '2 hours',
             $4, 2, $5::jsonb, $6)
     returning id`,
    [g.gangId, opts.title, opts.startedHoursAgo, people.length + (opts.guests ?? 0) + 4, JSON.stringify(snapshot), g.owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, g.owner]);

  const regOf = new Map<string, string>();
  const regs: { id: string; who: Person['who'] }[] = [];

  for (const p of people) {
    const {
      rows: [r],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [session.id, p.userId]);
    regOf.set(p.userId, r.id);
    regs.push({ id: r.id, who: p.who });
  }
  for (let i = 0; i < (opts.guests ?? 0); i += 1) {
    const {
      rows: [r],
    } = await pool.query<{ id: string }>(
      `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
       values ($1, $2, 'confirmed', 0, $3) returning id`,
      [session.id, `แขก-${i}`, g.owner],
    );
    regs.push({ id: r.id, who: 'attended' });
  }

  for (const r of regs) {
    if (r.who !== 'no_check_in') {
      await pool.query(`select public.check_in_registration($1, $2)`, [r.id, g.owner]);
    }
  }
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, g.owner]);

  if (opts.kind === 'cps') {
    const checked = regs.filter((r) => r.who === 'attended');
    const four = [0, 1, 2, 3].map((i) => checked[i % checked.length].id);
    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at, shuttles_used, created_by)
       values ($1, 1, $2, $3, $4, $5, now() - interval '1 hour', now(), $6, $7)`,
      [session.id, ...four, opts.shuttles ?? '6.5', g.owner],
    );
  }

  h.userId = g.owner;
  const preview = await previewSessionCharges(session.id);
  if (!preview.success) throw new Error(`preview failed: ${preview.error.code}`);
  const closed = await closeSessionWithBilling(session.id);
  if (!closed.success) throw new Error(`close failed: ${closed.error.code} ${closed.error.message}`);

  return { sessionId: session.id, regOf, preview: preview.data };
}

async function chargeIdOf(sessionId: string, userId: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `select c.id from public.session_charges c
       join public.session_registrations r on r.id = c.registration_id
      where c.session_id = $1 and r.user_id = $2 and c.type = 'session'`,
    [sessionId, userId],
  );
  return row.id;
}

/** จ่ายจริงครบวงจร: ส่งสลิป → แอดมินยืนยัน */
async function verifyPayment(paymentId: string, payer: string, owner: string) {
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [paymentId, payer]);
  await pool.query(`select public.transition_payment($1, 'verified', $2)`, [paymentId, owner]);
}

/** ledger เดิมจากข้อมูลดิบใน DB (ไม่ผ่านโค้ดของ R3) */
async function rawLedger(gangId: string, userId: string) {
  const { rows } = await pool.query<{
    id: string;
    session_id: string;
    amount: string;
    allocated: string[];
    adjustments: string[];
  }>(
    `select c.id, c.session_id, c.amount::text,
            coalesce((select array_agg(a.amount::text) from public.payment_allocations a
                        join public.payments p on p.id = a.payment_id
                       where a.session_charge_id = c.id and p.status = 'verified'), '{}') as allocated,
            coalesce((select array_agg(j.amount::text) from public.payment_adjustments j
                       where j.session_charge_id = c.id), '{}') as adjustments
       from public.session_charges c
       join public.session_registrations r on r.id = c.registration_id
      where r.user_id = $1 and c.gang_id = $2 and c.type = 'session'`,
    [userId, gangId],
  );
  const entries: LedgerEntry[] = rows.map((r) => ({
    chargeId: r.id,
    amount: r.amount,
    allocated: r.allocated,
    adjustments: r.adjustments,
  }));
  return { rows, entries, summary: summarize(entries) };
}

const sat = (xs: string[]) => sumSatang(xs.map(toSatang));

// ---------------------------------------------------------------------------

describe('WO-R3 — myBalance ตรงกับ ledger เดิม', () => {
  it('🔴 ยอด/จ่ายแล้ว/ค้าง ตรง summarize() ของข้อมูลดิบ — verified + credit + เพื่อนจ่ายแทน + นัดที่ยังไม่จ่าย', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const friend = await addMember(g.gangId);
    const others = [await addMember(g.gangId), await addMember(g.gangId)];
    const people = (us: string[]): Person[] => us.map((userId) => ({ userId, who: 'attended' }));

    const s1 = await closedSession(g, people([a, friend, ...others]), {
      title: 'นัดเก่า', startedHoursAgo: 72, kind: 'flat', flatAmount: '150.00',
    });
    const s2 = await closedSession(g, people([a, friend, ...others]), {
      title: 'นัดกลาง', startedHoursAgo: 48, kind: 'flat', flatAmount: '180.00',
    });
    const s3 = await closedSession(g, people([a, friend]), {
      title: 'นัดล่าสุด', startedHoursAgo: 3, kind: 'flat', flatAmount: '200.00',
    });

    // S1: A จ่ายเองครบ + verified แล้วแอดมินให้เครดิตคืน 50
    h.userId = a;
    const p1 = await createMyPayment(s1.sessionId);
    expect(p1.success).toBe(true);
    if (!p1.success) return;
    await verifyPayment(p1.data.paymentId, a, g.owner);
    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      await chargeIdOf(s1.sessionId, a), '-50.00', 'ส่วนลด', g.owner,
    ]);

    // S2: เพื่อน (F) จ่ายแทน A — A ไม่ใช่ผู้จ่ายของใบนี้
    h.userId = friend;
    const p2 = await createPaymentForCharges(g.gangId, [await chargeIdOf(s2.sessionId, a)]);
    expect(p2.success).toBe(true);
    if (!p2.success) return;
    await verifyPayment(p2.data.paymentId, friend, g.owner);

    // S3: A ขอ QR แล้วแต่ยังไม่ verified (รอสลิป) ⇒ ยังค้าง
    h.userId = a;
    const p3 = await createMyPayment(s3.sessionId);
    expect(p3.success).toBe(true);

    const expected = await rawLedger(g.gangId, a);
    const res = await myBalance(g.gangId);
    expect(res.success).toBe(true);
    if (!res.success) return;

    // รวมทั้งก๊วน
    expect(res.data.totals).toEqual({
      charged: expected.summary.charged,
      paid: expected.summary.allocated,
      adjusted: expected.summary.adjusted,
      outstanding: expected.summary.outstanding,
      credit: expected.summary.credit,
    });

    // ต่อนัด
    expect(res.data.items).toHaveLength(3);
    for (const item of res.data.items) {
      const line = expected.summary.lines.find((l) => expected.rows.find((r) => r.id === l.chargeId)?.session_id === item.sessionId)!;
      expect(item.kind).toBe('session');
      expect(item.amount, item.sessionTitle ?? '').toBe(line.charge);
      expect(item.paid).toBe(line.allocated);
      expect(item.adjusted).toBe(line.adjusted);
      expect(toSatang(item.outstanding)).toBe(Math.max(0, toSatang(line.outstanding)));
      expect(toSatang(item.credit)).toBe(Math.min(0, toSatang(line.outstanding)));
    }

    // เรียงใหม่→เก่า
    expect(res.data.items.map((i) => i.sessionTitle)).toEqual(['นัดล่าสุด', 'นัดกลาง', 'นัดเก่า']);

    const byTitle = Object.fromEntries(res.data.items.map((i) => [i.sessionTitle, i]));
    // S1 จ่ายครบแล้วได้เครดิต 50 ⇒ ไม่ค้าง และก๊วนต้องคืน 50
    expect(byTitle['นัดเก่า'].outstanding).toBe('0.00');
    expect(byTitle['นัดเก่า'].credit).toBe('-50.00');
    // S2 เพื่อนจ่ายแทน ⇒ นับเป็นจ่ายแล้ว (ต้องไม่เห็นเป็นค้าง) แต่ใบจ่ายล่าสุด "ของฉัน" ไม่มี (ฉันไม่ใช่ผู้จ่าย)
    expect(byTitle['นัดกลาง'].paid).toBe('180.00');
    expect(byTitle['นัดกลาง'].outstanding).toBe('0.00');
    expect(byTitle['นัดกลาง'].latestPayment).toBeNull();
    // S3 ขอ QR แล้วแต่ยังไม่ verified ⇒ ยังค้างเต็ม · เห็นสถานะใบล่าสุดของนัดนั้น
    expect(byTitle['นัดล่าสุด'].outstanding).toBe('200.00');
    expect(byTitle['นัดล่าสุด'].latestPayment).toMatchObject({ status: 'pending', amount: '200.00' });
    if (p3.success) expect(byTitle['นัดล่าสุด'].latestPayment?.id).toBe(p3.data.paymentId);
  });

  it('คนที่ไม่มี charge เลย → รายการว่าง ยอดเป็น 0.00 (ไม่ error)', async () => {
    const g = await newGang();
    const nobody = await addMember(g.gangId);
    h.userId = nobody;
    const res = await myBalance(g.gangId);
    expect(res).toMatchObject({
      success: true,
      data: { items: [], totals: { charged: '0.00', paid: '0.00', adjusted: '0.00', outstanding: '0.00', credit: '0.00' } },
    });
  });

  it('ค่าสมาชิกรายเดือน (monthly_fee) ของฉันรวมอยู่ในประวัติ — แยกแถว ไม่ปนกับนัด', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId, { monthly: true });
    const {
      rows: [gm],
    } = await pool.query<{ id: string }>(`select id from public.gang_members where gang_id = $1 and user_id = $2`, [g.gangId, m]);
    await pool.query(
      `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount, created_by)
       values ($1, 'monthly_fee', $2, '2026-10-01', 300.00, $3)`,
      [g.gangId, gm.id, g.owner],
    );

    h.userId = m;
    const res = await myBalance(g.gangId);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.items).toHaveLength(1);
      expect(res.data.items[0]).toMatchObject({
        kind: 'monthly_fee', sessionId: null, date: '2026-10-01', amount: '300.00', outstanding: '300.00',
      });
      expect(res.data.totals.outstanding).toBe('300.00');
    }
  });
});

describe('WO-R3 — myPaymentForSession แก้บั๊ก "payment ล่าสุดของก๊วน"', () => {
  it('🔴 สองนัดค้าง ⇒ แต่ละนัดได้ใบของตัวเอง (ใบของนัดใหม่ต้องไม่ไปโผล่ในนัดเก่า)', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const peers = [await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)];
    const people: Person[] = [a, ...peers].map((userId) => ({ userId, who: 'attended' }));

    const old = await closedSession(g, people, { title: 'นัดเก่า', startedHoursAgo: 72, kind: 'flat', flatAmount: '120.00' });
    const recent = await closedSession(g, people, { title: 'นัดใหม่', startedHoursAgo: 3, kind: 'flat', flatAmount: '260.00' });

    h.userId = a;
    const pOld = await createMyPayment(old.sessionId);
    const pNew = await createMyPayment(recent.sessionId); // สร้างทีหลัง ⇒ เป็น "payment ล่าสุดของก๊วน" ที่โค้ดเดิมจะหยิบผิด
    expect(pOld.success && pNew.success).toBe(true);
    if (!pOld.success || !pNew.success) return;
    expect(pOld.data.paymentId).not.toBe(pNew.data.paymentId);

    const forOld = await myPaymentForSession(old.sessionId);
    const forNew = await myPaymentForSession(recent.sessionId);

    expect(forOld).toMatchObject({
      success: true,
      data: { id: pOld.data.paymentId, amount: '120.00', amountForSession: '120.00', status: 'pending', hasSlip: false },
    });
    expect(forNew).toMatchObject({
      success: true,
      data: { id: pNew.data.paymentId, amount: '260.00', amountForSession: '260.00', status: 'pending' },
    });

    // กับคนอื่น: B ขอ QR นัดใหม่ทีหลัง A ⇒ A ยังเห็นใบของตัวเอง ไม่ใช่ของ B
    h.userId = peers[0];
    const pB = await createMyPayment(recent.sessionId);
    h.userId = a;
    const again = await myPaymentForSession(recent.sessionId);
    expect(again.success && again.data?.id).toBe(pNew.data.paymentId);
    if (pB.success) expect(again.success && again.data?.id).not.toBe(pB.data.paymentId);
  });

  it('ใบเดียวครอบหลายนัด ⇒ amount = ยอดทั้งใบ · amountForSession = ส่วนของนัดนี้ · สถานะตามจริงหลัง verified', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const peers = [await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)];
    const people: Person[] = [a, ...peers].map((userId) => ({ userId, who: 'attended' }));
    const s1 = await closedSession(g, people, { title: 'หนึ่ง', startedHoursAgo: 72, kind: 'flat', flatAmount: '100.00' });
    const s2 = await closedSession(g, people, { title: 'สอง', startedHoursAgo: 5, kind: 'flat', flatAmount: '70.00' });

    h.userId = a;
    const both = await createPaymentForCharges(g.gangId, [await chargeIdOf(s1.sessionId, a), await chargeIdOf(s2.sessionId, a)]);
    expect(both.success).toBe(true);
    if (!both.success) return;
    // RPC เดิม serialize numeric เป็น JSON number — normalize ที่ขอบแล้วเทียบเงินเป๊ะ ไม่ผ่อน assertion
    expect(moneyFromDb(both.data.amount)).toBe('170.00');

    const r1 = await myPaymentForSession(s1.sessionId);
    const r2 = await myPaymentForSession(s2.sessionId);
    expect(r1).toMatchObject({ success: true, data: { id: both.data.paymentId, amount: '170.00', amountForSession: '100.00' } });
    expect(r2).toMatchObject({ success: true, data: { id: both.data.paymentId, amount: '170.00', amountForSession: '70.00' } });

    await verifyPayment(both.data.paymentId, a, g.owner);
    const done = await myPaymentForSession(s1.sessionId);
    expect(done.success && done.data).toMatchObject({ status: 'verified', verifiedAt: expect.any(String) });
  });

  it('ยังไม่มีใบ / ไม่มี charge ในนัด ⇒ data: null (ให้ UI เสนอขอ QR)', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const noCharge = await addMember(g.gangId);
    const people: Person[] = [a, await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'ไม่มีใบ', startedHoursAgo: 4, kind: 'flat' });

    h.userId = a;
    expect(await myPaymentForSession(s.sessionId)).toEqual({ success: true, data: null });
    h.userId = noCharge;
    expect(await myPaymentForSession(s.sessionId)).toEqual({ success: true, data: null });
  });
});

describe('WO-R3 — ไม่เห็นข้อมูลคนอื่น/ก๊วนอื่น', () => {
  it('🔴 แอดมิน (RLS เห็นทั้งก๊วน) เรียก action แล้วได้เฉพาะของตัวเอง — ทั้ง 3 ตัว', async () => {
    const g = await newGang();
    const admin = await addMember(g.gangId, { role: 'admin' });
    const m1 = await addMember(g.gangId);
    const m2 = await addMember(g.gangId);
    const m3 = await addMember(g.gangId);
    const people: Person[] = [admin, m1, m2, m3].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'แอดมินร่วมเล่น', startedHoursAgo: 4, kind: 'cps' });

    // คนอื่นขอ QR (มีใบของคนอื่นในก๊วน)
    for (const m of [m1, m2]) {
      h.userId = m;
      await createMyPayment(s.sessionId);
    }

    h.userId = admin;
    const bal = await myBalance(g.gangId);
    expect(bal.success).toBe(true);
    if (bal.success) {
      expect(bal.data.items).toHaveLength(1);
      expect(bal.data.items[0].chargeIds).toEqual([await chargeIdOf(s.sessionId, admin)]);
      const mine = await rawLedger(g.gangId, admin);
      expect(bal.data.totals.charged).toBe(mine.summary.charged);
    }

    const pay = await myPaymentForSession(s.sessionId);
    expect(pay).toEqual({ success: true, data: null }); // แอดมินยังไม่ขอใบ — ต้องไม่เห็นใบของ m1/m2

    const br = await myChargeBreakdown(s.sessionId);
    expect(br.success).toBe(true);
    if (br.success && br.data) {
      expect(br.data.rows).toHaveLength(1);
      expect(br.data.rows[0].chargeId).toBe(await chargeIdOf(s.sessionId, admin));
      // ไม่มีรหัส charge ของคนอื่นในผลลัพธ์เลย
      const json = JSON.stringify(br.data);
      for (const other of [m1, m2, m3]) expect(json).not.toContain(await chargeIdOf(s.sessionId, other));
    }
  });

  it('🔴 คนนอกก๊วน → FORBIDDEN ทั้ง 3 ตัว · นัดที่ไม่มีอยู่ → NOT_FOUND · ก๊วนอื่นไม่รั่ว', async () => {
    const g = await newGang();
    const other = await newGang(); // ก๊วนอื่นที่ผู้เรียกเป็นสมาชิก
    const member = await addMember(g.gangId);
    const stranger = await addMember(other.gangId);
    const people: Person[] = [member, await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'ก๊วนนี้', startedHoursAgo: 4, kind: 'flat' });

    h.userId = stranger;
    for (const res of [await myBalance(g.gangId), await myPaymentForSession(s.sessionId), await myChargeBreakdown(s.sessionId)]) {
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('FORBIDDEN');
    }

    // สมาชิกก๊วนอื่นเรียก myBalance ของก๊วนตัวเอง ⇒ ไม่เห็น charge ของก๊วน g
    const ownBalance = await myBalance(other.gangId);
    expect(ownBalance).toMatchObject({ success: true, data: { items: [] } });

    h.userId = member;
    const missing = await myPaymentForSession(crypto.randomUUID());
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.code).toBe('NOT_FOUND');
    const missingBreakdown = await myChargeBreakdown(crypto.randomUUID());
    expect(missingBreakdown.success).toBe(false);
    if (!missingBreakdown.success) expect(missingBreakdown.error.code).toBe('NOT_FOUND');
  });

  it('action ไม่รับ userId จาก client (signature มีแค่ gangId / sessionId)', () => {
    expect(myBalance.length).toBe(1);
    expect(myChargeBreakdown.length).toBe(1);
    expect(myPaymentForSession.length).toBe(1);
  });
});

describe('WO-R3 — myChargeBreakdown', () => {
  it('🔴 court_plus_shuttle: รวม 4 ช่อง = amount · ตรงกับ preview ที่แอดมินเห็นตอนปิดรอบทุกคน (ปัดเศษ/ค่าปรับ/แขก/รายเดือน)', async () => {
    const g = await newGang();
    const att = [await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)];
    const monthly = await addMember(g.gangId, { monthly: true });
    const skip = await addMember(g.gangId);
    const people: Person[] = [
      ...att.map((userId) => ({ userId, who: 'attended' as const })),
      { userId: monthly, who: 'attended' },
      { userId: skip, who: 'no_check_in' },
    ];
    const s = await closedSession(g, people, { title: 'แยกยอด', startedHoursAgo: 4, kind: 'cps', guests: 1, shuttles: '6.5' });

    let sawPenalty = false;
    let sawRounding = false;
    for (const p of people) {
      h.userId = p.userId;
      const res = await myChargeBreakdown(s.sessionId);
      expect(res.success).toBe(true);
      if (!res.success || !res.data) throw new Error('breakdown ควรมีค่า');

      const row = res.data.rows[0];
      const previewRow = s.preview.rows.find((r) => r.registrationId === s.regOf.get(p.userId))!;

      // รวม 4 ช่อง = amount และ amount = ยอดที่ DB เก็บจริง
      expect(fromSatang(sat([row.court, row.shuttle, row.penalty, row.rounding]))).toBe(row.amount);
      const { rows: db } = await pool.query<{ amount: string }>(`select amount::text from public.session_charges where id = $1`, [row.chargeId]);
      expect(row.amount).toBe(db[0].amount);

      // ตรงกับ preview (ตัวเลขที่แอดมินเห็นก่อนกดปิดรอบ) ทุกช่อง
      expect({ court: row.court, shuttle: row.shuttle, penalty: row.penalty, rounding: row.rounding }).toEqual(previewRow.breakdown);
      expect(row.amount).toBe(previewRow.amount);
      expect(row.reason).toBe(previewRow.reason);

      // total ของผู้เรียก = แถวของตัวเอง
      expect(res.data.total.amount).toBe(row.amount);
      expect(res.data.pricingType).toBe('court_plus_shuttle');

      if (toSatang(row.penalty) > 0) sawPenalty = true;
      if (toSatang(row.rounding) > 0) sawRounding = true;
      if (p.userId === monthly) expect(row.court).toBe('0.00'); // รายเดือนไม่จ่ายค่าคอร์ท
    }
    expect(sawPenalty, 'fixture ต้องมีค่าปรับจริง (ไม่ได้เช็คอิน)').toBe(true);
    expect(sawRounding, 'fixture ต้องมีเศษปัดจริง').toBe(true);
  });

  it('flat_rate: ราคาต่อหัวทั้งก้อนอยู่ช่อง court · ที่เหลือ 0.00', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const people: Person[] = [a, await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'เหมา', startedHoursAgo: 4, kind: 'flat', flatAmount: '135.00' });

    h.userId = a;
    const res = await myChargeBreakdown(s.sessionId);
    expect(res).toMatchObject({
      success: true,
      data: {
        pricingType: 'flat_rate',
        rows: [{ court: '135.00', shuttle: '0.00', penalty: '0.00', rounding: '0.00', amount: '135.00', reason: 'attended' }],
        total: { amount: '135.00' },
      },
    });
  });

  it('🔴 ไม่ reconcile (ยอดใน DB ไม่ตรงที่เอนจินคิดไว้) ⇒ data: null ไม่ส่งตัวเลขใดๆ', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const peers = [await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)];
    const people: Person[] = [a, ...peers].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'แก้ยอด', startedHoursAgo: 4, kind: 'cps', shuttles: '6.5' });

    h.userId = a;
    const ok = await myChargeBreakdown(s.sessionId);
    expect(ok.success && ok.data).not.toBeNull();

    // ใครสักคนในนัดมียอดผิดไป 1 สตางค์ (เช่นแก้ข้อมูลตรง) — ต้องไม่โชว์ตัวเลขของใครเลย
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await pool.query(
      `update public.session_charges set amount = amount + 0.01
        where id = $1`,
      [await chargeIdOf(s.sessionId, peers[0])],
    );

    const bad = await myChargeBreakdown(s.sessionId);
    expect(bad).toEqual({ success: true, data: null });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\d+\.\d{2}\b.*\d+\.\d{2}\b/); // log ไม่ใส่ตัวเลขเงินรายคนเป็นชุด
    warn.mockRestore();
  });

  it('ไม่มี charge ของฉันในนัด (ไม่ได้ถูกเก็บเงิน/ยังไม่ปิดรอบ) ⇒ data: null', async () => {
    const g = await newGang();
    const outsider = await addMember(g.gangId);
    const people: Person[] = [await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId), await addMember(g.gangId)].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'ไม่ได้เล่น', startedHoursAgo: 4, kind: 'flat' });

    h.userId = outsider;
    expect(await myChargeBreakdown(s.sessionId)).toEqual({ success: true, data: null });
  });
});

describe('WO-R3 — เหตุผลที่ allocations ต้องอ่านด้วย service-role (พิสูจน์ด้วย RLS จริง)', () => {
  it('เพื่อนจ่ายแทน: เจ้าของหนี้ "มองไม่เห็น" allocation นั้นภายใต้ RLS แต่ ledger ต้องนับ ⇒ action อ่านด้วย service-role ที่ filter ด้วย charge ของฉัน', async () => {
    const g = await newGang();
    const a = await addMember(g.gangId);
    const friend = await addMember(g.gangId);
    const people: Person[] = [a, friend, await addMember(g.gangId), await addMember(g.gangId)].map((userId) => ({ userId, who: 'attended' }));
    const s = await closedSession(g, people, { title: 'จ่ายแทน', startedHoursAgo: 4, kind: 'flat', flatAmount: '140.00' });

    const chargeA = await chargeIdOf(s.sessionId, a);
    h.userId = friend;
    const paid = await createPaymentForCharges(g.gangId, [chargeA]);
    expect(paid.success).toBe(true);
    if (!paid.success) return;
    await verifyPayment(paid.data.paymentId, friend, g.owner);

    const sql = `select 1 from public.payment_allocations where session_charge_id = $1`;
    // ผู้จ่าย (เพื่อน) เห็น · เจ้าของหนี้ (A) ไม่เห็น ภายใต้ RLS
    expect(await visibleCount(friend, sql, [chargeA])).toBe(1);
    expect(await visibleCount(a, sql, [chargeA])).toBe(0);

    // แต่ myBalance ของ A ต้องรู้ว่าจ่ายแล้ว
    h.userId = a;
    const res = await myBalance(g.gangId);
    expect(res.success && res.data.items[0]).toMatchObject({ paid: '140.00', outstanding: '0.00', latestPayment: null });
  });
});
