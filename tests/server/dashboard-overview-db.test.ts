/**
 * WO-6.5c — REAL DB role-matrix test for `dashboardOverview()` (H10 aggregate loader).
 *
 * Mock boundary: same convention as tests/sessions/member-credit-actions.test.ts —
 * `@/lib/supabase/auth` returns a swappable fake user id (`h.userId`), `@/lib/supabase/server`
 * returns the service-role client (RLS bypass is fine here: this test is NOT proving RLS,
 * it's proving `dashboardOverview()`'s OWN `can()` gating + numeric parity with
 * `adminLedger()`/`adminPaymentList()`/`financeReport()` for the same gang/period — RLS is a
 * separate concern already covered by tests/rls/).
 *
 * DoD per planner: admin/treasurer/scheduler/member/outsider role matrix + numbers must match
 * financeReport()/adminLedger() of the same period.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool, serviceClient, userClient, reloadPostgrestSchema } from '../helpers/db';

/** `asUserId` ตั้งแล้ว ⇒ supabaseServer() คืน client ของ user จริงนั้น (RLS มีผลจริง ผ่าน PostgREST)
 *  แทน serviceClient() — ใช้เฉพาะเทสต์ที่ต้อง "ไม่ mock DB เลย" (ดู describe RLS จริงด้านล่าง)
 *  `poisonTable` ตั้งแล้ว ⇒ ทุก `.from(poisonTable)` บน client ที่คืนออกไปจะได้ error เสมอ (ทุกจุดอื่นยังเป็น
 *  real DB จริง) — ใช้พิสูจน์ [planner F2] ว่า loadNextSession()/loadMonthSessions() ฯลฯ throw จริง
 *  เมื่อ query fail ไม่ใช่คืน null/0 แบบเงียบๆ */
const h = vi.hoisted(() => ({ userId: '', asUserId: null as string | null, poisonTable: null as string | null }));

