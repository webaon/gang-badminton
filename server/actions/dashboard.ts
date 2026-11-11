'use server';

import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import { loadGangPermissionContext } from '@/server/permissions/gang-context';
import { isSeated } from '@/domain/sessions/member-view';
import { splitCashFlow } from '@/domain/reports/finance';
import { buildTimeline, type TimelineEvent, type TimelineItem } from '@/domain/reports/timeline';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { thaiToday, thaiMonthOf, monthDateRange, last6Months } from '@/server/sessions/dashboard-dates';
import { uuid } from '@/server/payments/admin-read';
import { financeRange } from '@/server/payments/report-range';
import { adminLedger } from './payment-admin';
import { adminPaymentList } from './payment-list';
import { financeReport } from './finance-report';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

/**
 * WO-6.5c — H10 dashboard overview (aggregate loader) **[planner อนุมัติ scope 31 ต.ค. 2026]**
 *
 * 🔴 กฎที่ต้องตามให้ครบ (คำสั่ง planner):
 *   1. การเงินทุกตัวมาจาก `financeReport()`/`adminLedger()`/`adminPaymentList()` เดิม — **ไม่คิดสูตรใหม่เลย**
 *   2. roster/attendee count ใช้ `isSeated()` เดียวกับ roster/console — ไม่นิยามใหม่
 *   3. สิทธิ์แยกต่อ widget ผ่าน `loadGangPermissionContext()` + `can()` — ไม่มีสิทธิ์ = คืน `null`
 *      (ไม่ใช่ 0) ให้ UI ซ่อน widget ได้ · outsider (ไม่ใช่สมาชิกก๊วนเลย) = `NOT_FOUND`
 *   4. ห้ามแสดงคำว่า "กำไร" ที่ไหนเลย (ย้ำจากคำตัดสิน WO-6.5 เดิม บรรทัด 433 ของแผน) — มีแต่
 *      "เงินสดสุทธิเดือนนี้" (`netCashThisMonth`) แยกจาก "เครดิตสมาชิกคงค้าง" (`creditOutstanding`)
 *   5. timeline ทั้งก๊วนอ่านผ่าน `buildTimeline()`/`describeEvent()` เดิมเท่านั้น ห้ามอ่าน raw payload
 *
 * 🔴 ไม่เรียก `financeReader()`/`adminLedger()`/`adminPaymentList()` ทันทีแบบไม่เช็คก่อน — ฟังก์ชันพวกนั้น
 *    `assertCan()` ภายใน (throw FORBIDDEN ทั้ง request) ซึ่งจะทำให้ widget อื่นที่ไม่เกี่ยวกับการเงินพังไปด้วย
 *    ⇒ เช็ค `can(ctx, action)` ที่นี่ก่อนเสมอ แล้วค่อยเรียกต่อเมื่อผ่าน (เรียกแล้วไม่ throw เพราะเช็คมาก่อนแล้ว)
 */

export type DashboardNextSession = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  courtCount: number;
  /** นับด้วย `isSeated()` เดียวกับ roster/console (confirmed + checked_in) */
  seatedCount: number;
  waitlistCount: number;
  /** จำนวน guest ในกลุ่มที่ seated แล้ว (userId เป็น null) */
  guestCount: number;
};

