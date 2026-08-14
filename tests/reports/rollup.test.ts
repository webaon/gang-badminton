/**
 * WO-3.A DoD — Rollup job
 *
 *   · 🔴 **idempotent** — รันซ้ำได้ผลเท่าเดิม ไม่ใช่ยอดสะสมทวีคูณ
 *   · ตัวเลขตรงกับข้อมูลดิบในเคสที่รู้คำตอบ
 *   · 🔴 `total_paid` นับจาก **ledger** (จ่ายจริงหลังหัก refund)
 *   · `daily_metrics.revenue` รวมนัดที่ยกเลิกกลางคัน (ไม่อิง `sessions.status`)
 *   · ก๊วนที่ปิด `features.statistics` ไม่ถูก rollup
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`ru-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

type Ctx = {
  owner: string;
  gangId: string;
  sessionId: string;
  players: { userId: string; memberId: string; registrationId: string }[];
};

/** ก๊วน + นัดที่เล่นจบแล้ว + ผู้เล่น n คนที่เช็คอิน */
async function playedSession(n: number, opts: { statistics?: boolean } = {}): Promise<Ctx> {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  if (opts.statistics === false) {
    await pool.query(
      `update public.gangs set features = features || '{"statistics": false}'::jsonb where id = $1`,
      [gang.id],
    );
  }

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'นัดที่เล่นจบ', now() - interval '2 hours', now() - interval '1 hour', $2,
             '{"snapshot_version":1}'::jsonb, $3)
     returning id`,
    [gang.id, n + 4, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const players: Ctx['players'] = [];
  for (let i = 0; i < n; i++) {
    const userId = await newUser();
    const {
      rows: [member],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
      [gang.id, userId],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      userId,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);

    players.push({ userId, memberId: member.id, registrationId: reg.id });
  }

  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

  return { owner, gangId: gang.id, sessionId: session.id, players };
}

async function statsOf(memberId: string) {
  const {
    rows: [row],
  } = await pool.query<{
    attended_count: number;
    games_count: number;
    shuttles_used: string;
    total_paid: string;
    attendance_rate: string;
  }>(
    `select attended_count, games_count, shuttles_used, total_paid, attendance_rate
       from public.member_statistics where gang_member_id = $1`,
    [memberId],
  );
  return row;
}

async function closeWithCharges(ctx: Ctx, amount = '200.00') {
  await pool.query(
    `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
    [
      ctx.sessionId,
      JSON.stringify(
        ctx.players.map((p) => ({
          registration_id: p.registrationId,
          amount,
          breakdown: { flat_rate: amount },
        })),
      ),
      ctx.owner,
    ],
  );

  const { rows } = await pool.query<{ id: string; registration_id: string }>(
    `select id, registration_id from public.session_charges where session_id = $1`,
    [ctx.sessionId],
  );
  return new Map(rows.map((r) => [r.registration_id, r.id]));
}

