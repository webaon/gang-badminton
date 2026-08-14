/**
 * Phase 2.5 checkpoint — E2E ตาม `AGENT-EXECUTION.md`
 *
 *   ตารางประจำ generate นัด → QR check-in → แก้จำนวนลูกก่อนปิดรอบ →
 *   ปิดรอบด้วย `court_plus_shuttle` (มีเศษจริง) → **จ่ายแทนเพื่อน 1 สลิป 2 คน** →
 *   คืนเงินบางส่วน → ค่าสมาชิกรายเดือน (idempotent) → เตือนยอดค้างเฉพาะคนที่ค้างจริง
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ ขอบเขตเดียวกับ E2E ของ MVP-0: เดินผ่าน **DB functions + domain + server จริง**
 *    ไม่ใช่เบราว์เซอร์ (Playwright ยังอยู่ใน BACKLOG ตาม baseline Phase 5)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { calculateSessionCharges, type Participant } from '@/domain/billing/session-billing';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import { courtPlusShuttleFromJson, roundingFromJson } from '@/domain/policies/pricing';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import { ledgerLineOf } from '@/domain/billing/ledger';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { generateForTemplate } = await import('@/server/templates/generate');
const { billOneGang } = await import('@/server/membership/billing');
const { sendPaymentReminders } = await import('@/server/notifications/reminders');

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
    [`p25-${crypto.randomUUID()}@example.com`, name],
  );
  return row.id;
}

/** 13 ส.ค. 2026 = วันพฤหัสบดี 10:00 ตามเวลาไทย */
const NOW = new Date('2026-08-13T03:00:00Z');