export type DashboardOverview = {
  nextSession: DashboardNextSession | null;
  memberCount: number;
  newMembersThisMonth: number;
  sessionsThisMonth: number;
  /** ตัวเลขดิบพร้อมตัวหาร — UI format เอง (ห้ามหารในนี้) */
  avgAttendeesThisMonth: { totalSeated: number; sessionCount: number };
  /** null = ไม่มีสิทธิ์ billing.close */
  unclosedSessionsCount: number | null;
  /** null = ไม่มีสิทธิ์ gang.join_request.manage (รวมกรณีปิด features.discovery) */
  joinRequestsPending: number | null;
  /** null = ไม่มีสิทธิ์ gang.finance.view */
  outstanding: { amount: string; debtors: number } | null;
  /** null = ไม่มีสิทธิ์ payment.verify */
  pendingSlips: { count: number; oldestDays: number | null } | null;
  /** null = ไม่มีสิทธิ์ gang.finance.view — ห้ามเรียกว่า "กำไร" */
  netCashThisMonth: string | null;
  /** null = ไม่มีสิทธิ์ gang.finance.view AND credit.read.other (RLS ของ credit_balances ต้องการ credit.read.other เสมอ — มีแค่ finance.view ไม่พอ) */
  creditOutstanding: string | null;
  /** null = ไม่มีสิทธิ์ gang.finance.view — เรียงเก่า→ใหม่ 6 เดือน ป้าย "เงินเข้า/เงินออก" เท่านั้น */
  monthlyCashFlow: { month: string; inflow: string; outflow: string }[] | null;
  /** กรองตาม payment.verify อยู่แล้วใน buildTimeline() — ไม่ต้องเช็คซ้ำ */
  recentActivity: TimelineItem[];
};

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

export async function dashboardOverview(gangId: string): Promise<ApiResponse<DashboardOverview>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    uuid(gangId);
    const user = await requireUser();
    const ctx = await loadGangPermissionContext(gangId, user.id);

    // outsider (ไม่ใช่สมาชิกก๊วนนี้เลย) ต้องได้ NOT_FOUND ไม่ใช่ FORBIDDEN — ไม่ให้รู้ว่าก๊วนมีอยู่
    if (ctx.role === null) throw new AppError('NOT_FOUND', 'ไม่พบก๊วนนี้');

    const db = await supabaseServer();
    const today = thaiToday();
    const { year: thisYear, month: thisMonth } = thaiMonthOf(today);
    const thisMonthRange = financeRange(monthDateRange(thisYear, thisMonth));

    const [nextSession, memberCount, newMembersThisMonth, monthSessions] = await Promise.all([
      loadNextSession(db, gangId, financeRange({ from: today, to: today }).startUtc),
      countRows(db, 'gang_members', (q) => q.eq('gang_id', gangId).is('deleted_at', null)),
      countRows(db, 'gang_members', (q) =>
        q.eq('gang_id', gangId).is('deleted_at', null)
          .gte('created_at', thisMonthRange.startUtc).lt('created_at', thisMonthRange.endUtcExclusive)),
      loadMonthSessions(db, gangId, thisMonthRange),
    ]);

    const avgAttendeesThisMonth = await attendeesOf(db, monthSessions);

    const unclosedSessionsCount = can(ctx, 'billing.close')
      ? await countRows(db, 'sessions', (q) =>
          q.eq('gang_id', gangId).is('deleted_at', null).in('status', ['open', 'in_play']).lt('ends_at', new Date().toISOString()))
      : null;

    const joinRequestsPending = can(ctx, 'gang.join_request.manage')
      ? await countRows(db, 'join_requests', (q) => q.eq('gang_id', gangId).eq('status', 'pending'))
      : null;

    const outstanding = can(ctx, 'gang.finance.view') ? await loadOutstanding(gangId) : null;
    const pendingSlips = can(ctx, 'payment.verify') ? await loadPendingSlips(gangId) : null;

    let netCashThisMonth: string | null = null;
    let creditOutstanding: string | null = null;
    let monthlyCashFlow: DashboardOverview['monthlyCashFlow'] = null;

    if (can(ctx, 'gang.finance.view')) {
      const thisMonthReport = await financeReport(gangId, { from: thisMonthRange.from, to: thisMonthRange.to });
      if (!thisMonthReport.success) throw thisMonthReport.error;
      netCashThisMonth = thisMonthReport.data.report.netCash;

      // [planner 31 ต.ค. 2026] ถอนการอนุมัติเดิมที่ให้ gang.finance.view เห็น creditOutstanding ได้เลย —
      // RLS ของ credit_balances (0051:256-264) อนุญาตแค่ credit.read.other หรือแถวของตัวเอง เท่านั้น
      // คนที่มี gang.finance.view อย่างเดียวจะได้ 0/บางส่วนแบบเงียบๆ ไม่ใช่ FORBIDDEN ⇒ ต้องเช็คสองสิทธิ์
      // พร้อมกัน ไม่งั้นคืน null (ให้ UI ซ่อน) ไม่ใช่เลขที่โกหก ห้าม service-role/migration ตามคำสั่ง
      creditOutstanding = can(ctx, 'credit.read.other') ? await loadCreditOutstanding(db, gangId) : null;

      const startedAt = Date.now();
      monthlyCashFlow = await Promise.all(
        last6Months(today).map(async ({ year, month }) => {
          const range = monthDateRange(year, month);
          const res = await financeReport(gangId, range);
          if (!res.success) throw res.error;
          const split = splitCashFlow({
            transferIn: res.data.transferIn,
            refunds: res.data.refunds,
            overpaymentIn: res.data.report.overpaymentIn,
            otherIncome: res.data.report.otherIncome,
            expense: res.data.report.expense,
            memberPayouts: res.data.report.memberPayouts,
          });
          return { month: `${year}-${String(month).padStart(2, '0')}`, ...split };
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 1500) {
        console.warn(`[dashboardOverview] monthlyCashFlow (6x financeReport) ใช้เวลา ${elapsedMs}ms เกิน 1.5s`, { gangId, correlationId });
      }
    }

    const recentActivity = await loadRecentActivity(db, gangId, can(ctx, 'payment.verify'));

    return {
      nextSession,
      memberCount,
      newMembersThisMonth,
      sessionsThisMonth: monthSessions.length,
      avgAttendeesThisMonth,
      unclosedSessionsCount,
      joinRequestsPending,
      outstanding,
      pendingSlips,
      netCashThisMonth,
      creditOutstanding,
      monthlyCashFlow,
      recentActivity,
    };
  });
}

