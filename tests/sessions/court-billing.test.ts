/**
 * WO-2.5-B — `court_plus_shuttle` เดินได้จริงตั้งแต่แผนราคาถึง `session_charges`
 *
 * เทสต์ใน `tests/domain/court-plus-shuttle.test.ts` พิสูจน์ **สูตร**
 * ไฟล์นี้พิสูจน์ **เส้นทาง**: แผนราคา → snapshot → จำนวนลูกใน `games` →
 * `calculateSessionCharges()` → `close_session_with_charges()` → แถวจริงในฐานข้อมูล
 *
 * 🔴 ที่ต้องพิสูจน์เป็นพิเศษ: จำนวนลูก**ไม่ได้อยู่ใน snapshot** (อ่านจาก `games` ตอนปิดรอบ)
 *    ส่วนราคา**อยู่ใน snapshot** ⇒ ขึ้นราคาทีหลังต้องไม่กระทบนัดเก่า
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../helpers/db';
import { buildSnapshot } from '@/domain/sessions/snapshot';
import { fromJson as cancellationFromJson } from '@/domain/policies/cancellation';
import { courtPlusShuttleFromJson, roundingFromJson } from '@/domain/policies/pricing';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';
import {
  calculateSessionCharges,
  type Participant,
  type ParticipantStatus,
} from '@/domain/billing/session-billing';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`cps-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วน + แผนราคาแบบค่าสนาม+ค่าลูก + นัดที่ snapshot มาจากแผนนั้น */
async function courtSession(opts: {
  players: number;
  courtFeeTotal?: string;
  shuttlePrice?: string;
  mode?: string;
  monthlyMemberPaysShuttle?: boolean;
  monthlyPlayers?: number;
}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const {
    rows: [plan],
  } = await pool.query<{
    id: string;
    name: string;
    type: string;
    params: unknown;
    rounding_policy: unknown;
    monthly_member_pays_shuttle: boolean;
  }>(
    `insert into public.gang_pricing_plans
       (gang_id, name, type, params, rounding_policy, monthly_member_pays_shuttle)
     values ($1, 'ค่าสนาม+ลูก', 'court_plus_shuttle',
             jsonb_build_object('court_fee_total', $2::text, 'shuttle_price', $3::text),
             jsonb_build_object('mode', $4::text, 'surplus_to', 'gang'),
             $5)
     returning *`,
    [
      gang.id,
      opts.courtFeeTotal ?? '800.00',
      opts.shuttlePrice ?? '25.00',
      opts.mode ?? 'ceil_baht',
      opts.monthlyMemberPaysShuttle ?? true,
    ],
  );

  const {
    rows: [gangRow],
  } = await pool.query<{ cancellation_policy: unknown }>(
    `select cancellation_policy from public.gangs where id = $1`,
    [gang.id],
  );

  // ประกอบ snapshot แบบเดียวกับที่ `createSession()` ทำ
  const snapshot = buildSnapshot({
    pricingPlan: {
      id: plan.id,
      name: plan.name,
      type: 'court_plus_shuttle',
      courtPlusShuttle: courtPlusShuttleFromJson(plan.params),
    },
    monthlyMemberPaysShuttle: plan.monthly_member_pays_shuttle,
    roundingPolicy: roundingFromJson(plan.rounding_policy),
    promptpayId: null,
    cancellationPolicy: cancellationFromJson(gangRow.cancellation_policy),
    skillLevels: [],
  });

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, court_count, snapshot, created_by)
     values ($1, 'ค่าสนาม+ลูก', now() - interval '3 hours', now() - interval '1 hour',
             $2, 2, $3::jsonb, $4)
     returning id`,
    [gang.id, opts.players + 4, JSON.stringify(snapshot), owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const registrations: string[] = [];
  for (let i = 0; i < opts.players; i++) {
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role, is_monthly_member)
       values ($1, $2, 'member', $3)`,
      [gang.id, u, i < (opts.monthlyPlayers ?? 0)],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      u,
    ]);
    registrations.push(reg.id);
  }

  await pool.query(`select public.check_in_all($1, $2)`, [session.id, owner]);
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

  return { owner, gangId: gang.id, planId: plan.id, sessionId: session.id, registrations };
}

/**
 * บันทึกเกมที่จบแล้วพร้อมจำนวนลูก
 *
 * ⚠️ `games_distinct_players` บังคับว่าสี่ช่องต้องเป็นคนละคน ⇒ นัดที่จะมีเกมได้
 *    ต้องมีผู้เล่นอย่างน้อย 4 คน (ตรงกับความจริงของกีฬานี้)
 */