describe('WO-3.A DoD — member_statistics', () => {
  it('นับการมาเล่นและเกมได้ถูกต้อง · ลูกเป็นส่วนแบ่งของเกมที่ลง', async () => {
    const ctx = await playedSession(4);

    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at,
          shuttles_used, created_by)
       values ($1, 1, $2, $3, $4, $5, now() - interval '1 hour', now(), '6', $6)`,
      [ctx.sessionId, ...ctx.players.map((p) => p.registrationId), ctx.owner],
    );

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);

    const stats = await statsOf(ctx.players[0].memberId);
    expect(stats.attended_count).toBe(1);
    expect(stats.games_count).toBe(1);
    // 🔴 ส่วนแบ่ง: 6 ลูก / 4 คน = 1.5 ⇒ ผลรวมของทุกคนเท่ากับลูกจริงของก๊วน
    expect(Number(stats.shuttles_used)).toBe(1.5);
    expect(Number(stats.attendance_rate)).toBe(100);
  });

  it('🔴 รันซ้ำได้ผลเท่าเดิม (idempotent) ไม่ใช่ยอดสะสมทวีคูณ', async () => {
    const ctx = await playedSession(4);
    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at,
          shuttles_used, created_by)
       values ($1, 1, $2, $3, $4, $5, now() - interval '1 hour', now(), '4', $6)`,
      [ctx.sessionId, ...ctx.players.map((p) => p.registrationId), ctx.owner],
    );

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);
    const first = await statsOf(ctx.players[0].memberId);

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);
    const second = await statsOf(ctx.players[0].memberId);

    expect(second).toEqual(first);

    // และมีแถวเดียวต่อสมาชิกเสมอ
    const {
      rows: [{ count }],
    } = await pool.query<{ count: string }>(
      `select count(*)::text from public.member_statistics where gang_member_id = $1`,
      [ctx.players[0].memberId],
    );
    expect(Number(count)).toBe(1);
  });

  it('🔴 total_paid นับจาก ledger — สลิปที่ยังไม่ verified ยังไม่นับ', async () => {
    const ctx = await playedSession(2);
    const chargeOf = await closeWithCharges(ctx, '200.00');
    const chargeId = chargeOf.get(ctx.players[0].registrationId)!;

    const {
      rows: [payment],
    } = await pool.query<{ id: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [ctx.gangId, ctx.players[0].userId, [chargeId], ctx.players[0].userId],
    );

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);
    expect(Number((await statsOf(ctx.players[0].memberId)).total_paid)).toBe(0);

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      ctx.players[0].userId,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [
      payment.id,
      ctx.owner,
    ]);

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);
    expect(Number((await statsOf(ctx.players[0].memberId)).total_paid)).toBe(200);
  });

  it('🔴 คืนเงินแล้ว total_paid ลดลงตาม (เงินสดที่จ่ายจริงสุทธิ)', async () => {
    const ctx = await playedSession(2);
    const chargeOf = await closeWithCharges(ctx, '200.00');
    const chargeId = chargeOf.get(ctx.players[0].registrationId)!;

    const {
      rows: [payment],
    } = await pool.query<{ id: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [ctx.gangId, ctx.players[0].userId, [chargeId], ctx.players[0].userId],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      ctx.players[0].userId,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [
      payment.id,
      ctx.owner,
    ]);

    await pool.query(`select public.add_payment_adjustment($1, 'refund', $2, $3, $4, $5)`, [
      chargeId,
      '-50.00',
      'มาไม่ทันครึ่งหลัง',
      payment.id,
      ctx.owner,
    ]);

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);
    expect(Number((await statsOf(ctx.players[0].memberId)).total_paid)).toBe(150);
  });

  it('credit ไม่ใช่การเคลื่อนเงินสด ⇒ ไม่กระทบ total_paid', async () => {
    const ctx = await playedSession(2);
    const chargeOf = await closeWithCharges(ctx, '200.00');
    const chargeId = chargeOf.get(ctx.players[0].registrationId)!;

    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      chargeId,
      '-200.00',
      'ยกให้',
      ctx.owner,
    ]);

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);
    expect(Number((await statsOf(ctx.players[0].memberId)).total_paid)).toBe(0);
  });

  it('🔴 attendance_rate นับจากนัดที่เคยได้ที่ ไม่ใช่นัดทั้งหมดของก๊วน', async () => {
    const ctx = await playedSession(1);
    const player = ctx.players[0];

    // นัดที่สอง: ได้ที่แล้วไม่มา
    const {
      rows: [second],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'นัดสอง', now() - interval '1 day', now() - interval '1 day' + interval '2 hours',
               8, '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [ctx.gangId, ctx.owner],
    );
    await pool.query(`select public.transition_session($1, 'open', $2)`, [second.id, ctx.owner]);
    const {
      rows: [reg2],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      second.id,
      player.userId,
    ]);
    await pool.query(`select public.mark_no_show($1, $2)`, [reg2.id, ctx.owner]);

    // นัดที่สาม: ไม่ได้ลงชื่อเลย ⇒ ต้องไม่เข้าตัวหาร
    const {
      rows: [third],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'นัดสาม', now() - interval '2 days', now() - interval '2 days' + interval '2 hours',
               8, '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [ctx.gangId, ctx.owner],
    );
    await pool.query(`select public.transition_session($1, 'open', $2)`, [third.id, ctx.owner]);

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);

    const stats = await statsOf(player.memberId);
    expect(stats.attended_count).toBe(1);
    // มา 1 จาก 2 นัดที่ได้ที่ = 50% (ไม่ใช่ 33% จาก 3 นัดของก๊วน)
    expect(Number(stats.attendance_rate)).toBe(50);
  });

  it('สมาชิกที่ยังไม่เคยลงชื่อ → มีแถวสถิติที่เป็น 0 ทั้งหมด (ไม่ใช่ไม่มีแถว)', async () => {
    const ctx = await playedSession(1);

    const fresh = await newUser();
    const {
      rows: [member],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
      [ctx.gangId, fresh],
    );

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);

    const stats = await statsOf(member.id);
    expect(stats).toMatchObject({ attended_count: 0, games_count: 0 });
    expect(Number(stats.attendance_rate)).toBe(0);
  });

  it('🔴 ก๊วนที่ปิด features.statistics ไม่ถูก rollup', async () => {
    const ctx = await playedSession(2, { statistics: false });

    await pool.query(`select public.rollup_member_statistics($1)`, [ctx.gangId]);

    const {
      rows: [{ count }],
    } = await pool.query<{ count: string }>(
      `select count(*)::text from public.member_statistics where gang_id = $1`,
      [ctx.gangId],
    );
    expect(Number(count)).toBe(0);
  });
});