/** ห่อ client จริงไว้ — table ที่ตรงกับ poisonTable คืน error เสมอทุก terminal call (.maybeSingle/.single/await ตรงๆ) */
function poisonedClient(real: ReturnType<typeof serviceClient>, poisonTable: string) {
  const injected = { data: null, error: { message: 'injected test failure', code: 'XX000', details: null, hint: null } };
  return {
    from(table: string) {
      if (table !== poisonTable) return real.from(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ['select', 'eq', 'is', 'neq', 'gte', 'gt', 'lt', 'lte', 'in', 'order', 'limit']) chain[m] = self;
      chain.maybeSingle = () => Promise.resolve(injected);
      chain.single = () => Promise.resolve(injected);
      chain.then = (resolve: (v: typeof injected) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(injected).then(resolve, reject);
      return chain;
    },
  } as unknown as ReturnType<typeof serviceClient>;
}

vi.mock('@/lib/supabase/auth', () => ({ requireUser: async () => ({ id: h.userId }) }));
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => {
    const base = h.asUserId ? userClient(h.asUserId) : serviceClient();
    return h.poisonTable ? poisonedClient(base, h.poisonTable) : base;
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { dashboardOverview, type DashboardOverview } from '@/server/actions/dashboard';
import { adminLedger } from '@/server/actions/payment-admin';
import { adminPaymentList } from '@/server/actions/payment-list';
import { financeReport } from '@/server/actions/finance-report';
import { thaiToday, thaiMonthOf, monthDateRange } from '@/server/sessions/dashboard-dates';
import { financeRange } from '@/server/payments/report-range';

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
    [`dash-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** นัดวันนี้ (หลังตอนนี้ไม่กี่ชม.) — การันตีว่าทั้ง "วันนี้เป็นต้นไป" (loadNextSession) และ "เดือนนี้" (avgAttendees) ผ่าน */
function thisMonthBangkokRange(): { startIso: string; endIso: string } {
  const start = new Date(Date.now() + 2 * 3600_000);
  const end = new Date(Date.now() + 4 * 3600_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function setup() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-${crypto.randomUUID()}`]);
  const gangId = gang.id;

  const add = async (role = 'member') => {
    const u = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`, [gangId, u, role]);
    return u;
  };
  const admin = await add('admin');
  const plain = await add();
  const treasurer = await add();
  const scheduler = await add();
  const outsider = await newUser();

  await pool.query(`select public.assign_gang_role($1,$2,'treasurer',$3)`, [gangId, treasurer, owner]);
  await pool.query(`select public.assign_gang_role($1,$2,'scheduler',$3)`, [gangId, scheduler, owner]);

  // นัดเดือนนี้ (เวลาไทย): 2 ที่นั่ง (1 สมาชิก + 1 guest) + 1 waitlist — สำหรับ nextSession/#11 + avgAttendees/#3
  const { startIso, endIso } = thisMonthBangkokRange();
  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
     values ($1, 'นัดทดสอบ dashboard', $2, $3, 4, 'open') returning id`,
    [gangId, startIso, endIso],
  );
  await pool.query(
    `insert into public.session_registrations (session_id, user_id, status) values ($1, $2, 'confirmed')`,
    [session.id, plain],
  );
  await pool.query(
    `insert into public.session_registrations (session_id, guest_name, status) values ($1, 'เกสต์ทดสอบ', 'confirmed')`,
    [session.id],
  );
  await pool.query(
    `insert into public.session_registrations (session_id, user_id, status) values ($1, $2, 'waitlist')`,
    [session.id, treasurer],
  );

  // นัดที่ยัง "open" แต่ ends_at ผ่านไปแล้ว — ปิดรอบค้าง (#7) สำหรับ billing.close เท่านั้น
  // (เดือนที่แล้วแน่ๆ ไม่งั้นจะไปปน sessionsThisMonth/avgAttendees ของเดือนนี้)
  await pool.query(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
     values ($1, 'นัดค้างปิด', date_trunc('month', now()) - interval '3 days', date_trunc('month', now()) - interval '2 days', 4, 'open')`,
    [gangId],
  );

  // เปิด features.discovery เพื่อทดสอบ gang.join_request.manage (#9) — ปิดโดย default (20260810000002_tenancy.sql:109)
  await pool.query(`update public.gangs set features = jsonb_set(features, '{discovery}', 'true') where id = $1`, [gangId]);

  // คำขอเข้าก๊วนค้าง — gang.join_request.manage เท่านั้น (#9, never-delegable)
  const requester = await newUser();
  await pool.query(`insert into public.join_requests (gang_id, user_id, status) values ($1, $2, 'pending')`, [gangId, requester]);

  // สลิปรอตรวจ — payment.verify (#5)
  const {
    rows: [payment],
  } = await pool.query<{ id: string }>(
    `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, 150, $3) returning id`,
    [gangId, plain, owner],
  );
  await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [payment.id, plain]);

  // เครดิตคงค้าง — gang.finance.view (#6)
  await pool.query(
    `insert into public.credit_balances (gang_id, user_id, balance) values ($1, $2, 88.50)
     on conflict (gang_id, user_id) do update set balance = excluded.balance`,
    [gangId, plain],
  );

  return { gangId, owner, admin, plain, treasurer, scheduler, outsider };
}

type World = Awaited<ReturnType<typeof setup>>;
let wp: Promise<World> | undefined;
const world = () => (wp ??= setup());

function unwrap<T>(res: { success: true; data: T } | { success: false; error: unknown }): T {
  if (!res.success) throw res.error;
  return res.data;
}

describe('dashboardOverview() — real DB role matrix (no mock DB queries)', () => {
  it('🔴 outsider (ไม่เคยเป็นสมาชิกก๊วนนี้เลย): NOT_FOUND ไม่ใช่ FORBIDDEN', async () => {
    const w = await world();
    h.userId = w.outsider;
    const res = await dashboardOverview(w.gangId);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('plain member: เห็น nextSession/memberCount/avgAttendees แต่ widget การเงิน/แอดมินทั้งหมด = null', async () => {
    const w = await world();
    h.userId = w.plain;
    const data = unwrap(await dashboardOverview(w.gangId));

    expect(data.nextSession).not.toBeNull();
    expect(data.nextSession?.seatedCount).toBe(2);
    expect(data.nextSession?.waitlistCount).toBe(1);
    expect(data.nextSession?.guestCount).toBe(1);
    expect(data.memberCount).toBeGreaterThanOrEqual(5); // admin+plain+treasurer+scheduler (+owner ไม่ได้มาจาก add() แต่ยังนับ)
    expect(data.avgAttendeesThisMonth).toEqual({ totalSeated: 2, sessionCount: 1 });
    expect(data.sessionsThisMonth).toBe(1);

    expect(data.unclosedSessionsCount).toBeNull();
    expect(data.joinRequestsPending).toBeNull();
    expect(data.outstanding).toBeNull();
    expect(data.pendingSlips).toBeNull();
    expect(data.netCashThisMonth).toBeNull();
    expect(data.creditOutstanding).toBeNull();
    expect(data.monthlyCashFlow).toBeNull();
  });

  it('scheduler (delegated ชุดสิทธิ์จัดนัด — ไม่มีเงิน/ไม่มี billing.close/ไม่มี join_request.manage): เหมือน plain member เป๊ะในฝั่งที่ null', async () => {
    const w = await world();
    h.userId = w.scheduler;
    const data = unwrap(await dashboardOverview(w.gangId));

    expect(data.unclosedSessionsCount).toBeNull();
    expect(data.joinRequestsPending).toBeNull();
    expect(data.outstanding).toBeNull();
    expect(data.pendingSlips).toBeNull();
    expect(data.netCashThisMonth).toBeNull();
    expect(data.creditOutstanding).toBeNull();
    expect(data.monthlyCashFlow).toBeNull();
    // แต่ widget ที่ไม่ต้องมีสิทธิ์พิเศษยังเห็นเหมือนสมาชิกทั่วไป
    expect(data.nextSession?.seatedCount).toBe(2);
  });

  it('🔴 treasurer (delegated gang.finance.view + payment.verify): เห็น widget การเงินครบ แต่ unclosedSessionsCount/joinRequestsPending ยังเป็น null (ไม่มี billing.close/gang.join_request.manage)', async () => {
    const w = await world();
    h.userId = w.treasurer;
    const data = unwrap(await dashboardOverview(w.gangId));

    expect(data.unclosedSessionsCount).toBeNull();
    expect(data.joinRequestsPending).toBeNull();

    expect(data.outstanding).not.toBeNull();
    expect(data.pendingSlips).not.toBeNull();
    expect(data.pendingSlips?.count).toBeGreaterThanOrEqual(1);
    expect(data.netCashThisMonth).not.toBeNull();
    expect(data.creditOutstanding).not.toBeNull();
    expect(data.monthlyCashFlow).not.toBeNull();
    expect(data.monthlyCashFlow).toHaveLength(6);
  });

  it('🔴 admin: เห็นทุก widget ไม่มี null เลย + ตัวเลขตรงกับ adminLedger()/adminPaymentList()/financeReport() ของช่วงเดียวกันเป๊ะ', async () => {
    const w = await world();
    h.userId = w.admin;
    const data = unwrap(await dashboardOverview(w.gangId));

    expect(data.unclosedSessionsCount).not.toBeNull();
    expect(data.unclosedSessionsCount).toBeGreaterThanOrEqual(1);
    expect(data.joinRequestsPending).not.toBeNull();
    expect(data.joinRequestsPending).toBeGreaterThanOrEqual(1);

    const ledger = unwrap(await adminLedger(w.gangId, { pageSize: 1, filter: { status: 'outstanding' } }));
    expect(data.outstanding).toEqual({ amount: ledger.summary.outstanding, debtors: ledger.summary.debtors });

    const payList = unwrap(await adminPaymentList(w.gangId, { pageSize: 1, filter: { status: 'submitted' } }));
    expect(data.pendingSlips?.count).toBe(payList.counts.submitted);

    const now = new Date();
    const wall = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).format(now);
    const [y, m] = wall.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const pad = (n: number) => String(n).padStart(2, '0');
    const report = unwrap(await financeReport(w.gangId, { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` }));
    expect(data.netCashThisMonth).toBe(report.report.netCash);

    expect(data.monthlyCashFlow).toHaveLength(6);
    const thisMonthBar = data.monthlyCashFlow?.at(-1);
    expect(thisMonthBar?.month).toBe(`${y}-${pad(m)}`);
    // identity: เงินเข้า - เงินออก = netCash ของเดือนนั้น (ตัวตรวจ ไม่ใช่สูตรใหม่ — มาจาก financeReport().netCash โดยตรง)
    const { toSatang } = await import('@/domain/billing/money');
    expect(toSatang(thisMonthBar!.inflow) - toSatang(thisMonthBar!.outflow)).toBe(toSatang(report.report.netCash));
  });
});

