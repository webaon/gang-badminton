/**
 * WO-2.5-A DoD — แก้ผลหลังจบเกม + no-show ที่เชื่อถือได้
 *
 *   · แก้จำนวนลูกได้เมื่อนัดอยู่ `in_play` · **แก้ไม่ได้หลัง `billing`** (raise ไม่ใช่เงียบ)
 *   · `mark_no_show()` เขียน `event_logs` และปฏิเสธ transition ที่ไม่อนุญาต
 *   · "เช็คอินทุกคนที่ได้ที่" แตะเฉพาะ `confirmed` ไม่ลาก waitlist ขึ้นมา
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
    [`cc-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** นัดที่เปิดรับ + สมาชิก n คนลงชื่อไว้ (เกินโควต้าจะตกไป waitlist ตามจริง) */
async function openSessionWith(n: number, maxPlayers = n) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, court_count, snapshot, created_by)
     values ($1, 'แก้ผล', now(), now() + interval '3 hours', $2, 2,
             '{"snapshot_version":1}'::jsonb, $3)
     returning id`,
    [gang.id, maxPlayers, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const registrations: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, u],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      u,
    ]);
    registrations.push(reg.id);
  }

  return { owner, gangId: gang.id, sessionId: session.id, registrations };
}

/** นัดที่กำลังเล่น + หนึ่งเกมที่จบแล้วพร้อมจำนวนลูก */
async function sessionWithFinishedGame(shuttles = '3') {
  const ctx = await openSessionWith(4);
  for (const id of ctx.registrations) {
    await pool.query(`select public.check_in_registration($1, $2)`, [id, ctx.owner]);
  }
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [
    ctx.sessionId,
    ctx.owner,
  ]);

  const {
    rows: [game],
  } = await pool.query<{ id: string }>(
    `insert into public.games
       (session_id, court_no, player1_registration_id, player2_registration_id,
        player3_registration_id, player4_registration_id, started_at, ended_at,
        shuttles_used, created_by)
     values ($1, 1, $2, $3, $4, $5, now() - interval '30 minutes', now(), $6, $7)
     returning id`,
    [ctx.sessionId, ...ctx.registrations, shuttles, ctx.owner],
  );

  return { ...ctx, gameId: game.id };
}

describe('WO-2.5-A DoD — แก้จำนวนลูกของเกมที่จบแล้ว', () => {
  it('แก้ได้เมื่อนัดยังอยู่ `in_play`', async () => {
    const { gameId, owner } = await sessionWithFinishedGame('3');

    const {
      rows: [game],
    } = await pool.query<{ shuttles_used: string }>(
      `select * from public.update_game_shuttles($1, $2, $3)`,
      [gameId, '4.5', owner],
    );

    expect(Number(game.shuttles_used)).toBe(4.5);
  });

  it('บันทึกค่าเดิมและค่าใหม่ลง event_logs (ตรวจย้อนหลังได้ว่าใครแก้อะไร)', async () => {
    const { gameId, owner } = await sessionWithFinishedGame('3');
    await pool.query(`select public.update_game_shuttles($1, $2, $3)`, [gameId, '7', owner]);

    const {
      rows: [event],
    } = await pool.query<{ actor_id: string; payload: { before: string; after: string } }>(
      `select actor_id, payload from public.event_logs
        where aggregate_id = $1 and event_type = 'game.shuttles_corrected'`,
      [gameId],
    );

    expect(event.actor_id).toBe(owner);
    expect(Number(event.payload.before)).toBe(3);
    expect(Number(event.payload.after)).toBe(7);
  });

  it('🔴 ปิดรอบไปแล้ว (`billing`) แก้ไม่ได้ — raise ไม่ใช่เงียบ', async () => {
    const { sessionId, gameId, owner } = await sessionWithFinishedGame('3');
    await pool.query(`select public.transition_session($1, 'billing', $2)`, [sessionId, owner]);

    await expect(
      pool.query(`select public.update_game_shuttles($1, $2, $3)`, [gameId, '99', owner]),
    ).rejects.toThrow(/INVALID_TRANSITION/);

    // 🔴 ต้องไม่ใช่ "raise แล้วแต่ข้อมูลเปลี่ยนไปแล้ว" — ค่าเดิมต้องอยู่ครบ
    const {
      rows: [game],
    } = await pool.query<{ shuttles_used: string }>(
      `select shuttles_used from public.games where id = $1`,
      [gameId],
    );
    expect(Number(game.shuttles_used)).toBe(3);
  });

  it('ค่าติดลบ → VALIDATION_ERROR · เกมที่ไม่มีอยู่ → NOT_FOUND', async () => {
    const { gameId, owner } = await sessionWithFinishedGame();

    await expect(
      pool.query(`select public.update_game_shuttles($1, $2, $3)`, [gameId, '-1', owner]),
    ).rejects.toThrow(/VALIDATION_ERROR/);

    await expect(
      pool.query(`select public.update_game_shuttles($1, $2, $3)`, [
        crypto.randomUUID(),
        '1',
        owner,
      ]),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('WO-2.5-A DoD — mark_no_show()', () => {
  it('confirmed → no_show และ checked_in → no_show ได้ พร้อม event', async () => {
    const { registrations, owner } = await openSessionWith(2);
    const [a, b] = registrations;
    await pool.query(`select public.check_in_registration($1, $2)`, [b, owner]);

    for (const id of [a, b]) {
      const {
        rows: [reg],
      } = await pool.query<{ status: string }>(`select * from public.mark_no_show($1, $2)`, [
        id,
        owner,
      ]);
      expect(reg.status).toBe('no_show');
    }

    const { rows: events } = await pool.query<{ payload: { from_status: string } }>(
      `select payload from public.event_logs
        where aggregate_id = any($1::uuid[]) and event_type = 'registration.no_show'
        order by created_at`,
      [[a, b]],
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.from_status).sort()).toEqual(['checked_in', 'confirmed']);
  });

  it('🔴 waitlist → no_show ไม่ได้ (ยังไม่เคยได้ที่ จะ "ไม่มา" ไม่ได้)', async () => {
    const { registrations, owner } = await openSessionWith(3, 2);
    const waitlisted = registrations[2];

    const {
      rows: [before],
    } = await pool.query<{ status: string }>(
      `select status from public.session_registrations where id = $1`,
      [waitlisted],
    );
    expect(before.status).toBe('waitlist');

    await expect(
      pool.query(`select public.mark_no_show($1, $2)`, [waitlisted, owner]),
    ).rejects.toThrow(/INVALID_REGISTRATION_TRANSITION/);
  });

  it('🔴 ยกเลิกไปแล้ว → mark no-show ซ้ำไม่ได้ (กันคิดเงินซ้อนสองเหตุผล)', async () => {
    const { registrations, owner } = await openSessionWith(2);
    const [a] = registrations;

    const {
      rows: [user],
    } = await pool.query<{ user_id: string }>(
      `select user_id from public.session_registrations where id = $1`,
      [a],
    );
    await pool.query(`select public.cancel_registration($1, $2)`, [a, user.user_id]);

    await expect(pool.query(`select public.mark_no_show($1, $2)`, [a, owner])).rejects.toThrow(
      /INVALID_REGISTRATION_TRANSITION/,
    );
  });

  it('registration ที่ไม่มีอยู่ → REGISTRATION_NOT_FOUND', async () => {
    await expect(
      pool.query(`select public.mark_no_show($1, null)`, [crypto.randomUUID()]),
    ).rejects.toThrow(/REGISTRATION_NOT_FOUND/);
  });
});

describe('WO-2.5-A DoD — เช็คอินทุกคนที่ได้ที่', () => {
  it('เช็คอินเฉพาะ confirmed · ไม่ลาก waitlist ขึ้นมา', async () => {
    const { sessionId, registrations, owner } = await openSessionWith(3, 2);

    const {
      rows: [{ check_in_all: count }],
    } = await pool.query<{ check_in_all: number }>(`select public.check_in_all($1, $2)`, [
      sessionId,
      owner,
    ]);
    expect(count).toBe(2);

    const { rows } = await pool.query<{ id: string; status: string }>(
      `select id, status from public.session_registrations where session_id = $1`,
      [sessionId],
    );
    const byId = new Map(rows.map((r) => [r.id, r.status]));

    expect(byId.get(registrations[0])).toBe('checked_in');
    expect(byId.get(registrations[1])).toBe('checked_in');
    // 🔴 waitlist ต้องไม่ถูกเช็คอิน — ไม่งั้นเท่ากับแอบให้ที่โดยไม่ผ่าน promote_waitlist()
    expect(byId.get(registrations[2])).toBe('waitlist');
  });

  it('กดซ้ำได้ ครั้งที่สองไม่มีใครเหลือให้เช็คอิน (0) ไม่ใช่ error', async () => {
    const { sessionId, owner } = await openSessionWith(2);

    await pool.query(`select public.check_in_all($1, $2)`, [sessionId, owner]);
    const {
      rows: [{ check_in_all: again }],
    } = await pool.query<{ check_in_all: number }>(`select public.check_in_all($1, $2)`, [
      sessionId,
      owner,
    ]);
    expect(again).toBe(0);
  });

  it('เขียน event เช็คอินรายคนเหมือนกดทีละคน (ประวัติไม่หาย)', async () => {
    const { sessionId, registrations, owner } = await openSessionWith(2);
    await pool.query(`select public.check_in_all($1, $2)`, [sessionId, owner]);

    const { rows } = await pool.query(
      `select 1 from public.event_logs
        where aggregate_id = any($1::uuid[]) and event_type = 'registration.checked_in'`,
      [registrations],
    );
    expect(rows).toHaveLength(2);
  });
});