describe('WO-3.A DoD — daily_metrics', () => {
  const today = () =>
    pool
      .query<{ d: string }>(`select (now() at time zone 'Asia/Bangkok')::date::text as d`)
      .then((r) => r.rows[0].d);

  it('🔴 upsert ต่อวัน — รันซ้ำไม่สร้างแถวซ้ำและตัวเลขไม่ทวีคูณ', async () => {
    const date = await today();

    await pool.query(`select public.rollup_daily_metrics($1::date)`, [date]);
    const {
      rows: [first],
    } = await pool.query<{ revenue: string; games_played: number }>(
      `select revenue, games_played from public.daily_metrics where metric_date = $1`,
      [date],
    );

    await pool.query(`select public.rollup_daily_metrics($1::date)`, [date]);
    const { rows } = await pool.query<{ revenue: string }>(
      `select revenue from public.daily_metrics where metric_date = $1`,
      [date],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].revenue).toBe(first.revenue);
    expect(first.games_played).toBeGreaterThanOrEqual(0);
  });

  it('🔴 รายรับรวม charges ของนัดที่ยกเลิกกลางคัน (ไม่อิง sessions.status)', async () => {
    const date = await today();
    await pool.query(`select public.rollup_daily_metrics($1::date)`, [date]);
    const {
      rows: [before],
    } = await pool.query<{ revenue: string }>(
      `select revenue from public.daily_metrics where metric_date = $1`,
      [date],
    );

    // ยกเลิกกลางคันแต่เก็บเงินบางส่วน
    const ctx = await playedSession(2);
    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'cancelled', $3)`,
      [
        ctx.sessionId,
        JSON.stringify(
          ctx.players.map((p) => ({
            registration_id: p.registrationId,
            amount: '100.00',
            breakdown: { flat_rate: '200.00', midway_cancel_ratio: 0.5 },
          })),
        ),
        ctx.owner,
      ],
    );

    const {
      rows: [session],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      ctx.sessionId,
    ]);
    expect(session.status).toBe('cancelled');

    await pool.query(`select public.rollup_daily_metrics($1::date)`, [date]);
    const {
      rows: [after],
    } = await pool.query<{ revenue: string }>(
      `select revenue from public.daily_metrics where metric_date = $1`,
      [date],
    );

    expect(Number(after.revenue) - Number(before.revenue)).toBe(200);
  });

  it('นับนัดที่จัดในวันนั้น ไม่นับนัดที่ยังเป็นร่าง', async () => {
    const date = await today();
    await pool.query(`select public.rollup_daily_metrics($1::date)`, [date]);
    const {
      rows: [before],
    } = await pool.query<{ sessions_held: number }>(
      `select sessions_held from public.daily_metrics where metric_date = $1`,
      [date],
    );

    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วน-${crypto.randomUUID()}`,
    ]);
    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'ยังร่าง', now(), now() + interval '2 hours', 4, '{}'::jsonb, $2)`,
      [gang.id, owner],
    );

    await pool.query(`select public.rollup_daily_metrics($1::date)`, [date]);
    const {
      rows: [after],
    } = await pool.query<{ sessions_held: number }>(
      `select sessions_held from public.daily_metrics where metric_date = $1`,
      [date],
    );

    expect(after.sessions_held).toBe(before.sessions_held);
  });
});

describe('WO-3.A — run_rollup() (งานของ cron)', () => {
  it('ทำทั้งสองอย่างในรอบเดียว และรันซ้ำได้', async () => {
    const ctx = await playedSession(2);

    const {
      rows: [first],
    } = await pool.query<{ run_rollup: number }>(`select public.run_rollup()`);
    expect(first.run_rollup).toBeGreaterThan(0);

    const stats = await statsOf(ctx.players[0].memberId);
    expect(stats.attended_count).toBe(1);

    const {
      rows: [{ count }],
    } = await pool.query<{ count: string }>(
      `select count(*)::text from public.daily_metrics
        where metric_date = (now() at time zone 'Asia/Bangkok')::date`,
    );
    expect(Number(count)).toBe(1);

    await pool.query(`select public.run_rollup()`);
    expect(await statsOf(ctx.players[0].memberId)).toEqual(stats);
  });

  it('🔴 ผู้ใช้ที่ล็อกอินอยู่เรียกไม่ได้ (service_role เท่านั้น)', async () => {
    const { asRole } = await import('../helpers/db');
    const user = await newUser();

    await asRole('authenticated', user, async (c) => {
      await expect(c.query(`select public.run_rollup()`)).rejects.toThrow(/permission denied/i);
    });
  });
});