type SupaClient = Awaited<ReturnType<typeof supabaseServer>>;
/** Type ของ builder หลังเรียก `.select()` แล้ว (มี `.eq()`/`.in()`/... ให้เรียกต่อ) — ไม่ใช่ตัวก่อน select ที่ยังไม่มี */
type CountBuilder = ReturnType<ReturnType<SupaClient['from']>['select']>;

/** `count: 'exact', head: true` — ไม่โดนเพดาน 1000 แถวของ PostgREST เพราะไม่ดึงแถวจริงเลย [planner] */
async function countRows(
  db: SupaClient,
  table: string,
  filter: (q: CountBuilder) => CountBuilder,
): Promise<number> {
  const base = db.from(table).select('*', { count: 'exact', head: true });
  const { count, error } = await filter(base);
  if (error) throw error;
  return count ?? 0;
}

/**
 * นัดถัดไป/กำลังเล่น — "ใกล้ที่สุด (เริ่มวันนี้ หรือกำลังเล่นอยู่)" [planner]
 * กำลังเล่นมาก่อนเสมอ (เร่งด่วนกว่า) ไม่งั้นเอานัด open ที่ starts_at ใกล้ที่สุด **นับจากวันนี้เป็นต้นไป**
 * (ไม่ใช่นัด open ที่เก่าที่สุดเฉยๆ — นัดเก่าที่ค้างสถานะ open ไม่เคยถูกปิด ต้องไม่โผล่เป็น "นัดถัดไป")
 */
