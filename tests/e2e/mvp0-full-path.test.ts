/**
 * MVP-0 checkpoint — E2E เส้นเต็มตาม baseline §Verification
 *
 *   สมัคร → สร้างก๊วน → ตั้งราคา+policy → สร้างนัด → ลงชื่อจนเต็ม + guest ผ่าน
 *   invite link + waitlist → ยกเลิกหลัง cutoff เห็น penalty → เช็คอิน →
 *   จัดคู่+นับลูก → ปิดรอบ → ยอด+QR ถูกต้อง (ตรวจ surplus) → verify →
 *   รายงาน + timeline + in-app notification
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **ขอบเขตของเทสต์นี้**
 *
 * baseline เขียนว่า E2E ใช้ **Playwright** แต่ Playwright setup อยู่ใน Phase 5
 * (ยังอยู่ใน BACKLOG) ⇒ เทสต์นี้เดินเส้นเดียวกันผ่าน **DB functions + domain จริง**
 * ซึ่งเป็นชั้นที่ correctness อยู่ — ครอบทุกอย่างยกเว้นการคลิกบนเบราว์เซอร์
 *
 * สิ่งที่เทสต์นี้ **ไม่** ครอบ: การ render, การกดปุ่ม, การอัปโหลดไฟล์จริง
 * ⇒ ยังต้องมี Playwright ใน Phase 5 ตามที่ baseline กำหนด
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, visibleCount, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { calculateSessionCharges, type Participant } from '@/domain/billing/session-billing';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import { flatRateFromJson } from '@/domain/policies/pricing';
import { planMatches } from '@/domain/matching/pipeline';
import { teamsOf } from '@/domain/matching/pipeline';
import { promptPayPayload } from '@/lib/promptpay/qr';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { buildSnapshot } from '@/domain/sessions/snapshot';
import { zonedTimeToUtc } from '@/domain/time/timezone';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { dispatchNotifications } = await import('@/server/cron/notifications');

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
    [`${crypto.randomUUID()}@example.com`, name],
  );
  return row.id;
}

describe('🎉 MVP-0 checkpoint — เส้นเต็มตาม baseline', () => {
  it('เดินครบทุกขั้นแล้วตัวเลขตรงทุกจุด', async () => {
    // ── 1. สมัคร ────────────────────────────────────────────────────────────
    const owner = await signUp('ต้น หัวก๊วน');

    // trigger สร้าง profile ให้อัตโนมัติ (WO-2.2)
    const {
      rows: [profile],
    } = await pool.query<{ display_name: string }>(
      `select display_name from public.profiles where id = $1`,
      [owner],
    );
    expect(profile.display_name).toBe('ต้น หัวก๊วน');

    // ── 2. สร้างก๊วน (auto-create org, atomic) ──────────────────────────────
    const {
      rows: [gang],
    } = await pool.query<{ id: string; org_id: string }>(
      `select * from public.create_gang($1, $2, null, 'ลาดพร้าว')`,
      [owner, 'ก๊วนแบด E2E'],
    );

    const {
      rows: [ownerRoles],
    } = await pool.query<{ org: string; gang: string }>(
      `select
         (select count(*) from public.organization_members
           where org_id = $1 and user_id = $2 and role = 'owner')::text org,
         (select count(*) from public.gang_members
           where gang_id = $3 and user_id = $2 and role = 'owner')::text gang`,
      [gang.org_id, owner, gang.id],
    );
    expect([ownerRoles.org, ownerRoles.gang]).toEqual(['1', '1']);

    // ── 3. ตั้งราคา + policy + PromptPay ────────────────────────────────────
    await pool.query(`update public.gangs set promptpay_id = '0812345678' where id = $1`, [
      gang.id,
    ]);
    await pool.query(
      `insert into public.gang_pricing_plans (gang_id, name, type, params)
       values ($1, 'เหมาจ่ายต่อหัว', 'flat_rate', '{"amount_per_person": "200.00"}'::jsonb)`,
      [gang.id],
    );
    await pool.query(
      `insert into public.gang_skill_levels (gang_id, label, rank)
       values ($1, 'มือใหม่', 1), ($1, 'มือกลาง', 2)`,
      [gang.id],
    );

    // สมาชิก 5 คน
    const members: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await signUp(`สมาชิก ${i + 1}`);
      await pool.query(
        `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
        [gang.id, u],
      );
      members.push(u);
    }

    // ── 4. สร้างนัด พร้อม snapshot ที่แช่แข็งราคา ────────────────────────────
    const {
      rows: [gangRow],
    } = await pool.query<{
      timezone: string;
      promptpay_id: string;
      cancellation_policy: unknown;
    }>(`select timezone, promptpay_id, cancellation_policy from public.gangs where id = $1`, [
      gang.id,
    ]);

    const {
      rows: [plan],
    } = await pool.query<{ id: string; name: string; type: string; params: unknown }>(
      `select id, name, type, params from public.gang_pricing_plans where gang_id = $1`,
      [gang.id],
    );

    const { rows: skills } = await pool.query<{ label: string; rank: number }>(
      `select label, rank from public.gang_skill_levels where gang_id = $1 order by rank`,
      [gang.id],
    );

    const snapshot = buildSnapshot({
      pricingPlan: {
        id: plan.id,
        name: plan.name,
        type: 'flat_rate',
        flatRate: flatRateFromJson(plan.params),
      },
      roundingPolicy: { mode: 'ceil_baht', surplusTo: 'gang' },
      promptpayId: gangRow.promptpay_id,
      cancellationPolicy: policyFromJson(gangRow.cancellation_policy),
      skillLevels: skills,
    });

    // นัดเริ่ม "เมื่อวาน" เพื่อให้การยกเลิกวันนี้เลย cutoff แน่นอน
    const startsAt = zonedTimeToUtc('2026-08-01T19:00', gangRow.timezone);

    const {
      rows: [session],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions
         (gang_id, title, venue, starts_at, ends_at, max_players, court_count, allow_guests,
          snapshot, created_by)
       values ($1, 'ซ้อมวันศุกร์', 'สนามลาดพร้าว', $2, $3, 4, 1, true, $4::jsonb, $5)
       returning id`,
      [
        gang.id,
        startsAt.toISOString(),
        new Date(startsAt.getTime() + 2 * 3600_000).toISOString(),
        JSON.stringify(snapshot),
        owner,
      ],
    );

    // 🔴 นัดใหม่ต้องเป็น draft เสมอ แล้วเปิดผ่าน state machine
    const {
      rows: [draft],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      session.id,
    ]);
    expect(draft.status).toBe('draft');

    await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

    // ── 5. ลงชื่อจนเต็ม (max 4) + guest ผ่าน invite link + waitlist ─────────
    const regs: string[] = [];
    for (const u of [owner, ...members.slice(0, 3)]) {
      const {
        rows: [r],
      } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
        session.id,
        u,
      ]);
      regs.push(r.id);
    }

    const {
      rows: [invite],
    } = await pool.query<{ token: string }>(
      `select token from public.create_session_invite($1, null, 5, $2)`,
      [session.id, owner],
    );

    const {
      rows: [guest],
    } = await pool.query<{ registration_id: string; status: string; guest_token: string }>(
      `select * from public.register_guest($1, $2, null, $3)`,
      [session.id, 'แขกของต้น', invite.token],
    );

    // เต็มแล้ว ⇒ guest เข้าคิวรอ
    expect(guest.status).toBe('waitlist');

    // ── 6. ยกเลิกหลัง cutoff → เห็น penalty + คิวเลื่อนอัตโนมัติ ─────────────
    const lateCanceller = regs[3];
    await pool.query(`select public.cancel_registration($1, $2)`, [lateCanceller, members[2]]);

    const {
      rows: [cancelEvent],
    } = await pool.query<{ payload: { is_late_cancel: boolean } }>(
      `select payload from public.event_logs
        where session_id = $1 and event_type = 'registration.cancelled'`,
      [session.id],
    );
    expect(cancelEvent.payload.is_late_cancel, 'ต้องถูกบันทึกว่ายกเลิกช้า').toBe(true);

    // guest ถูกเลื่อนขึ้นแทนอัตโนมัติ (อยู่ใน cancel_registration)
    const {
      rows: [guestAfter],
    } = await pool.query<{ status: string }>(
      `select status from public.session_registrations where id = $1`,
      [guest.registration_id],
    );
    expect(guestAfter.status).toBe('confirmed');

    // ── 7. เช็คอิน ──────────────────────────────────────────────────────────
    const { rows: confirmed } = await pool.query<{ id: string }>(
      `select id from public.session_registrations
        where session_id = $1 and status = 'confirmed' and deleted_at is null`,
      [session.id],
    );
    expect(confirmed).toHaveLength(4);

    for (const r of confirmed) {
      await pool.query(`select public.check_in_registration($1, $2)`, [r.id, owner]);
    }

    await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

    // ── 8. จัดคู่ผ่าน Matching Engine + นับลูก ──────────────────────────────
    const { rows: queue } = await pool.query<{
      registration_id: string;
      skill_rank: number | null;
      games_played: number;
      waiting_since: string;
    }>(`select * from public.session_console_queue($1)`, [session.id]);

    expect(queue).toHaveLength(4);

    const matchPlan = planMatches({
      players: queue.map((q) => ({
        registrationId: q.registration_id,
        skillRank: q.skill_rank,
        gamesPlayed: Number(q.games_played),
        waitingSince: new Date(q.waiting_since).getTime(),
      })),
      availableCourts: 1,
    });

    expect(matchPlan.games).toHaveLength(1);

    const planned = matchPlan.games[0];
    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, $2, $3, $4, $5, $6, now()) returning id`,
      [session.id, planned.courtNo, ...planned.players],
    );

    // ทีมตาม ADR-003 — เรียงตามที่ engine คืนมา ไม่เรียงใหม่
    const { teamA, teamB } = teamsOf(planned.players);
    expect(new Set([...teamA, ...teamB]).size).toBe(4);

    // นับลูก (ทศนิยมได้)
    await pool.query(
      `update public.games set shuttles_used = 2.5, ended_at = now() where id = $1`,
      [game.id],
    );

    // ── 9. ปิดรอบ → charges ────────────────────────────────────────────────
    const { rows: allRegs } = await pool.query<{
      id: string;
      status: string;
      cancelled_at: string | null;
    }>(
      `select id, status, cancelled_at from public.session_registrations
        where session_id = $1 and deleted_at is null`,
      [session.id],
    );

    const participants: Participant[] = allRegs.map((r) => ({
      registrationId: r.id,
      status: r.status as Participant['status'],
      cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : null,
      isMonthlyMember: false,
    }));

    const billing = calculateSessionCharges({
      snapshot: {
        pricingType: 'flat_rate',
        amountPerPerson: '200.00',
        cancellationPolicy: policyFromJson(gangRow.cancellation_policy),
      },
      participants,
      startsAt,
    });

    // 4 คนที่เล่น + 1 คนยกเลิกช้า = 5 คนต้องจ่าย (penalty = full_share)
    expect(billing.charges).toHaveLength(5);
    expect(billing.totalCollected).toBe('1000.00');

    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
      [
        session.id,
        JSON.stringify(
          billing.charges.map((c) => ({
            registration_id: c.registrationId,
            amount: c.amount,
            breakdown: c.breakdown,
          })),
        ),
        owner,
      ],
    );

    // ── 10. ยอด + QR + surplus ─────────────────────────────────────────────
    const { rows: charges } = await pool.query<{
      amount: string;
      breakdown: Record<string, string>;
    }>(`select amount, breakdown from public.session_charges where session_id = $1`, [session.id]);

    expect(charges).toHaveLength(5);

    const dbTotal = sumSatang(charges.map((c) => toSatang(c.amount)));
    expect(fromSatang(dbTotal)).toBe('1000.00');

    // surplus ตรวจ reconcile ได้จาก breakdown (flat_rate ไม่มีการหาร ⇒ 0)
    expect(charges.every((c) => c.breakdown.rounding_surplus === '0.00')).toBe(true);

    // QR ยอดตรงกับที่เรียกเก็บ
    const payload = promptPayPayload(snapshot.promptpay_id!, '200.00');
    expect(payload).toContain('200.00');

    // ── 11. จ่ายเงิน → verify ───────────────────────────────────────────────
    const { rows: myCharges } = await pool.query<{ id: string }>(
      `select sc.id from public.session_charges sc
         join public.session_registrations r on r.id = sc.registration_id
        where sc.session_id = $1 and r.user_id = $2`,
      [session.id, owner],
    );

    const {
      rows: [payment],
    } = await pool.query<{ id: string; amount: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $2)`,
      [gang.id, owner, myCharges.map((c) => c.id)],
    );
    expect(payment.amount).toBe('200.00');

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [payment.id, owner]);
    const {
      rows: [verified],
    } = await pool.query<{ status: string }>(
      `select * from public.transition_payment($1, 'verified', $2)`,
      [payment.id, owner],
    );
    expect(verified.status).toBe('verified');

    // ── 12. in-app notification ────────────────────────────────────────────
    await pool.query(
      `update public.notifications set next_retry_at = now() + interval '10 years'
        where status = 'pending' and gang_id <> $1`,
      [gang.id],
    );
    await pool.query(`select public.enqueue_session_notification($1, 'payment.due', 'charged')`, [
      session.id,
    ]);

    const dispatched = await dispatchNotifications('e2e');
    expect(dispatched.sent).toBeGreaterThan(0);

    const { rows: notified } = await pool.query<{ status: string; event_type: string }>(
      `select status, event_type from public.notifications where gang_id = $1`,
      [gang.id],
    );
    expect(notified.some((n) => n.event_type === 'payment.due' && n.status === 'sent')).toBe(true);
    // "คิวถึง" จากตอน guest ถูกเลื่อน — guest ไม่มีบัญชี จึงไม่มีแถวนี้ (ตั้งใจ)

    // ── 13. timeline (event_logs) ครบทุกขั้น ───────────────────────────────
    const { rows: events } = await pool.query<{ event_type: string }>(
      `select distinct event_type from public.event_logs where gang_id = $1`,
      [gang.id],
    );
    const types = events.map((e) => e.event_type);

    for (const expected of [
      'gang.created',
      'session.transitioned',
      'registration.confirmed',
      'registration.waitlisted',
      'registration.cancelled',
      'waitlist.promoted',
      'registration.checked_in',
      'session.closed_with_charges',
      'payment.transitioned',
      'session.invite_created',
    ]) {
      expect(types, `timeline ขาด ${expected}`).toContain(expected);
    }

    // ── 14. สิทธิ์ยังแน่นหลังจบทุกอย่าง ────────────────────────────────────
    const outsider = await signUp('คนนอก');
    expect(await visibleCount(outsider, 'select 1 from public.gangs where id = $1', [gang.id])).toBe(
      0,
    );
    expect(
      await visibleCount(outsider, 'select 1 from public.sessions where id = $1', [session.id]),
    ).toBe(0);
    expect(
      await visibleCount(outsider, 'select 1 from public.payments where id = $1', [payment.id]),
    ).toBe(0);
  });
});
