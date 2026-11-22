'use server';

import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can, canSeeGangMoney } from '@/domain/permissions/can';
import { loadGangPermissionContext } from '@/server/permissions/gang-context';
import { isSeated } from '@/domain/sessions/member-view';
import { splitCashFlow, cashFlowRatiosOf } from '@/domain/reports/finance';
import { buildTimeline, type TimelineEvent, type TimelineItem } from '@/domain/reports/timeline';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { thaiToday, thaiMonthOf, monthDateRange, last6Months } from '@/server/sessions/dashboard-dates';
import { ADMIN_READ_PAGE, allById, uuid } from '@/server/payments/admin-read';
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
  /** [WO-6.5c-DTO] จำนวนผู้เล่นสูงสุด — `sessions.max_players` ตรงๆ (คอลัมน์มีอยู่แล้ว ไม่ใช่ field ใหม่ของ DB) */
  maxPlayers: number;
  /** [WO-6.5c-DTO] ชื่อ/เลขคอร์ท — `sessions.court_labels` (jsonb) validate เป็น string[] เอง เพราะ
   *  jsonb ไม่มีการันตีรูปร่างที่ compile time; array ว่างถ้าไม่มีข้อมูลหรือ shape ไม่ตรง (ไม่ throw) */
  courtLabels: string[];
  /** นับด้วย `isSeated()` เดียวกับ roster/console (confirmed + checked_in) */
  seatedCount: number;
  waitlistCount: number;
  /** จำนวน guest ในกลุ่มที่ seated แล้ว (userId เป็น null) */
  guestCount: number;
};