async function loadNextSession(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  gangId: string,
  todayStartUtc: string,
): Promise<DashboardNextSession | null> {
  // [fix] ต้องเป็น string literal ตรงๆ ใน .select(...) ไม่ใช่ตัวแปร — tests/postgrest/embeds.test.ts
  // สแกนด้วย regex หา .select('...') เป็น literal เท่านั้น ถ้าใช้ตัวแปรมันจะข้ามไปจับคู่ .from()
  // ตัวนี้กับ .select('...') literal ตัวถัดไปใน source ผิดตัว (เจอจริงจากเทสต์ 19/08) ⇒ ไม่ย่อด้วยตัวแปร
  const { data: playing } = await db.from('sessions').select('id, title, starts_at, ends_at, status, court_count')
    .eq('gang_id', gangId).is('deleted_at', null).eq('status', 'in_play')
    .order('starts_at', { ascending: true }).limit(1).maybeSingle();

  const row = playing ?? (
    await db.from('sessions').select('id, title, starts_at, ends_at, status, court_count')
      .eq('gang_id', gangId).is('deleted_at', null).eq('status', 'open')
      .gte('starts_at', todayStartUtc)
      .order('starts_at', { ascending: true }).limit(1).maybeSingle()
  ).data;

  if (!row) return null;

  const { data: regs } = await db.from('session_registrations')
    .select('status, user_id')
    .eq('session_id', row.id as string).is('deleted_at', null);

  const rows = (regs ?? []) as { status: string; user_id: string | null }[];
  const seated = rows.filter((r) => isSeated(r.status));

  return {
    id: row.id as string,
    title: row.title as string,
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    status: row.status as string,
    courtCount: row.court_count as number,
    seatedCount: seated.length,
    waitlistCount: rows.filter((r) => r.status === 'waitlist').length,
    guestCount: seated.filter((r) => r.user_id === null).length,
  };
}

/** นัดในเดือนนี้ (เวลาไทย) ที่ไม่ cancelled — ตัวหารของ "เฉลี่ยคน/นัด" [planner #3(ก)] */
async function loadMonthSessions(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  gangId: string,
  range: ReturnType<typeof financeRange>,
): Promise<{ id: string }[]> {
  const { data, error } = await db.from('sessions').select('id')
    .eq('gang_id', gangId).is('deleted_at', null).neq('status', 'cancelled')
    .gte('starts_at', range.startUtc).lt('starts_at', range.endUtcExclusive);
  if (error) throw error;
  return (data ?? []) as { id: string }[];
}

/** เฉลี่ยคน/นัด — นับ "ลงชื่อแล้ว" ด้วย `isSeated()` เดียวกับ roster/console [planner #3(ก)] ไม่หารในนี้ */
async function attendeesOf(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  sessions: { id: string }[],
): Promise<{ totalSeated: number; sessionCount: number }> {
  if (sessions.length === 0) return { totalSeated: 0, sessionCount: 0 };
  const { data, error } = await db.from('session_registrations')
    .select('status')
    .in('session_id', sessions.map((s) => s.id))
    .is('deleted_at', null);
  if (error) throw error;
  const totalSeated = ((data ?? []) as { status: string }[]).filter((r) => isSeated(r.status)).length;
  return { totalSeated, sessionCount: sessions.length };
}

/** ค้างจ่าย + จำนวนลูกหนี้ — ใช้ `adminLedger()` เดิมเป๊ะๆ (#4) [planner: ของเดิม ไม่คิดใหม่] */
async function loadOutstanding(gangId: string): Promise<{ amount: string; debtors: number }> {
  const res = await adminLedger(gangId, { pageSize: 1, filter: { status: 'outstanding' } });
  if (!res.success) throw res.error;
  return { amount: res.data.summary.outstanding, debtors: res.data.summary.debtors };
}

/** สลิปรอตรวจ + เก่าสุด — ใช้ `adminPaymentList()` เดิมเป๊ะๆ (#5) [planner: ของเดิม ไม่คิดใหม่] */
async function loadPendingSlips(gangId: string): Promise<{ count: number; oldestDays: number | null }> {
  const res = await adminPaymentList(gangId, { pageSize: 1, filter: { status: 'submitted' } });
  if (!res.success) throw res.error;
  const oldest = res.data.rows[0];
  const oldestDays = oldest?.submittedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(oldest.submittedAt).getTime()) / 86_400_000))
    : null;
  return { count: res.data.counts.submitted, oldestDays };
}