describe('dashboardOverview() — creditOutstanding paginates past PostgREST max_rows (planner review, 31 ต.ค. 2026)', () => {
  it('🔴 เครดิตคงค้าง > 1000 แถว (1 แถว/คน) ต้องรวมได้ครบทุกแถว ไม่ใช่แค่ max_rows ของ PostgREST (1000)', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-paginate-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    // [planner แก้ 31 ต.ค. 2026] 520 แถวไม่พอ — PostgREST max_rows คือ 1000 ไม่ใช่ PAGE=500 ของโค้ดเรา
    // ⇒ โค้ดเดิมที่ไม่แบ่งหน้าเลย (single select ไม่มี .limit()) ก็ได้ 520.00 ถูกเหมือนกันเพราะ
    // PostgREST คืนครบใน 1 request อยู่แล้วตอน<1000 แถว เทสต์เดิมจับ regression ไม่ได้จริง
    // ⇒ ต้อง > 1000 แถว ถึงจะพิสูจน์ได้ว่า "ไม่ได้พึ่ง max_rows ของ PostgREST เพียวๆ" — 1.00 บาท/คน
    // ⇒ ยอดรวมต้องเป็น 1005.00 เป๊ะ ไม่ใช่ 1000.00 (ถ้าพังจะโผล่เป็น 1000.00 ไม่ใช่ error)
    const N = 1005;
    const {
      rows: memberRows,
    } = await pool.query<{ id: string }>(
      `insert into auth.users (id, email)
       select gen_random_uuid(), 'dash-paginate-' || gen_random_uuid() || '@example.com'
       from generate_series(1, $1)
       returning id`,
      [N],
    );
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role)
       select $1, unnest($2::uuid[]), 'member'`,
      [gangId, memberRows.map((r) => r.id)],
    );
    await pool.query(
      `insert into public.credit_balances (gang_id, user_id, balance)
       select $1, unnest($2::uuid[]), 1.00`,
      [gangId, memberRows.map((r) => r.id)],
    );

    h.userId = admin;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.creditOutstanding).toBe(`${N}.00`);
  }, 30_000);
});

describe('dashboardOverview() — [planner G1] canSeeGangMoney() ต้องครบทั้ง 3: finance.view && payment.verify && credit.read.other', () => {
  async function newGangWithCustomRole(permissions: string[], roleKey: string) {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-g1-${roleKey}-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const customUser = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, customUser]);
    await pool.query(
      `insert into public.gang_roles (gang_id, key, name, permissions, is_system)
       values ($1, $2, $2, $3::text[], false)`,
      [gangId, roleKey, permissions],
    );
    await pool.query(`select public.assign_gang_role($1, $2, $3, $4)`, [gangId, customUser, roleKey, owner]);
    return { gangId, customUser, owner };
  }

  function expectAllMoneyWidgetsNull(data: DashboardOverview) {
    expect(data.outstanding).toBeNull();
    expect(data.netCashThisMonth).toBeNull();
    expect(data.monthlyCashFlow).toBeNull();
    expect(data.creditOutstanding).toBeNull();
  }

  it('🔴 finance-only (แค่ gang.finance.view): ไม่ error + outstanding/netCash/monthlyCashFlow/creditOutstanding ต้องเป็น null ทั้งชุด (ไม่ใช่แค่ creditOutstanding)', async () => {
    const { gangId, customUser } = await newGangWithCustomRole(['gang.finance.view'], 'finance_only');
    h.userId = customUser;
    const data = unwrap(await dashboardOverview(gangId));
    expectAllMoneyWidgetsNull(data);
    // widget อื่นที่ไม่เกี่ยวกับ canSeeGangMoney() ต้องยังทำงานปกติ ไม่ throw/ไม่หายไปด้วย
    expect(data.sessionsThisMonth).toBeTypeOf('number');
  });

  it('🔴 verify-only (แค่ payment.verify): ไม่ error + widget การเงินทั้ง 4 ตัวต้อง null เหมือนกัน', async () => {
    const { gangId, customUser } = await newGangWithCustomRole(['payment.verify'], 'verify_only');
    h.userId = customUser;
    const data = unwrap(await dashboardOverview(gangId));
    expectAllMoneyWidgetsNull(data);
    // [G2] pendingSlips ต้อง payment.verify && gang.finance.view ด้วย — verify-only อย่างเดียวไม่พอ
    expect(data.pendingSlips).toBeNull();
  });

  it('🔴 credit-only (แค่ credit.read.other): ไม่ error + widget การเงินทั้ง 4 ตัวต้อง null เหมือนกัน', async () => {
    const { gangId, customUser } = await newGangWithCustomRole(['credit.read.other'], 'credit_only');
    h.userId = customUser;
    const data = unwrap(await dashboardOverview(gangId));
    expectAllMoneyWidgetsNull(data);
  });

  it('🔴 finance.view + payment.verify (ไม่มี credit.read.other): ยังต้อง null ทั้งชุด — ขาดแค่ตัวเดียวก็พอทำให้ครบไม่ได้', async () => {
    const { gangId, customUser } = await newGangWithCustomRole(['gang.finance.view', 'payment.verify'], 'finance_verify_no_credit');
    h.userId = customUser;
    const data = unwrap(await dashboardOverview(gangId));
    expectAllMoneyWidgetsNull(data);
    // [G2] แต่ pendingSlips ต้องผ่าน (มี payment.verify && gang.finance.view ครบตามเกณฑ์ G2 ซึ่งต่างจาก G1)
    expect(data.pendingSlips).not.toBeNull();
  });

  it('✅ treasurer (bundle ระบบเดิม มีครบทั้ง 3): เห็นทุก widget การเงินครบ ไม่ null เลย', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-g1-treasurer-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const treasurer = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, treasurer]);
    await pool.query(`select public.assign_gang_role($1, $2, 'treasurer', $3)`, [gangId, treasurer, owner]);

    h.userId = treasurer;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.outstanding).not.toBeNull();
    expect(data.netCashThisMonth).not.toBeNull();
    expect(data.monthlyCashFlow).not.toBeNull();
    expect(data.creditOutstanding).not.toBeNull();
    expect(data.pendingSlips).not.toBeNull();
  });

  it('🔴 [QA source review] treasurer ที่ถูกถอน credit.read.other ออก (revoke_gang_role) — widget การเงินทั้งชุดต้องกลับเป็น null ทันที ไม่ใช่ยอดค้างจาก cache/สถานะเก่า', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-revoked-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const revokedTreasurer = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, revokedTreasurer]);
    await pool.query(`select public.assign_gang_role($1, $2, 'treasurer', $3)`, [gangId, revokedTreasurer, owner]);

    // ก่อนถอน: มีสิทธิ์ครบทั้ง 3 จริง (เป็นส่วนหนึ่งของ preset treasurer) — เห็น creditOutstanding
    h.userId = revokedTreasurer;
    const before = unwrap(await dashboardOverview(gangId));
    expect(before.creditOutstanding).not.toBeNull();

    await pool.query(`select public.revoke_gang_role($1, $2, 'treasurer', $3)`, [gangId, revokedTreasurer, owner]);

    const after = unwrap(await dashboardOverview(gangId));
    expectAllMoneyWidgetsNull(after);
  });

  it('🔴 [ไม่ mock DB] client ของ treasurer จริง (JWT เซ็นเอง ผ่าน PostgREST+RLS จริง ไม่ใช่ serviceClient) ต้องได้ยอดรวมทั้งก๊วน', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-realjwt-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const treasurer = await newUser();
    const other = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, treasurer]);
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, other]);
    await pool.query(`select public.assign_gang_role($1, $2, 'treasurer', $3)`, [gangId, treasurer, owner]);

    // เครดิตคงค้างของสมาชิก "คนอื่น" (ไม่ใช่ตัวเอง) — ถ้า RLS/credit.read.other ไม่ทำงานจริง
    // treasurer จะเห็นแค่แถวตัวเอง (0 เพราะไม่มีเครดิต) ไม่ใช่ยอดรวมทั้งก๊วน (150+25=175)
    await pool.query(
      `insert into public.credit_balances (gang_id, user_id, balance) values ($1, $2, 150.00)`,
      [gangId, other],
    );
    await pool.query(
      `insert into public.credit_balances (gang_id, user_id, balance) values ($1, $2, 25.00)`,
      [gangId, treasurer],
    );

    h.userId = treasurer;
    h.asUserId = treasurer; // <- ตัวนี้คือหัวใจของเทสต์: supabaseServer() คืน client ของ treasurer จริง ไม่ใช่ serviceClient()
    try {
      const data = unwrap(await dashboardOverview(gangId));
      expect(data.creditOutstanding).toBe('175.00'); // ยอดรวมทั้งก๊วน ไม่ใช่แค่ 25.00 ของตัวเอง
    } finally {
      h.asUserId = null; // คืนเป็น serviceClient() เสมอ ไม่ให้รั่วไปเทสต์ถัดไป
    }
  });

  it('🔴 [ไม่ mock DB] custom role finance-only จริง (JWT เซ็นเอง ผ่าน PostgREST+RLS จริง ไม่ใช่ serviceClient) ต้องได้ widget การเงินเป็น null จริง ไม่ใช่แค่ service-role มองไม่เห็นแถวโดยบังเอิญ', async () => {
    const { gangId, customUser } = await newGangWithCustomRole(['gang.finance.view'], 'realjwt_finance_only');
    h.userId = customUser;
    h.asUserId = customUser; // RLS จริงผ่าน PostgREST — ไม่ bypass ด้วย service-role
    try {
      const data = unwrap(await dashboardOverview(gangId));
      expectAllMoneyWidgetsNull(data);
    } finally {
      h.asUserId = null;
    }
  });
});

describe('dashboardOverview() — avgAttendeesThisMonth ต้องแบ่งหน้าเหมือน creditOutstanding (QA source review, 3246e9b)', () => {
  it('🔴 session_registrations รวมกันเกิน 1000 แถวในเดือนนี้ (หลายนัด × guest เยอะ) ต้องนับได้ครบ ไม่ใช่โดน max_rows ตัด', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-regpaginate-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    // 2 นัดในเดือนนี้ (future-ish, ภายในวันนี้) นัดละ 503 guest confirmed รวม 1006 > max_rows 1000
    const startIso = new Date(Date.now() + 2 * 3600_000).toISOString();
    const endIso = new Date(Date.now() + 4 * 3600_000).toISOString();
    let totalRegs = 0;
    for (let s = 0; s < 2; s++) {
      const {
        rows: [session],
      } = await pool.query<{ id: string }>(
        `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
         values ($1, $2, $3, $4, 1000, 'open') returning id`,
        [gangId, `นัดทดสอบ pagination ${s}`, startIso, endIso],
      );
      const N = 503;
      await pool.query(
        `insert into public.session_registrations (session_id, guest_name, status)
         select $1, 'เกสต์ ' || gs, 'confirmed' from generate_series(1, $2) gs`,
        [session.id, N],
      );
      totalRegs += N;
    }
    expect(totalRegs).toBeGreaterThan(1000);

    h.userId = admin;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.sessionsThisMonth).toBe(2);
    expect(data.avgAttendeesThisMonth).toEqual({ totalSeated: totalRegs, sessionCount: 2 });
  }, 30_000);
});

describe('dashboardOverview() — [QA F1 regression] loadRegistrationsBySessions ต้องแบ่งหน้าเหมือนกัน (next+following รวมกันเกิน 1000 แถว)', () => {
  it('🔴 next+following (2 นัด × 503 guest confirmed = 1006 > max_rows 1000) ต้องนับ seatedCount/guestCount ครบทั้ง 2 นัด ไม่ใช่โดนตัดที่ 1000 รวม', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-regbysess-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    // นัดแรก (next) เร็วกว่า นัดที่สอง (following) ชัดเจน — ป้องกัน flaky ลำดับ
    const s1Start = new Date(Date.now() + 2 * 3600_000).toISOString();
    const s1End = new Date(Date.now() + 3 * 3600_000).toISOString();
    const s2Start = new Date(Date.now() + 5 * 3600_000).toISOString();
    const s2End = new Date(Date.now() + 6 * 3600_000).toISOString();

    const {
      rows: [s1],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดถัดไป regbysess', $2, $3, 1000, 'open') returning id`,
      [gangId, s1Start, s1End],
    );
    const {
      rows: [s2],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดถัดไปอีกที regbysess', $2, $3, 1000, 'open') returning id`,
      [gangId, s2Start, s2End],
    );

    const N = 503; // 503 + 503 = 1006 > PostgREST max_rows 1000 — เคสเดียวกับที่ QA เจอใน 47b3591
    for (const s of [s1, s2]) {
      await pool.query(
        `insert into public.session_registrations (session_id, guest_name, status)
         select $1, 'เกสต์ regbysess ' || gs, 'confirmed' from generate_series(1, $2) gs`,
        [s.id, N],
      );
    }

    h.userId = admin;
    const data = unwrap(await dashboardOverview(gangId));

    expect(data.nextSession?.id).toBe(s1.id);
    expect(data.nextSession?.seatedCount).toBe(N);
    expect(data.nextSession?.guestCount).toBe(N);
    expect(data.nextSession?.waitlistCount).toBe(0);

    expect(data.followingSession?.id).toBe(s2.id);
    expect(data.followingSession?.seatedCount).toBe(N);
    expect(data.followingSession?.guestCount).toBe(N);
    expect(data.followingSession?.waitlistCount).toBe(0);
  }, 30_000);
});