export type DashboardOverview = {
  nextSession: DashboardNextSession | null;
  /** [WO-6.5c-DTO, planner] นัดลำดับที่ 2 — shape เดียวกับ nextSession ใช้ตรรกะ "in_play มาก่อนเสมอ
   *  ไม่งั้นเอานัด open เรียงตาม starts_at" เดียวกัน เพียงแค่เอาแถวที่ 2 ต่อจาก nextSession นั่นเอง */
  followingSession: DashboardNextSession | null;
  memberCount: number;
  newMembersThisMonth: number;
  sessionsThisMonth: number;
  /** ตัวเลขดิบพร้อมตัวหาร — UI format เอง (ห้ามหารในนี้) */
  avgAttendeesThisMonth: { totalSeated: number; sessionCount: number };
  /** null = ไม่มีสิทธิ์ billing.close */
  unclosedSessionsCount: number | null;
  /** null = ไม่มีสิทธิ์ gang.join_request.manage (รวมกรณีปิด features.discovery) */
  joinRequestsPending: number | null;
  /** null = ไม่มีสิทธิ์ครบ `canSeeGangMoney()` (finance.view && payment.verify && credit.read.other — G1) */
  outstanding: { amount: string; debtors: number } | null;
  /** null = ไม่มีสิทธิ์ครบ `payment.verify && gang.finance.view` (G2 — payment-list.ts ต้องอ่าน session_charges ด้วย) */
  pendingSlips: { count: number; oldestDays: number | null } | null;
  /** null = ไม่มีสิทธิ์ครบ `canSeeGangMoney()` (G1) — ห้ามเรียกว่า "กำไร" */
  netCashThisMonth: string | null;
  /** null = ไม่มีสิทธิ์ครบ `canSeeGangMoney()` (G1 — เดิมเช็คแค่ finance.view+credit.read.other แยก แก้เป็น gate เดียวกันทั้ง 4 ตัวตามคำตัดสิน QA RLS chain) */
  creditOutstanding: string | null;
  /** null = ไม่มีสิทธิ์ครบ `canSeeGangMoney()` (G1) — เรียงเก่า→ใหม่ 6 เดือน ป้าย "เงินเข้า/เงินออก" เท่านั้น
   *  [WO-6.5c-DTO] inRatio/outRatio เพิ่มใหม่ — number 0..1 เทียบกับ max ร่วมตัวเดียวจากทั้ง 12 ค่า
   *  (inflow 6 เดือน + outflow 6 เดือน รวมกัน ไม่ใช่ max แยก series) ดู `cashFlowRatiosOf()` */
  monthlyCashFlow: { month: string; inflow: string; outflow: string; inRatio: number; outRatio: number }[] | null;
  /** กรองด้วย canSeeFinance(gang.finance.view)/canSeeOtherAdminOnly(gang.member.manage) อยู่แล้วใน buildTimeline() — ไม่ต้องเช็คซ้ำ (G3) */
  recentActivity: TimelineItem[];
  /** [WO-6.5c-DTO] ชื่อที่แสดงของผู้ใช้ปัจจุบัน — ข้อมูลของตัวเอง ไม่ต้องเช็ค gate เพิ่ม (ไม่ nullable) */
  viewerDisplayName: string;
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

    const [nextAndFollowing, memberCount, newMembersThisMonth, monthSessions, viewerDisplayName] = await Promise.all([
      loadNextAndFollowingSessions(db, gangId, financeRange({ from: today, to: today }).startUtc),
      countRows(db, 'gang_members', (q) => q.eq('gang_id', gangId).is('deleted_at', null)),
      countRows(db, 'gang_members', (q) =>
        q.eq('gang_id', gangId).is('deleted_at', null)
          .gte('created_at', thisMonthRange.startUtc).lt('created_at', thisMonthRange.endUtcExclusive)),
      loadMonthSessions(db, gangId, thisMonthRange),
      // [WO-6.5c-DTO, planner] ข้อมูลของตัวเอง ไม่ต้องเช็ค gate เพิ่ม — ผ่าน db (RLS client เดิม) ไม่ใช่
      // service-role (ยืนยันกับ planner แล้ว)
      loadViewerDisplayName(db, user.id),
    ]);
    const { next: nextSession, following: followingSession } = nextAndFollowing;

    const avgAttendeesThisMonth = await attendeesOf(db, monthSessions);

    const unclosedSessionsCount = can(ctx, 'billing.close')
      ? await countRows(db, 'sessions', (q) =>
          q.eq('gang_id', gangId).is('deleted_at', null).in('status', ['open', 'in_play']).lt('ends_at', new Date().toISOString()))
      : null;

    const joinRequestsPending = can(ctx, 'gang.join_request.manage')
      ? await countRows(db, 'join_requests', (q) => q.eq('gang_id', gangId).eq('status', 'pending'))
      : null;

    // 🔴 [planner G1, QA RLS-chain review] outstanding(#4)/netCashThisMonth/monthlyCashFlow(#10)/
    // creditOutstanding ต้อง gate เดียวกันทั้ง 4 ตัว — canSeeGangMoney() = finance.view && payment.verify
    // && credit.read.other เพราะแต่ละยอดดึงจากตารางที่มี RLS คนละสิทธิ์กัน (session_charges ต้อง
    // finance.view, allocations/payments ต้อง payment.verify, credit_balances ต้อง credit.read.other)
    // ถ้าขาดอย่างใดอย่างหนึ่ง RLS กรองแถวออกเงียบๆ ไม่ throw ⇒ ต้องครบทั้ง 3 ไม่งั้นคืน null ทั้งชุด
    // (ไม่ใช่สิทธิ์ใหม่ — treasurer/admin มีครบทั้ง 3 อยู่แล้วจึงไม่โดนผลกระทบ จะโดนเฉพาะ custom role)
    const canSeeMoney = canSeeGangMoney(ctx);
    const outstanding = canSeeMoney ? await loadOutstanding(gangId) : null;
    // 🔴 [planner G2] pendingSlips(#5) ต้อง payment.verify && gang.finance.view (ไม่ใช่ payment.verify
    // เดี่ยวๆ) เพราะ payment-list.ts (adminPaymentList) อ่าน session_charges ด้วย ซึ่งต้อง finance.view
    // แยกคนละบรรทัดตั้งใจ — ให้ guard-site drift test (tests/security/permission-context-coverage.test.ts)
    // เห็น can() 2 ตัวนี้เป็น 2 call site ที่ไม่ชนกัน (manifest key คือ file:line เดี่ยวๆ)
    const canVerify = can(ctx, 'payment.verify');
    const canSeeFinanceForSlips = can(ctx, 'gang.finance.view');
    const pendingSlips = (canVerify && canSeeFinanceForSlips)
      ? await loadPendingSlips(gangId)
      : null;

    let netCashThisMonth: string | null = null;
    let creditOutstanding: string | null = null;
    let monthlyCashFlow: DashboardOverview['monthlyCashFlow'] = null;

    if (canSeeMoney) {
      // 🔴 [QA source review, 3246e9b] financeReport() เดือนปัจจุบันเคยถูกเรียก 2 ครั้ง (การ์ด netCash
      // + รอบใน last6Months) — ไม่ใช่สูตรผิด แต่ถ้ามีเงินเข้า/ออกระหว่าง 2 calls ตัวเลขอาจไม่ตรงกันเอง
      // ภายใน response เดียว ⇒ เรียกเดือนปัจจุบันครั้งเดียว (อยู่ใน months loop ด้านล่างนี้แหละ เพราะ
      // last6Months() คืนเดือนปัจจุบันเป็นตัวสุดท้ายอยู่แล้ว) แล้ว reuse ผลลัพธ์เดียวกันให้ทั้งการ์ดและกราฟ
      const startedAt = Date.now();
      const months = last6Months(today); // เก่า→ใหม่ — ตัวสุดท้ายคือเดือนปัจจุบันเสมอ
      const monthReports = await Promise.all(
        months.map(async ({ year, month }) => {
          const res = await financeReport(gangId, monthDateRange(year, month));
          if (!res.success) throw res.error;
          return { year, month, data: res.data };
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 1500) {
        console.warn(`[dashboardOverview] monthlyCashFlow (6x financeReport) ใช้เวลา ${elapsedMs}ms เกิน 1.5s`, { gangId, correlationId });
      }

      const currentMonth = monthReports[monthReports.length - 1];
      netCashThisMonth = currentMonth.data.report.netCash;

      // [planner G1] creditOutstanding ใช้ gate เดียวกับ canSeeMoney ด้านบนแล้ว (ครบ finance.view+
      // payment.verify+credit.read.other) — ไม่ใช่แค่ credit.read.other เดี่ยวๆเหมือนรอบก่อน
      creditOutstanding = await loadCreditOutstanding(db, gangId);

      // [WO-6.5c-DTO] แยก split ออกมาเป็น array ก่อน แล้วค่อยคำนวณ ratio จากทั้ง 6 เดือนรวมกัน
      // (cashFlowRatiosOf ต้องเห็นค่าทั้ง 6 เดือนพร้อมกันเพื่อหา max ร่วม — เรียกทีละเดือนไม่ได้)
      const monthlySplits = monthReports.map(({ year, month, data }) => ({
        year,
        month,
        split: splitCashFlow({
          transferIn: data.transferIn,
          refunds: data.refunds,
          overpaymentIn: data.report.overpaymentIn,
          otherIncome: data.report.otherIncome,
          expense: data.report.expense,
          memberPayouts: data.report.memberPayouts,
        }),
      }));
      const ratios = cashFlowRatiosOf(monthlySplits.map((m) => m.split));
      monthlyCashFlow = monthlySplits.map(({ year, month, split }, i) => ({
        month: `${year}-${String(month).padStart(2, '0')}`,
        ...split,
        ...ratios[i],
      }));
    }

    // 🔴 [planner G3] timeline ต้องแสดงได้ไม่เกินที่ RLS 0051:273-286 อนุญาต — แยก 2 แกน: event การเงิน
    // (payment.*/audit.credit_* — isFinanceEventType()) gate ด้วย gang.finance.view (ไม่ใช่ payment.verify
    // เหมือนรอบก่อน เพราะ RLS เปิดให้คนมี gang.finance.view เห็นได้แม้ไม่ใช่แอดมิน) ส่วน adminOnly อื่น
    // (line.*/gang.join_*/audit.role_* ฯลฯ — TS เข้มกว่า SQL โดยตั้งใจ ไม่ใช่สโคปที่แก้ในใบนี้) gate ด้วย
    // permission ที่ NEVER_DELEGABLE (gang.member.manage — เทียบเท่า is_gang_admin() ของ SQL โดยไม่ใช้ role===)
    // แยกคนละบรรทัดตั้งใจเหมือน pendingSlips ด้านบน — กัน manifest key (file:line) ชนกัน
    const canSeeFinanceForTimeline = can(ctx, 'gang.finance.view');
    const canSeeOtherAdminOnly = can(ctx, 'gang.member.manage');
    const recentActivity = await loadRecentActivity(db, gangId, canSeeFinanceForTimeline, canSeeOtherAdminOnly);

    return {
      nextSession,
      followingSession,
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
      viewerDisplayName,
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
 * นัดถัดไป/กำลังเล่น + นัดลำดับ 2 — "ใกล้ที่สุด (เริ่มวันนี้ หรือกำลังเล่นอยู่)" [planner]
 * กำลังเล่นมาก่อนเสมอ (เร่งด่วนกว่า) ไม่งั้นเอานัด open ที่ starts_at ใกล้ที่สุด **นับจากวันนี้เป็นต้นไป**
 * (ไม่ใช่นัด open ที่เก่าที่สุดเฉยๆ — นัดเก่าที่ค้างสถานะ open ไม่เคยถูกปิด ต้องไม่โผล่เป็น "นัดถัดไป")
 *
 * [WO-6.5c-DTO, planner] followingSession = นัดถัดไปจาก nextSession อีกทีด้วยตรรกะเดียวกัน — ถ้า
 * nextSession มาจาก in_play (กำลังเล่นอยู่) followingSession คือนัด open ตัวแรกที่ starts_at ใกล้สุด;
 * ถ้า nextSession มาจาก open ตัวแรกอยู่แล้ว followingSession คือนัด open ตัวที่สอง เพราะ in_play/open
 * เป็นคนละสถานะกันเสมอ query ทั้งสองจึงไม่มีทางได้แถวซ้ำกัน — query open ไว้ 2 แถว (`.limit(2)`) ครั้งเดียว
 * แทนที่จะ query ซ้ำสองรอบ
 */
async function loadNextAndFollowingSessions(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  gangId: string,
  todayStartUtc: string,
): Promise<{ next: DashboardNextSession | null; following: DashboardNextSession | null }> {
  // [fix] ต้องเป็น string literal ตรงๆ ใน .select(...) ไม่ใช่ตัวแปร — tests/postgrest/embeds.test.ts
  // สแกนด้วย regex หา .select('...') เป็น literal เท่านั้น ถ้าใช้ตัวแปรมันจะข้ามไปจับคู่ .from()
  // ตัวนี้กับ .select('...') literal ตัวถัดไปใน source ผิดตัว (เจอจริงจากเทสต์ 19/08) ⇒ ไม่ย่อด้วยตัวแปร
  //
  // 🔴 [QA source review, 3246e9b] ทุก query ต้องเช็ค error แล้ว throw — ห้ามปล่อยให้ query error
  // หลุดไปเป็น "ไม่มีข้อมูล" (คืน null/[]) เงียบๆ ซึ่งขัด CLAUDE.md §5 (fail loud ไม่ fail quiet)
  const { data: playing, error: playingError } = await db.from('sessions')
    .select('id, title, starts_at, ends_at, status, court_count, max_players, court_labels')
    .eq('gang_id', gangId).is('deleted_at', null).eq('status', 'in_play')
    .order('starts_at', { ascending: true }).limit(1).maybeSingle();
  if (playingError) throw playingError;

  // [WO-6.5c-DTO] limit(2) แทน limit(1).maybeSingle() เดิม — เอาไว้ทั้งนัดถัดไป (ถ้าไม่มี in_play)
  // และนัดลำดับ 2 (ถ้ามี in_play อยู่แล้ว) ในคำสั่งเดียว ไม่ query ซ้ำสองรอบ
  const { data: open, error: openError } = await db.from('sessions')
    .select('id, title, starts_at, ends_at, status, court_count, max_players, court_labels')
    .eq('gang_id', gangId).is('deleted_at', null).eq('status', 'open')
    .gte('starts_at', todayStartUtc)
    .order('starts_at', { ascending: true }).limit(2);
  if (openError) throw openError;
  const openRows = open ?? [];

  const nextRow = playing ?? openRows[0] ?? null;
  const followingRow = playing ? (openRows[0] ?? null) : (openRows[1] ?? null);

  const regsBySession = await loadRegistrationsBySessions(
    db,
    [nextRow, followingRow].filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.id as string),
  );

  return {
    next: nextRow ? buildSessionSummary(nextRow, regsBySession.get(nextRow.id as string) ?? []) : null,
    following: followingRow
      ? buildSessionSummary(followingRow, regsBySession.get(followingRow.id as string) ?? [])
      : null,
  };
}

/** [WO-6.5c-DTO] ดึง session_registrations ของหลาย session รวดเดียว (`.in()`) แทนที่จะ query ต่อ session
 *  — ใช้กับ nextSession/followingSession ที่ตอนนี้มีได้สูงสุด 2 แถว ไม่ query แยกทีละแถวแบบ N+1 */
async function loadRegistrationsBySessions(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  sessionIds: string[],
): Promise<Map<string, { status: string; user_id: string | null }[]>> {
  const map = new Map<string, { status: string; user_id: string | null }[]>();
  if (sessionIds.length === 0) return map;

  const { data: regs, error: regsError } = await db.from('session_registrations')
    .select('session_id, status, user_id')
    .in('session_id', sessionIds).is('deleted_at', null);
  if (regsError) throw regsError;

  for (const r of (regs ?? []) as { session_id: string; status: string; user_id: string | null }[]) {
    const list = map.get(r.session_id) ?? [];
    list.push({ status: r.status, user_id: r.user_id });
    map.set(r.session_id, list);
  }
  return map;
}

/** [WO-6.5c-DTO] แปลง sessions row ดิบ + registration rows ของมัน → DashboardNextSession เดียว
 *  — ตัดมาจาก logic เดิมของ loadNextSession() เพื่อใช้ร่วมกันทั้ง next/following */
function buildSessionSummary(
  row: Record<string, unknown>,
  regs: { status: string; user_id: string | null }[],
): DashboardNextSession {
  const seated = regs.filter((r) => isSeated(r.status));
  return {
    id: row.id as string,
    title: row.title as string,
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    status: row.status as string,
    courtCount: row.court_count as number,
    maxPlayers: row.max_players as number,
    courtLabels: parseCourtLabels(row.court_labels),
    seatedCount: seated.length,
    waitlistCount: regs.filter((r) => r.status === 'waitlist').length,
    guestCount: seated.filter((r) => r.user_id === null).length,
  };
}

/** [WO-6.5c-DTO] `sessions.court_labels` เป็น jsonb — ไม่มีการันตีรูปร่างที่ compile time ต้อง validate
 *  เองตอนอ่าน shape ที่ไม่ใช่ array ของ string ล้วน (ไม่ควรเกิดกับโค้ดเขียนปัจจุบัน แต่ jsonb แก้ตรงผ่าน
 *  DB ได้โดยไม่ผ่าน TS) ⇒ คืน array ว่าง ไม่ throw (ไม่ใช่ field สำคัญต่อการตัดสินใจทางธุรกิจ) */
function parseCourtLabels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** [WO-6.5c-DTO, planner] ชื่อที่แสดงของผู้ใช้ปัจจุบัน — ข้อมูลของตัวเอง ไม่ต้องเช็คสิทธิ์เพิ่ม ผ่าน `db`
 *  (RLS client เดิม ไม่ใช่ service-role) ทุกคนมีแถว `profiles` ของตัวเองแน่นอนจาก `handle_new_user`
 *  trigger ⇒ ถ้าไม่เจอ ถือเป็น INTERNAL_ERROR จริง ไม่ใช่คืนค่าว่างเงียบๆ (fail loud ตาม CLAUDE.md §5) */
async function loadViewerDisplayName(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  userId: string,
): Promise<string> {
  const { data, error } = await db.from('profiles').select('display_name').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('INTERNAL_ERROR', 'ไม่พบโปรไฟล์ของผู้ใช้ปัจจุบัน');
  return data.display_name as string;
}

/** นัดในเดือนนี้ (เวลาไทย) ที่ไม่ cancelled — ตัวหารของ "เฉลี่ยคน/นัด" [planner #3(ก)]
 *  🔴 [QA source review, 3246e9b] เดิม fetch ครั้งเดียวไม่แบ่งหน้า โดน PostgREST max_rows=1000 ตัดได้
 *  เหมือน credit_balances — ใช้ `allById()` เดิมตรงๆได้เลยเพราะ sessions มีคอลัมน์ `id` จริง (ต่างจาก
 *  credit_balances ที่ PK composite ไม่มี id) */
async function loadMonthSessions(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  gangId: string,
  range: ReturnType<typeof financeRange>,
): Promise<{ id: string }[]> {
  return allById<{ id: string }>((after) => {
    let q = db.from('sessions').select('id')
      .eq('gang_id', gangId).is('deleted_at', null).neq('status', 'cancelled')
      .gte('starts_at', range.startUtc).lt('starts_at', range.endUtcExclusive)
      .order('id').limit(ADMIN_READ_PAGE);
    if (after) q = q.gt('id', after);
    return q;
  });
}

/** เฉลี่ยคน/นัด — นับ "ลงชื่อแล้ว" ด้วย `isSeated()` เดียวกับ roster/console [planner #3(ก)] ไม่หารในนี้
 *  🔴 [QA source review, 3246e9b] แบ่งหน้าเหมือน loadMonthSessions ด้านบน — นัดเดือนเดียวกันมี
 *  registration รวมกันได้เกิน 1000 แถวง่ายกว่า sessions เองมาก (หลายคนต่อนัด × หลายนัด) */
async function attendeesOf(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  sessions: { id: string }[],
): Promise<{ totalSeated: number; sessionCount: number }> {
  if (sessions.length === 0) return { totalSeated: 0, sessionCount: 0 };
  const sessionIds = sessions.map((s) => s.id);
  const regs = await allById<{ id: string; status: string }>((after) => {
    let q = db.from('session_registrations').select('id, status')
      .in('session_id', sessionIds).is('deleted_at', null)
      .order('id').limit(ADMIN_READ_PAGE);
    if (after) q = q.gt('id', after);
    return q;
  });
  const totalSeated = regs.filter((r) => isSeated(r.status)).length;
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
 *
 * [planner G3] `canSeeFinance`/`canSeeOtherAdminOnly` ส่งต่อตรงเข้า `buildTimeline()`'s 2 แกน —
 * ดูเหตุผลที่ timeline.ts (RLS 0051:273-286)
 */
async function loadRecentActivity(
  db: Awaited<ReturnType<typeof supabaseServer>>,
  gangId: string,
  canSeeFinance: boolean,
  canSeeOtherAdminOnly: boolean,
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

  return buildTimeline(events, canSeeFinance, canSeeOtherAdminOnly);
}