describe('🎉 Phase 2.5 checkpoint — เส้นเต็มของ Phase นี้', () => {
  it('เดินครบทุกขั้นแล้วตัวเลขตรงทุกจุด', async () => {
    // ── 1. ก๊วน + แผนราคาค่าสนาม+ค่าลูก + ค่าสมาชิกรายเดือน ────────────────
    const owner = await signUp('เจ้าของก๊วน');
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วน E2E ${crypto.randomUUID()}`,
    ]);

    await pool.query(
      `update public.gangs
          set promptpay_id = '0812345678',
              settings = jsonb_build_object('reminder',
                jsonb_build_object('session_hours_before', 24, 'payment_due_after_hours', 1))
        where id = $1`,
      [gang.id],
    );

    const {
      rows: [plan],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_pricing_plans
         (gang_id, name, type, params, rounding_policy, monthly_member_pays_shuttle)
       values ($1, 'ค่าสนาม+ลูก', 'court_plus_shuttle',
               '{"court_fee_total": "800.00", "shuttle_price": "25.00"}'::jsonb,
               '{"mode": "ceil_baht", "surplus_to": "gang"}'::jsonb, true)
       returning id`,
      [gang.id],
    );

    await pool.query(
      `insert into public.gang_pricing_plans (gang_id, name, type, params)
       values ($1, 'ค่าสมาชิกรายเดือน', 'monthly', '{"monthly_fee": "1200.00"}'::jsonb)`,
      [gang.id],
    );

    // ── 2. ตารางประจำ → generate นัดล่วงหน้า (WO-2.5-E) ────────────────────
    const {
      rows: [template],
    } = await pool.query<{ id: string }>(
      `insert into public.session_templates
         (gang_id, name, recurrence, venue, court_count, max_players, pricing_plan_id, created_by)
       values ($1, 'ซ้อมพฤหัส',
               jsonb_build_object('days', '[4]'::jsonb, 'start_time', '19:00', 'end_time', '21:00'),
               'ยิมประจำ', 2, 8, $2, $3)
       returning id`,
      [gang.id, plan.id, owner],
    );

    const generated = await generateForTemplate({
      templateId: template.id,
      correlationId: crypto.randomUUID(),
      actorId: owner,
      now: NOW,
    });
    expect(generated!.created).toBeGreaterThan(0);

    // รันซ้ำต้องไม่ได้นัดเพิ่ม (idempotent)
    const again = await generateForTemplate({
      templateId: template.id,
      correlationId: crypto.randomUUID(),
      actorId: owner,
      now: NOW,
    });
    expect(again!.created).toBe(0);

    const {
      rows: [session],
    } = await pool.query<{ id: string; status: string; snapshot: Record<string, unknown> }>(
      `select id, status, snapshot from public.sessions
        where template_id = $1 order by starts_at limit 1`,
      [template.id],
    );

    // 🔴 นัดที่ generate ต้องเป็น draft และมี snapshot ครบ ไม่งั้นปิดรอบไม่ได้
    expect(session.status).toBe('draft');
    expect(session.snapshot).toHaveProperty('pricing_plan');
    expect(session.snapshot).toHaveProperty('rounding_policy');
    expect(session.snapshot).toHaveProperty('cancellation_policy');

    await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

    // ── 3. ผู้เล่น 4 คน (คนหนึ่งเป็นสมาชิกรายเดือน) ────────────────────────
    const players: { userId: string; registrationId: string; monthly: boolean }[] = [];
    for (let i = 0; i < 4; i++) {
      const monthly = i === 3;
      const userId = await signUp(`ผู้เล่น ${i + 1}`);

      await pool.query(
        `insert into public.gang_members
           (gang_id, user_id, role, is_monthly_member, monthly_member_since)
         values ($1, $2, 'member', $3, case when $3 then '2026-08-01'::date else null end)`,
        [gang.id, userId, monthly],
      );

      const {
        rows: [reg],
      } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
        session.id,
        userId,
      ]);

      players.push({ userId, registrationId: reg.id, monthly });
    }

    // ── 4. QR check-in (WO-2.5-F) ─────────────────────────────────────────
    const {
      rows: [issued],
    } = await pool.query<{ issue_checkin_token: string }>(
      `select public.issue_checkin_token($1, $2)`,
      [players[0].registrationId, owner],
    );

    const {
      rows: [scanned],
    } = await pool.query<{ status: string; already: boolean }>(
      `select * from public.check_in_by_token($1, $2, $3)`,
      [session.id, issued.issue_checkin_token, owner],
    );
    expect(scanned).toMatchObject({ status: 'checked_in', already: false });

    // สแกนซ้ำไม่เปลี่ยนอะไร
    const {
      rows: [rescan],
    } = await pool.query<{ already: boolean }>(
      `select * from public.check_in_by_token($1, $2, $3)`,
      [session.id, issued.issue_checkin_token, owner],
    );
    expect(rescan.already).toBe(true);

    // 🔴 QR ของนัดนี้ต้องใช้กับนัดอื่นไม่ได้
    const {
      rows: [otherSession],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'นัดอื่น', now(), now() + interval '2 hours', 4, '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [gang.id, owner],
    );
    await pool.query(`select public.transition_session($1, 'open', $2)`, [otherSession.id, owner]);
    await expect(
      pool.query(`select * from public.check_in_by_token($1, $2, $3)`, [
        otherSession.id,
        issued.issue_checkin_token,
        owner,
      ]),
    ).rejects.toThrow(/CHECKIN_TOKEN_INVALID/);

    // ── 5. เช็คอินที่เหลือรวดเดียว (WO-2.5-A) ──────────────────────────────
    const {
      rows: [{ check_in_all: bulk }],
    } = await pool.query<{ check_in_all: number }>(`select public.check_in_all($1, $2)`, [
      session.id,
      owner,
    ]);
    expect(bulk).toBe(3);

    await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

    // ── 6. ลงเกม แล้วแก้จำนวนลูกก่อนปิดรอบ (WO-2.5-A) ─────────────────────
    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at,
          shuttles_used, created_by)
       values ($1, 1, $2, $3, $4, $5, now() - interval '1 hour', now(), '3', $6)
       returning id`,
      [session.id, ...players.map((p) => p.registrationId), owner],
    );

    // กรอกผิดเป็น 3 ลูก จริงๆ ใช้ 6
    await pool.query(`select public.update_game_shuttles($1, $2, $3)`, [game.id, '6', owner]);

    // ── 7. ปิดรอบด้วย court_plus_shuttle (WO-2.5-B) ───────────────────────
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

    const { rows: games } = await pool.query<{ shuttles_used: string }>(
      `select shuttles_used from public.games where session_id = $1`,
      [session.id],
    );
    const shuttlesUsedTotal = fromSatang(
      sumSatang(games.map((g) => toSatang(String(g.shuttles_used)))),
    );
    expect(shuttlesUsedTotal).toBe('6.00');

    const participants: Participant[] = players.map((p) => ({
      registrationId: p.registrationId,
      status: 'checked_in',
      cancelledAt: null,
      isMonthlyMember: p.monthly,
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
      shuttlesUsedTotal,
    });

    // ค่าสนาม 800 หารคนที่ไม่ใช่รายเดือน 3 คน = 266.67 → ปัดขึ้น 267
    // ค่าลูก 150 หาร 4 คน = 37.50 → ปัดขึ้น 38
    // ⇒ ขาจร 305 · สมาชิกรายเดือน 38 · รวม 953 · ต้นทุน 950 ⇒ เศษ 3 บาท
    expect(billing.totalCollected).toBe('953.00');
    expect(billing.roundingSurplus).toBe('3.00');

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

    const { rows: charges } = await pool.query<{ id: string; registration_id: string; amount: string }>(
      `select id, registration_id, amount from public.session_charges
        where session_id = $1 and type = 'session'`,
      [session.id],
    );
    expect(charges).toHaveLength(4);

    const chargeOf = new Map(charges.map((c) => [c.registration_id, c]));

    // ── 8. จ่ายแทนเพื่อน: 1 สลิป 2 คน (WO-2.5-D) ──────────────────────────
    const payerCharge = chargeOf.get(players[0].registrationId)!;
    const friendCharge = chargeOf.get(players[1].registrationId)!;

    const {
      rows: [payment],
    } = await pool.query<{ id: string; amount: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [gang.id, players[0].userId, [payerCharge.id, friendCharge.id], players[0].userId],
    );
    expect(payment.amount).toBe('610.00');

    // กด "ขอ QR" ซ้ำต้องได้ใบเดิม
    const {
      rows: [duplicate],
    } = await pool.query<{ id: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [gang.id, players[0].userId, [payerCharge.id, friendCharge.id], players[0].userId],
    );
    expect(duplicate.id).toBe(payment.id);

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      players[0].userId,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [payment.id, owner]);

    const outstandingOf = async (chargeId: string) => {
      const {
        rows: [row],
      } = await pool.query<{ charge_outstanding: string }>(
        `select public.charge_outstanding($1)::text`,
        [chargeId],
      );
      return row.charge_outstanding;
    };

    // 🔴 สลิปใบเดียว ล้างหนี้ทั้งสองคน
    expect(await outstandingOf(payerCharge.id)).toBe('0.00');
    expect(await outstandingOf(friendCharge.id)).toBe('0.00');

    // ── 9. คืนเงินบางส่วน (WO-2.5-D) ──────────────────────────────────────
    await pool.query(`select public.add_payment_adjustment($1, 'refund', $2, $3, $4, $5)`, [
      friendCharge.id,
      '-100.00',
      'มาไม่ทันครึ่งแรก',
      payment.id,
      owner,
    ]);
    expect(await outstandingOf(friendCharge.id)).toBe('-100.00');

    // ledger ฝั่ง TypeScript ต้องได้ผลเดียวกับ SQL
    expect(
      ledgerLineOf({
        chargeId: friendCharge.id,
        amount: friendCharge.amount,
        allocated: ['305.00'],
        adjustments: ['-100.00'],
      }).outstanding,
    ).toBe('-100.00');

    // ── 10. ค่าสมาชิกรายเดือน (WO-2.5-C) ──────────────────────────────────
    const first = await billOneGang({
      gangId: gang.id,
      billingMonth: '2026-08-01',
      actorId: owner,
      correlationId: crypto.randomUUID(),
    });
    expect(first).toMatchObject({ created: 1, skipped: 0 });

    const repeat = await billOneGang({
      gangId: gang.id,
      billingMonth: '2026-08-01',
      actorId: owner,
      correlationId: crypto.randomUUID(),
    });
    expect(repeat).toMatchObject({ created: 0, skipped: 1 });

    // ── 11. เตือนยอดค้าง — เฉพาะคนที่ยังค้างจริง (WO-2.5-G) ───────────────
    await sendPaymentReminders(crypto.randomUUID(), new Date());

    const { rows: reminders } = await pool.query<{ recipient_id: string; payload: { charge_id: string } }>(
      `select recipient_id, payload from public.notifications
        where gang_id = $1 and event_type = 'payment.overdue'`,
      [gang.id],
    );

    const reminded = new Set(reminders.map((r) => r.recipient_id));

    // คนที่จ่ายแล้ว (และคนที่เพื่อนจ่ายแทน) ต้องไม่ถูกตามเก็บ
    expect(reminded.has(players[0].userId)).toBe(false);
    expect(reminded.has(players[1].userId)).toBe(false);
    // อีกสองคนยังค้างอยู่จริง
    expect(reminded.has(players[2].userId)).toBe(true);
    expect(reminded.has(players[3].userId)).toBe(true);

    // รันซ้ำไม่เตือนซ้ำ
    const createdAgain = await sendPaymentReminders(crypto.randomUUID(), new Date());
    expect(createdAgain).toBe(0);
  });
});
