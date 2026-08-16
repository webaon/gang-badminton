/**
 * 🎉 Phase 3 checkpoint — E2E ตาม `AGENT-EXECUTION.md` (WO-3.F)
 *
 *   ปิดรอบจริง → **rollup** → **รายงาน reconcile ได้** → **ประกาศ publish (ไม่ส่งซ้ำ)** →
 *   **ค้นหาก๊วน + ขอเข้าก๊วน + อนุมัติ** → ตัวเลขหน้าแรกอ่านจาก `daily_metrics`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ ขอบเขตเดียวกับ E2E ของ MVP-0 / Phase 2.5: เดินผ่าน **DB functions + domain + server จริง**
 *    ไม่ใช่เบราว์เซอร์ (Playwright ยังอยู่ใน BACKLOG ตาม baseline Phase 5)
 *
 * ⚠️ เส้นเต็มของ MVP-0 (`mvp0-full-path.test.ts`) และ Phase 2.5 (`phase25-full-path.test.ts`)
 *    ต้องยังผ่านด้วย — อยู่ใน `npm test` ชุดเดียวกัน
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { calculateSessionCharges, type Participant } from '@/domain/billing/session-billing';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import { courtPlusShuttleFromJson, roundingFromJson } from '@/domain/policies/pricing';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { calculateFinanceReport, assertReportReconciles, type ReportCharge } from '@/domain/reports/finance';
import { hasHighlights } from '@/domain/reports/platform';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { platformHighlights } = await import('@/server/landing/metrics');

afterAll(async () => {
  await pool.end();
});

async function signUp(name: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), $1, jsonb_build_object('display_name', $2::text))
     returning id`,
    [`p3-${crypto.randomUUID()}@example.com`, name],
  );
  return row.id;
}

describe('🎉 Phase 3 checkpoint — เส้นเต็มของ Phase นี้', () => {
  it('ปิดรอบ → rollup → รายงาน → ประกาศ → discovery ครบเส้น ตัวเลขตรงทุกจุด', async () => {
    // ── 1. ก๊วนที่เปิดให้ค้นหา + แผนค่าสนาม+ค่าลูก ─────────────────────────
    const owner = await signUp('เจ้าของก๊วน');
    const marker = `บ้านสวน${crypto.randomUUID().slice(0, 8)}`;

    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วน${marker}`,
    ]);

    await pool.query(
      `update public.gangs
          set is_public   = true,
              area        = 'ลาดพร้าว กรุงเทพ',
              promptpay_id = '0812345678',
              features    = features || '{"discovery": true, "statistics": true}'::jsonb
        where id = $1`,
      [gang.id],
    );

    const {
      rows: [plan],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_pricing_plans
         (gang_id, name, type, params, rounding_policy)
       values ($1, 'ค่าสนาม+ลูก', 'court_plus_shuttle',
               '{"court_fee_total": "800.00", "shuttle_price": "25.00"}'::jsonb,
               '{"mode": "ceil_baht", "surplus_to": "gang"}'::jsonb)
       returning id`,
      [gang.id],
    );

    // ── 2. นัด + ผู้เล่น 4 คน (เจ้าของ + สมาชิก 3) ────────────────────────
    const {
      rows: [session],
    } = await pool.query<{ id: string; starts_at: Date }>(
      `insert into public.sessions
         (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
       values ($1, 'ซ้อมประจำสัปดาห์', now() + interval '1 hour', now() + interval '3 hours',
               8, 'draft', $2::jsonb, $3)
       returning id, starts_at`,
      [
        gang.id,
        JSON.stringify({
          snapshot_version: 1,
          pricing_plan: {
            id: plan.id,
            type: 'court_plus_shuttle',
            params: { court_fee_total: '800.00', shuttle_price: '25.00' },
            monthly_member_pays_shuttle: true,
          },
          rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
          cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true },
          promptpay_id: '0812345678',
        }),
        owner,
      ],
    );

    await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

    const players: { userId: string; registrationId: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const userId = i === 0 ? owner : await signUp(`ผู้เล่น ${i}`);

      if (i > 0) {
        await pool.query(
          `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
          [gang.id, userId],
        );
      }

      const {
        rows: [reg],
      } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
        session.id,
        userId,
      ]);

      players.push({ userId, registrationId: reg.id });
    }

    const {
      rows: [{ check_in_all: checkedIn }],
    } = await pool.query<{ check_in_all: number }>(`select public.check_in_all($1, $2)`, [
      session.id,
      owner,
    ]);
    expect(checkedIn).toBe(4);

    await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

    // เกมเดียว 4 คน ใช้ลูก 6 ลูก — ตั้ง started_at ให้ตรงวันของนัด (rollup นับตามนาฬิกาไทย)
    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at,
          shuttles_used, created_by)
       values ($1, 1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '30 minutes', '6', $7)`,
      [session.id, ...players.map((p) => p.registrationId), session.starts_at, owner],
    );

    // ── 3. ปิดรอบ (ADR-001: domain คิด → DB function commit) ──────────────
    const {
      rows: [current],
    } = await pool.query<{
      status: string;
      starts_at: Date;
      snapshot: {
        pricing_plan: { type: string; params: unknown; monthly_member_pays_shuttle: boolean };
        rounding_policy: unknown;
        cancellation_policy: unknown;
      };
    }>(`select status, starts_at, snapshot from public.sessions where id = $1`, [session.id]);

    const participants: Participant[] = players.map((p) => ({
      registrationId: p.registrationId,
      status: 'checked_in',
      cancelledAt: null,
      isMonthlyMember: false,
    }));

    const billing = calculateSessionCharges({
      snapshot: {
        pricingType: current.snapshot.pricing_plan.type,
        amountPerPerson: '0',
        courtPlusShuttle: courtPlusShuttleFromJson(current.snapshot.pricing_plan.params),
        roundingPolicy: roundingFromJson(current.snapshot.rounding_policy),
        monthlyMemberPaysShuttle: current.snapshot.pricing_plan.monthly_member_pays_shuttle,
        cancellationPolicy: policyFromJson(current.snapshot.cancellation_policy),
      },
      participants,
      startsAt: current.starts_at,
      shuttlesUsedTotal: '6.00',
    });

    // ค่าสนาม 800 ÷ 4 = 200 ลงตัว · ค่าลูก 6 × 25 = 150 ÷ 4 = 37.50 → ปัดขึ้น 38
    // ⇒ คนละ 238 · รวม 952 · ต้นทุนจริง 950 ⇒ เศษเข้าก๊วน 2 บาท
    expect(billing.totalCollected).toBe('952.00');
    expect(billing.roundingSurplus).toBe('2.00');

    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, $3, 'billing', $4)`,
      [
        session.id,
        JSON.stringify(
          billing.charges.map((c) => ({
            registration_id: c.registrationId,
            amount: c.amount,
            breakdown: c.breakdown,
          })),
        ),
        current.status,
        owner,
      ],
    );

    // ── 4. คนหนึ่งจ่ายจริง (ที่เหลือค้าง) ─────────────────────────────────
    const { rows: charges } = await pool.query<{ id: string; registration_id: string }>(
      `select id, registration_id from public.session_charges
        where session_id = $1 and type = 'session'`,
      [session.id],
    );
    expect(charges).toHaveLength(4);

    const payerCharge = charges.find((c) => c.registration_id === players[0].registrationId)!;

    const {
      rows: [payment],
    } = await pool.query<{ id: string; amount: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [gang.id, players[0].userId, [payerCharge.id], players[0].userId],
    );
    expect(payment.amount).toBe('238.00');

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      players[0].userId,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [payment.id, owner]);

    // เงินนอกบิลของก๊วน (WO-3.B)
    await pool.query(
      `insert into public.gang_expenses (gang_id, session_id, category, amount, occurred_on, created_by)
       values ($1, $2, 'court', '500.00', (now() at time zone 'Asia/Bangkok')::date, $3)`,
      [gang.id, session.id, owner],
    );
    await pool.query(
      `insert into public.gang_incomes (gang_id, category, amount, occurred_on, created_by)
       values ($1, 'sponsor', '100.00', (now() at time zone 'Asia/Bangkok')::date, $2)`,
      [gang.id, owner],
    );

    // ── 5. รายงานของก๊วน — reconcile ได้ (WO-3.B DoD) ─────────────────────
    const { rows: chargeRows } = await pool.query<{
      id: string;
      amount: string;
      breakdown: { rounding_surplus?: string };
      allocated: string[] | null;
      adjustments: string[] | null;
      refunds: string[] | null;
    }>(
      `select c.id, c.amount::text, c.breakdown,
              (select array_agg(a.amount::text)
                 from public.payment_allocations a
                 join public.payments p on p.id = a.payment_id
                where a.session_charge_id = c.id and p.status = 'verified') as allocated,
              (select array_agg(adj.amount::text)
                 from public.payment_adjustments adj
                where adj.session_charge_id = c.id) as adjustments,
              (select array_agg(adj.amount::text)
                 from public.payment_adjustments adj
                where adj.session_charge_id = c.id and adj.type = 'refund') as refunds
         from public.session_charges c
        where c.gang_id = $1`,
      [gang.id],
    );

    const reportCharges: ReportCharge[] = chargeRows.map((c) => ({
      chargeId: c.id,
      amount: c.amount,
      allocated: c.allocated ?? [],
      adjustments: c.adjustments ?? [],
      refunds: c.refunds ?? [],
      roundingSurplus: c.breakdown?.rounding_surplus ?? '0.00',
    }));

    const report = calculateFinanceReport({
      charges: reportCharges,
      otherIncomes: ['100.00'],
      expenses: ['500.00'],
    });

    expect(report.charged).toBe('952.00');
    expect(report.collected).toBe('238.00'); // 🔴 เก็บได้จริง ≠ เรียกเก็บ
    expect(report.outstanding).toBe('714.00');
    expect(report.roundingSurplus).toBe('2.00');
    expect(report.netCash).toBe('-162.00'); // 238 + 100 − 500

    // 🔴 invariant ของ baseline §Verification: เรียกเก็บ − ต้นทุนจริง = เศษ
    const actualCost = fromSatang(toSatang(report.charged) - toSatang(report.roundingSurplus));
    expect(actualCost).toBe('950.00');
    expect(() => assertReportReconciles(report, actualCost)).not.toThrow();

    // ── 6. Rollup (WO-3.A) — สถิติสมาชิก + ตัวเลขรายวัน ──────────────────
    const {
      rows: [dates],
    } = await pool.query<{ session_date: string; today: string }>(
      `select (s.starts_at at time zone 'Asia/Bangkok')::date::text as session_date,
              (now() at time zone 'Asia/Bangkok')::date::text        as today
         from public.sessions s where s.id = $1`,
      [session.id],
    );

    await pool.query(`select public.run_rollup($1::date)`, [dates.session_date]);
    if (dates.today !== dates.session_date) {
      await pool.query(`select public.rollup_daily_metrics($1::date)`, [dates.today]);
    }

    const { rows: stats } = await pool.query<{
      user_id: string;
      attended_count: number;
      games_count: number;
      shuttles_used: string;
      total_paid: string;
    }>(
      `select m.user_id, s.attended_count, s.games_count,
              s.shuttles_used::text, s.total_paid::text
         from public.member_statistics s
         join public.gang_members m on m.id = s.gang_member_id
        where s.gang_id = $1`,
      [gang.id],
    );

    expect(stats).toHaveLength(4);
    expect(stats.every((s) => s.attended_count === 1 && s.games_count === 1)).toBe(true);
    // ลูกที่ใช้ = ส่วนแบ่งของเกมที่ลง (6 ÷ 4 = 1.5 คน) — ผลรวมทุกคนต้องเท่ากับลูกจริง
    expect(fromSatang(sumSatang(stats.map((s) => toSatang(s.shuttles_used))))).toBe('6.00');

    const payerStat = stats.find((s) => s.user_id === players[0].userId)!;
    expect(payerStat.total_paid).toBe('238.00'); // 🔴 มาจาก ledger ไม่ใช่ผลรวม charges
    expect(
      stats.filter((s) => s.user_id !== players[0].userId).every((s) => s.total_paid === '0.00'),
    ).toBe(true);

    const {
      rows: [metrics],
    } = await pool.query<{ sessions_held: number; games_played: number; revenue: string }>(
      `select sessions_held, games_played, revenue::text
         from public.daily_metrics where metric_date = $1::date`,
      [dates.session_date],
    );
    expect(metrics.sessions_held).toBeGreaterThanOrEqual(1);
    expect(metrics.games_played).toBeGreaterThanOrEqual(1);

    const {
      rows: [revenueRow],
    } = await pool.query<{ revenue: string }>(
      `select revenue::text from public.daily_metrics where metric_date = $1::date`,
      [dates.today],
    );
    expect(toSatang(revenueRow.revenue)).toBeGreaterThanOrEqual(toSatang('952.00'));

    // ── 7. ตัวเลขหน้าแรกอ่านจาก daily_metrics (WO-3.F DoD) ───────────────
    const highlights = await platformHighlights();
    expect(highlights).not.toBeNull();
    expect(hasHighlights(highlights!)).toBe(true);
    expect(highlights!.sessionsHeld).toBeGreaterThanOrEqual(1);
    expect(highlights!.gamesPlayed).toBeGreaterThanOrEqual(1);

    // ── 8. ประกาศ (WO-3.D) — publish ครั้งเดียว ยิงเตือนครั้งเดียว ───────
    const {
      rows: [announcement],
    } = await pool.query<{ id: string }>(
      `insert into public.announcements (gang_id, title, body, created_by)
       values ($1, 'ปิดรอบแล้ว โอนเงินด้วยนะ', 'ยอดของแต่ละคนดูในหน้าเก็บเงิน', $2)
       returning id`,
      [gang.id, owner],
    );

    const {
      rows: [published],
    } = await pool.query<{ published_at: string }>(
      `select published_at from public.publish_announcement($1, $2)`,
      [announcement.id, owner],
    );

    const announcementNotifications = async () => {
      const {
        rows: [row],
      } = await pool.query<{ n: string }>(
        `select count(*)::text n from public.notifications
          where gang_id = $1 and event_type = 'announcement.published'`,
        [gang.id],
      );
      return Number(row.n);
    };

    expect(await announcementNotifications()).toBe(4);

    const {
      rows: [republished],
    } = await pool.query<{ published_at: string }>(
      `select published_at from public.publish_announcement($1, $2)`,
      [announcement.id, owner],
    );

    // 🔴 กดซ้ำ: เวลาไม่เลื่อน และไม่มีใครโดนยิงซ้ำ
    expect(republished.published_at).toEqual(published.published_at);
    expect(await announcementNotifications()).toBe(4);

    // ── 9. Discovery + join request (WO-3.E) ─────────────────────────────
    const newcomer = await signUp('คนใหม่');

    const found = await pool.query<{ id: string; member_count: number; viewer_status: string | null }>(
      `select id, member_count, viewer_status from public.search_public_gangs($1, 20, $2)`,
      [marker, newcomer],
    );
    const hit = found.rows.find((r) => r.id === gang.id)!;
    expect(hit).toBeDefined();
    expect(hit.member_count).toBe(4);
    expect(hit.viewer_status).toBeNull();

    const {
      rows: [joinRequest],
    } = await pool.query<{ id: string; status: string }>(
      `select id, status from public.request_to_join_gang($1, $2, $3)`,
      [gang.id, newcomer, 'ขอเข้าก๊วนด้วยคนครับ'],
    );
    expect(joinRequest.status).toBe('pending');

    // แอดมินได้รับแจ้งเตือน
    const {
      rows: [adminNotice],
    } = await pool.query<{ recipient_id: string }>(
      `select recipient_id from public.notifications
        where gang_id = $1 and event_type = 'gang.join_requested'`,
      [gang.id],
    );
    expect(adminNotice.recipient_id).toBe(owner);

    const {
      rows: [decided],
    } = await pool.query<{ status: string }>(
      `select status from public.decide_join_request($1, $2, 'approved', $3)`,
      [joinRequest.id, gang.id, owner],
    );
    expect(decided.status).toBe('approved');

    const afterJoin = await pool.query<{ id: string; member_count: number; viewer_status: string | null }>(
      `select id, member_count, viewer_status from public.search_public_gangs($1, 20, $2)`,
      [marker, newcomer],
    );
    const joined = afterJoin.rows.find((r) => r.id === gang.id)!;
    expect(joined.member_count).toBe(5);
    expect(joined.viewer_status).toBe('member');

    // 🔴 ก๊วนนี้ปิด discovery เมื่อไหร่ ต้องหายจากผลค้นหาทันที
    await pool.query(
      `update public.gangs set features = features || '{"discovery": false}'::jsonb where id = $1`,
      [gang.id],
    );
    const afterOptOut = await pool.query<{ id: string }>(
      `select id from public.search_public_gangs($1, 20, null)`,
      [marker],
    );
    expect(afterOptOut.rows.some((r) => r.id === gang.id)).toBe(false);
  });
});