describe('dashboardOverview() — [WO-6.7, #51, planner อนุมัติ] onboardingChecklist computed-only widget', () => {
  it('🔴 [ไม่ mock DB] admin จริง (ไม่ใช่ owner, JWT เซ็นเอง ผ่าน PostgREST+RLS จริง) ต้องอ่าน gang_pricing_plans ได้ (is_gang_member RLS ไม่ใช่ is_gang_admin/owner เท่านั้น) → hasPricingPlan=true + hasFirstSession=true', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-onboard-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    // created_by = owner ตั้งใจ — พิสูจน์ RLS ให้ admin (คนละคนจาก created_by) อ่านได้จริง ไม่ใช่เช็ค ownership แถว
    await pool.query(
      `insert into public.gang_pricing_plans (gang_id, name, type, params, created_by)
       values ($1, 'แผนทดสอบ onboarding', 'flat_rate', '{"amount_per_person":"100.00"}'::jsonb, $2)`,
      [gangId, owner],
    );
    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดแรก onboarding', now() + interval '1 day', now() + interval '1 day 2 hours', 10, 'open')`,
      [gangId],
    );

    h.userId = admin;
    h.asUserId = admin; // 🔴 หัวใจของเทสต์นี้ — ไม่ bypass RLS ด้วย serviceClient()
    try {
      const data = unwrap(await dashboardOverview(gangId));
      expect(data.onboardingChecklist).toEqual({ hasPricingPlan: true, hasFirstSession: true });
    } finally {
      h.asUserId = null;
    }
  });

  it('🔴 ก๊วนใหม่ยังไม่ตั้งราคา/ยังไม่มีนัดเลย: ทั้งคู่ false', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-onboard-empty-${crypto.randomUUID()}`]);
    const gangId = gang.id;

    h.userId = owner;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.onboardingChecklist).toEqual({ hasPricingPlan: false, hasFirstSession: false });
  });

  it('🔴 pricing plan ที่ is_active=false (ปิดใช้งานแล้ว) ไม่นับว่า "ตั้งราคาแล้ว"', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-onboard-inactive-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    await pool.query(
      `insert into public.gang_pricing_plans (gang_id, name, type, params, is_active, created_by)
       values ($1, 'แผนปิดใช้งาน', 'flat_rate', '{"amount_per_person":"100.00"}'::jsonb, false, $2)`,
      [gangId, owner],
    );

    h.userId = owner;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.onboardingChecklist?.hasPricingPlan).toBe(false);
  });

  it('🔴 สมาชิกทั่วไป (ไม่มี gang.update): onboardingChecklist ต้องเป็น null ทั้ง object ไม่ใช่ {false,false}', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-onboard-member-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const plain = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, plain]);

    h.userId = plain;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.onboardingChecklist).toBeNull();
  });
});

describe('dashboardOverview() — [planner F2] query error ต้อง throw จริง ไม่ใช่คืน null/0 แบบเงียบๆ', () => {
  it('🔴 sessions table query fail (loadNextSession playing/open + loadMonthSessions) → ApiResponse ต้อง success=false ไม่ใช่ nextSession=null แบบปกติ', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-poison-sessions-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    h.userId = admin;
    h.poisonTable = 'sessions';
    try {
      const res = await dashboardOverview(gangId);
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('INTERNAL_ERROR');
    } finally {
      h.poisonTable = null;
    }
  });

  it('🔴 session_registrations query fail (loadNextSession regs + attendeesOf) → ApiResponse ต้อง success=false ไม่ใช่ seatedCount/avg=0 แบบปกติ', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-poison-regs-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);
    // ต้องมีนัด 'open' ของวันนี้อยู่จริง ไม่งั้น loadNextSession คืน null ก่อนจะเรียก regs query เลย (ไม่ทดสอบจุดที่ต้องการ)
    const startIso = new Date(Date.now() + 2 * 3600_000).toISOString();
    const endIso = new Date(Date.now() + 4 * 3600_000).toISOString();
    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดทดสอบ poison regs', $2, $3, 20, 'open')`,
      [gangId, startIso, endIso],
    );

    h.userId = admin;
    h.poisonTable = 'session_registrations';
    try {
      const res = await dashboardOverview(gangId);
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('INTERNAL_ERROR');
    } finally {
      h.poisonTable = null;
    }
  });
});