async function logGame(
  sessionId: string,
  registrations: string[],
  shuttles: string,
  courtNo: number,
  actor: string,
) {
  const slots = [0, 1, 2, 3].map((i) => registrations[i % registrations.length]);
  await pool.query(
    `insert into public.games
       (session_id, court_no, player1_registration_id, player2_registration_id,
        player3_registration_id, player4_registration_id, started_at, ended_at,
        shuttles_used, created_by)
     values ($1, $2, $3, $4, $5, $6, now() - interval '1 hour', now(), $7, $8)`,
    [sessionId, courtNo, ...slots, shuttles, actor],
  );
}

/** ทำแบบเดียวกับ `loadBillingContext()` ใน server action แล้วปิดรอบจริง */
async function closeWithCharges(ctx: {
  sessionId: string;
  owner: string;
  gangId: string;
}): Promise<{ total: string; surplus: string }> {
  const {
    rows: [session],
  } = await pool.query<{ starts_at: Date; status: string; snapshot: Record<string, never> }>(
    `select starts_at, status, snapshot from public.sessions where id = $1`,
    [ctx.sessionId],
  );

  const snapshot = session.snapshot as unknown as {
    pricing_plan: { type: string; params: unknown; monthly_member_pays_shuttle?: boolean };
    rounding_policy: unknown;
    cancellation_policy: unknown;
  };

  const { rows: regs } = await pool.query<{
    id: string;
    user_id: string | null;
    status: string;
    cancelled_at: Date | null;
    is_monthly_member: boolean | null;
  }>(
    `select r.id, r.user_id, r.status, r.cancelled_at, m.is_monthly_member
       from public.session_registrations r
       left join public.gang_members m
         on m.user_id = r.user_id and m.gang_id = $2 and m.deleted_at is null
      where r.session_id = $1 and r.deleted_at is null`,
    [ctx.sessionId, ctx.gangId],
  );

  const participants: Participant[] = regs.map((r) => ({
    registrationId: r.id,
    status: r.status as ParticipantStatus,
    cancelledAt: r.cancelled_at,
    isMonthlyMember: r.is_monthly_member === true,
  }));

  const { rows: games } = await pool.query<{ shuttles_used: string }>(
    `select shuttles_used from public.games where session_id = $1`,
    [ctx.sessionId],
  );

  const shuttlesUsedTotal = fromSatang(
    sumSatang(games.map((g) => toSatang(String(g.shuttles_used ?? '0')))),
  );

  const result = calculateSessionCharges({
    snapshot: {
      pricingType: snapshot.pricing_plan.type,
      amountPerPerson: '0',
      courtPlusShuttle: courtPlusShuttleFromJson(snapshot.pricing_plan.params),
      roundingPolicy: roundingFromJson(snapshot.rounding_policy),
      monthlyMemberPaysShuttle: snapshot.pricing_plan.monthly_member_pays_shuttle ?? true,
      cancellationPolicy: cancellationFromJson(snapshot.cancellation_policy),
    },
    participants,
    startsAt: session.starts_at,
    shuttlesUsedTotal,
  });

  await pool.query(
    `select public.close_session_with_charges($1, $2::jsonb, $3, 'billing', $4)`,
    [
      ctx.sessionId,
      JSON.stringify(
        result.charges.map((c) => ({
          registration_id: c.registrationId,
          amount: c.amount,
          breakdown: c.breakdown,
        })),
      ),
      session.status,
      ctx.owner,
    ],
  );

  return { total: result.totalCollected, surplus: result.roundingSurplus };
}