/**
 * เครดิตสมาชิกคงค้างทั้งก๊วน (#6 ส่วนที่สอง) — sum ตรงๆแบบเดียวกับที่ `listGangCredits()` ทำภายใน
 * (ไม่เรียก `listGangCredits()` ตรงๆ เพราะต้องการแค่ยอดรวม ไม่ใช่รายชื่อสมาชิกทีละคน — เรียกจะ fetch
 * ชื่อ/breakdown เกินจำเป็น ⇒ sum ตรงจาก credit_balances เอง)
 *
 * 🔴 [planner 31 ต.ค. 2026] **เรียกได้ต่อเมื่อผู้ใช้มี `credit.read.other` ด้วย** ไม่ใช่แค่
 * `gang.finance.view` — ผู้เรียกต้องเช็คเองก่อนเรียกฟังก์ชันนี้ (ดู caller ด้านบน) เพราะ RLS ของ
 * `credit_balances` (0051:256-264) อนุญาตแค่ `credit.read.other` หรือแถวของตัวเองเท่านั้น คนที่มีแค่
 * `gang.finance.view` เรียกฟังก์ชันนี้ตรงๆจะได้ยอดไม่ครบ (RLS กรองแถวออกเงียบๆ ไม่ throw) — เคยอนุมัติ
 * ให้ใช้ gang.finance.view อย่างเดียวได้ แต่ planner ถอนคำอนุมัตินั้นหลัง QA เจอช่องโหว่นี้
 *
 * 🔴 แบ่งหน้าด้วย keyset cursor บน `user_id` — PostgREST มี max_rows=1000
 * เป็น default เสมอ (ไม่ใช่แค่ตัวที่ตั้ง `head:true` ไว้) ก๊วนที่มีสมาชิกเกิน 1 หน้าจะได้ยอดไม่ครบถ้าดึง
 * ครั้งเดียว `credit_balances` PK คือ (gang_id, user_id) ไม่มีคอลัมน์ `id` ⇒ ใช้ `allById()` เดิม
 * (ที่ต้องมี `id: string`) ไม่ได้ตรงๆ จึงเขียน loop cursor บน user_id เองแทน — ตรรกะเดียวกัน
 */
async function loadCreditOutstanding(
  db: SupaClient,
  gangId: string,
): Promise<string> {
  const PAGE = 500;
  let after: string | null = null;
  const balances: string[] = [];
  for (;;) {
    let q = db.from('credit_balances')
      .select('user_id, balance').eq('gang_id', gangId).gt('balance', 0)
      .order('user_id', { ascending: true }).limit(PAGE);
    if (after) q = q.gt('user_id', after);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as { user_id: string; balance: string | number }[];
    balances.push(...rows.map((r) => String(r.balance)));
    if (rows.length < PAGE) break;
    const next = rows[rows.length - 1].user_id;
    if (next === after) throw new AppError('INTERNAL_ERROR', 'อ่านเครดิตคงค้างหน้าถัดไปไม่สำเร็จ');
    after = next;
  }
  return fromSatang(sumSatang(balances.map((b) => toSatang(b))));
}

/**
 * ไทม์ไลน์ทั้งก๊วน (#12) — ข้าม session_id เดียว (ต่างจาก `SessionDetailPage.tsx` ที่ query ต่อนัด)
 * แปลงผ่าน `buildTimeline()`/`describeEvent()` เดิมเท่านั้น — ห้ามอ่าน payload ดิบที่นี่เลย
 */
async function loadRecentActivity(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  gangId: string,
  canSeeMoney: boolean,
): Promise<TimelineItem[]> {
  const { data, error } = await db.from('event_logs')
    .select('id, event_type, created_at, payload, profiles!event_logs_actor_id_fkey(display_name)')
    .eq('gang_id', gangId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  type Row = {
    id: string; event_type: string; created_at: string; payload: Record<string, unknown> | null;
    profiles: { display_name: string } | null;
  };

  const events: TimelineEvent[] = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    eventType: r.event_type,
    createdAt: r.created_at,
    actorName: r.profiles?.display_name ?? null,
    payload: r.payload ?? {},
  }));

  return buildTimeline(events, canSeeMoney);
}