describe('dashboardOverview() — [planner] ขอบเวลา เที่ยงคืนเวลาไทย (23:59/00:00) และช่วงสิ้นเดือน', () => {
  it('🔴 นัดที่ 23:59:59.999 เวลาไทยของ "เมื่อวาน" ต้องไม่ถูกนับเป็นนัดถัดไปของวันนี้ — นัดที่ 00:00:00.000 เวลาไทยของวันนี้ต้องถูกนับ', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-midnight-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    const today = thaiToday();
    const todayStartUtc = financeRange({ from: today, to: today }).startUtc; // = เที่ยงคืนเวลาไทยของวันนี้ แปลงเป็น UTC แล้ว
    const todayStartMs = new Date(todayStartUtc).getTime();

    const yesterdayLateIso = new Date(todayStartMs - 1).toISOString(); // 23:59:59.999 เวลาไทยของเมื่อวาน
    const todayMidnightIso = new Date(todayStartMs).toISOString(); // 00:00:00.000 เวลาไทยของวันนี้พอดี
    const endLate = new Date(todayStartMs - 1 + 3600_000).toISOString();
    const endMidnight = new Date(todayStartMs + 3600_000).toISOString();

    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดเมื่อวาน 23:59:59.999 ไทย', $2, $3, 10, 'open')`,
      [gangId, yesterdayLateIso, endLate],
    );
    const {
      rows: [todaySession],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดวันนี้ 00:00:00.000 ไทยพอดี', $2, $3, 10, 'open') returning id`,
      [gangId, todayMidnightIso, endMidnight],
    );

    h.userId = admin;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.nextSession).not.toBeNull();
    expect(data.nextSession?.id).toBe(todaySession.id); // ต้องเป็นนัดวันนี้ ไม่ใช่นัดเมื่อวานที่ใกล้เที่ยงคืนมาก
  });

  it('🔴 นัดที่วินาทีสุดท้ายของเดือนนี้ (เวลาไทย) ต้องถูกนับเป็น "เดือนนี้" — นัดที่วินาทีแรกของเดือนหน้าต้องไม่ถูกนับ', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [owner, `ก๊วน-dash-monthend-${crypto.randomUUID()}`]);
    const gangId = gang.id;
    const admin = await newUser();
    await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`, [gangId, admin]);

    const today = thaiToday();
    const { year, month } = thaiMonthOf(today);
    const range = monthDateRange(year, month);
    const thisMonthRange = financeRange(range); // .endUtcExclusive = เที่ยงคืนเวลาไทยของวันที่ 1 เดือนหน้า
    const monthEndExclusiveMs = new Date(thisMonthRange.endUtcExclusive).getTime();

    const lastInstantOfMonthIso = new Date(monthEndExclusiveMs - 1).toISOString(); // วินาทีสุดท้ายของเดือนนี้
    const firstInstantOfNextMonthIso = new Date(monthEndExclusiveMs).toISOString(); // วินาทีแรกของเดือนหน้าพอดี

    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดวินาทีสุดท้ายของเดือนนี้', $2, $3, 10, 'open')`,
      [gangId, lastInstantOfMonthIso, new Date(monthEndExclusiveMs - 1 + 3600_000).toISOString()],
    );
    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status)
       values ($1, 'นัดวินาทีแรกของเดือนหน้า', $2, $3, 10, 'open')`,
      [gangId, firstInstantOfNextMonthIso, new Date(monthEndExclusiveMs + 3600_000).toISOString()],
    );

    h.userId = admin;
    const data = unwrap(await dashboardOverview(gangId));
    expect(data.sessionsThisMonth).toBe(1); // นับแค่นัดวินาทีสุดท้ายของเดือนนี้ ไม่ใช่นัดเดือนหน้า
  });
});