describe('WO-2.5-B — เส้นทางเต็มของ court_plus_shuttle', () => {
  it('🔴 7 คน · 800 + 25×6 = 950 หารไม่ลงตัว → เก็บ 959 · เศษ 9 บาทเข้าก๊วน', async () => {
    const ctx = await courtSession({ players: 7 });
    await logGame(ctx.sessionId, ctx.registrations, '2.5', 1, ctx.owner);
    await logGame(ctx.sessionId, ctx.registrations, '3.5', 2, ctx.owner);

    const { total, surplus } = await closeWithCharges(ctx);
    expect(total).toBe('959.00');
    expect(surplus).toBe('9.00');

    const { rows: charges } = await pool.query<{
      amount: string;
      breakdown: { court_fee: string; shuttle_fee: string; rounding_surplus: string };
    }>(
      `select amount, breakdown from public.session_charges
        where session_id = $1 and type = 'session' order by amount`,
      [ctx.sessionId],
    );

    expect(charges).toHaveLength(7);
    expect(charges.every((c) => c.amount === '137.00')).toBe(true);
    // ค่าสนาม 800/7 = 114.29 → ปัดขึ้นเป็นบาท 115 · ค่าลูก 150/7 = 21.43 → 22
    expect(charges[0].breakdown.court_fee).toBe('115.00');
    expect(charges[0].breakdown.shuttle_fee).toBe('22.00');

    // 🔴 เศษรายคนในฐานข้อมูลบวกกันได้ 9 บาทเป๊ะ — reconcile รายงานได้จริง
    const perCharge = charges.map((c) => toSatang(c.breakdown.rounding_surplus));
    expect(fromSatang(perCharge.reduce((a, b) => a + b, 0))).toBe('9.00');
  });

  it('ไม่มีเกมเลย (ไม่ได้ใช้ลูก) → เก็บเฉพาะค่าสนาม', async () => {
    const ctx = await courtSession({ players: 4, courtFeeTotal: '800.00' });

    const { total, surplus } = await closeWithCharges(ctx);
    expect(total).toBe('800.00');
    expect(surplus).toBe('0.00');
  });

  it('🔴 ขึ้นราคาค่าสนามหลังสร้างนัด → นัดนี้ยังคิดราคาเดิม (snapshot rule)', async () => {
    const ctx = await courtSession({ players: 4, courtFeeTotal: '800.00' });
    await logGame(ctx.sessionId, ctx.registrations, '4', 1, ctx.owner);

    await pool.query(
      `update public.gang_pricing_plans
          set params = jsonb_build_object('court_fee_total', '9999.00', 'shuttle_price', '999.00')
        where id = $1`,
      [ctx.planId],
    );

    // 800 + 25×4 = 900 หาร 4 = 225 ลงตัว
    const { total } = await closeWithCharges(ctx);
    expect(total).toBe('900.00');
  });

  it('สมาชิกรายเดือน: ค่าสนาม 0 · ค่าลูกคิดตามจริง', async () => {
    const ctx = await courtSession({
      players: 4,
      monthlyPlayers: 1,
      courtFeeTotal: '600.00',
      shuttlePrice: '25.00',
    });
    await logGame(ctx.sessionId, ctx.registrations, '4', 1, ctx.owner);

    await closeWithCharges(ctx);

    const { rows } = await pool.query<{
      amount: string;
      breakdown: { court_fee: string; is_monthly_member: boolean };
    }>(
      `select amount, breakdown from public.session_charges
        where session_id = $1 and type = 'session'`,
      [ctx.sessionId],
    );

    const monthly = rows.find((r) => r.breakdown.is_monthly_member)!;
    const normal = rows.find((r) => !r.breakdown.is_monthly_member)!;

    expect(monthly.breakdown.court_fee).toBe('0.00');
    // ค่าลูก 100 หาร 4 คน = 25 ลงตัว
    expect(monthly.amount).toBe('25.00');
    // ค่าสนาม 600 หารกับคนที่ไม่ใช่รายเดือน 3 คน = 200 + ค่าลูก 25
    expect(normal.amount).toBe('225.00');
  });

  it('โหมด absorb → เก็บน้อยกว่าต้นทุน ก๊วนรับส่วนต่างเอง', async () => {
    const ctx = await courtSession({ players: 7, courtFeeTotal: '800.00', mode: 'absorb' });
    await logGame(ctx.sessionId, ctx.registrations, '6', 1, ctx.owner);

    const { total, surplus } = await closeWithCharges(ctx);
    // ⚠️ `absorb` ปัดลงเป็น**สตางค์** ไม่ใช่บาท (ดู splitEvenly)
    //    ค่าสนาม 800/7 = 114.2857 → 114.28 · ค่าลูก 150/7 = 21.4285 → 21.42 ⇒ คนละ 135.70
    expect(total).toBe('949.90');
    expect(surplus).toBe('-0.10');
  });

  it('🔴 แก้จำนวนลูกก่อนปิดรอบ (WO-2.5-A) แล้วยอดเปลี่ยนตามจริง', async () => {
    const ctx = await courtSession({ players: 4, courtFeeTotal: '800.00' });
    await logGame(ctx.sessionId, ctx.registrations, '4', 1, ctx.owner);

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(`select id from public.games where session_id = $1`, [
      ctx.sessionId,
    ]);

    // กรอกผิดเป็น 4 ลูก จริงๆ ใช้ 8 ลูก
    await pool.query(`select public.update_game_shuttles($1, $2, $3)`, [game.id, '8', ctx.owner]);

    // 800 + 25×8 = 1000 หาร 4 = 250
    const { total } = await closeWithCharges(ctx);
    expect(total).toBe('1000.00');
  });
});
