/**
 * WO-2.7 DoD — Game Console
 *
 *   · เช็คอินได้เฉพาะจาก `confirmed` (❌ waitlist → checked_in ตรง)
 *   · `games` เก็บผู้เล่นเป็น `registration_id` ⇒ guest ลงเกมได้
 *   · `shuttles_used` เป็นทศนิยมได้
 *   · แอดมินสลับตัวแล้วผลถูกเก็บ ไม่ถูก engine เขียนทับ
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
    [`gc-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** นัดที่เปิดรับ + สมาชิก n คนลงชื่อไว้แล้ว */
async function sessionWithPlayers(n: number, courtCount = 2) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  // ระดับฝีมือ 3 ระดับ
  await pool.query(
    `insert into public.gang_skill_levels (gang_id, label, rank)
     values ($1, 'ใหม่', 1), ($1, 'กลาง', 2), ($1, 'หนัก', 3)`,
    [gang.id],
  );
  const { rows: levels } = await pool.query<{ id: string; rank: number }>(
    `select id, rank from public.gang_skill_levels where gang_id = $1 order by rank`,
    [gang.id],
  );

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, court_count, allow_guests, snapshot, created_by)
     values ($1, 'วันเล่น', now(), now() + interval '3 hours', $2, $3, true, '{"snapshot_version":1}'::jsonb, $4)
     returning id`,
    [gang.id, n + 4, courtCount, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const registrations: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role, skill_level_id)
       values ($1, $2, 'member', $3)`,
      [gang.id, u, levels[i % levels.length].id],
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

async function checkInAll(registrations: string[], actorId: string) {
  for (const id of registrations) {
    await pool.query(`select public.check_in_registration($1, $2)`, [id, actorId]);
  }
}

describe('WO-2.7 — เช็คอิน', () => {
  it('🔴 waitlist → checked_in ตรงๆ ไม่ได้ ต้อง promote ก่อน', async () => {
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
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'เล็ก', now(), now() + interval '2 hours', 1, '{}'::jsonb, $2) returning id`,
      [gang.id, owner],
    );
    await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

    const a = await newUser();
    const b = await newUser();
    for (const u of [a, b]) {
      await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1,$2,'member')`, [
        gang.id,
        u,
      ]);
      await pool.query(`select public.register_to_session($1, $2)`, [session.id, u]);
    }

    const {
      rows: [waiting],
    } = await pool.query<{ id: string }>(
      `select id from public.session_registrations
        where session_id = $1 and status = 'waitlist'`,
      [session.id],
    );

    await expect(
      pool.query(`select public.check_in_registration($1, $2)`, [waiting.id, owner]),
    ).rejects.toThrow(/INVALID_REGISTRATION_TRANSITION/);
  });

  it('confirmed → checked_in ได้ และเข้าคิว console', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(4);
    await checkInAll(registrations, owner);

    const { rows } = await pool.query(`select * from public.session_console_queue($1)`, [sessionId]);
    expect(rows).toHaveLength(4);
  });
});

describe('WO-2.7 — คิวของ console', () => {
  it('คนที่ยังไม่เช็คอินไม่อยู่ในคิว', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(6);
    await checkInAll(registrations.slice(0, 4), owner);

    const { rows } = await pool.query(`select * from public.session_console_queue($1)`, [sessionId]);
    expect(rows).toHaveLength(4);
  });

  it('ยังไม่เคยเล่น → games_played = 0 และ waiting_since = เวลาเช็คอิน', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(4);
    await checkInAll(registrations, owner);

    const { rows } = await pool.query<{ games_played: number; waiting_since: Date }>(
      `select games_played, waiting_since from public.session_console_queue($1)`,
      [sessionId],
    );
    expect(rows.every((r) => Number(r.games_played) === 0)).toBe(true);
    expect(rows.every((r) => r.waiting_since !== null)).toBe(true);
  });

  it('เล่นแล้ว → นับเกมถูก และรู้ว่าใครกำลังอยู่ในคอร์ท', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(4);
    await checkInAll(registrations, owner);

    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now())`,
      [sessionId, ...registrations],
    );

    const { rows } = await pool.query<{
      games_played: number;
      current_game_id: string | null;
    }>(`select games_played, current_game_id from public.session_console_queue($1)`, [sessionId]);

    expect(rows.every((r) => Number(r.games_played) === 1)).toBe(true);
    expect(rows.every((r) => r.current_game_id !== null)).toBe(true);
  });

  it('เกมจบแล้ว → ไม่นับว่าอยู่ในคอร์ท แต่ยังนับจำนวนเกม', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(4);
    await checkInAll(registrations, owner);

    await pool.query(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at, ended_at)
       values ($1, 1, $2, $3, $4, $5, now() - interval '20 minutes', now())`,
      [sessionId, ...registrations],
    );

    const { rows } = await pool.query<{ games_played: number; current_game_id: string | null }>(
      `select games_played, current_game_id from public.session_console_queue($1)`,
      [sessionId],
    );

    expect(rows.every((r) => Number(r.games_played) === 1)).toBe(true);
    expect(rows.every((r) => r.current_game_id === null)).toBe(true);
  });
});

describe('WO-2.7 — games เก็บ registration_id ⇒ guest ลงเกมได้', () => {
  it('guest ที่เช็คอินแล้วลงเกมได้เหมือนสมาชิก', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(3);

    // guest หนึ่งคนผ่านลิงก์เชิญ
    const {
      rows: [invite],
    } = await pool.query<{ token: string }>(
      `select token from public.create_session_invite($1, null, 5, $2)`,
      [sessionId, owner],
    );
    const {
      rows: [guest],
    } = await pool.query<{ registration_id: string }>(
      `select registration_id from public.register_guest($1, $2, null, $3)`,
      [sessionId, 'แขกวันเล่น', invite.token],
    );

    const all = [...registrations, guest.registration_id];
    await checkInAll(all, owner);

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...all],
    );

    expect(game.id).toBeDefined();

    const { rows } = await pool.query(`select * from public.session_console_queue($1)`, [sessionId]);
    expect(rows).toHaveLength(4);
  });
});

describe('WO-2.7 — shuttles_used เป็นทศนิยมได้', () => {
  it('บันทึก 1.5 ลูกได้ (แบ่งลูกกัน)', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(4);
    await checkInAll(registrations, owner);

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...registrations],
    );

    await pool.query(`update public.games set shuttles_used = 1.5, ended_at = now() where id = $1`, [
      game.id,
    ]);

    const {
      rows: [row],
    } = await pool.query<{ shuttles_used: string }>(
      `select shuttles_used from public.games where id = $1`,
      [game.id],
    );
    expect(Number(row.shuttles_used)).toBe(1.5);
  });

  it('ติดลบไม่ได้ (CHECK ในสคีมา)', async () => {
    const { sessionId, registrations } = await sessionWithPlayers(4);
    await expect(
      pool.query(
        `insert into public.games
           (session_id, court_no, player1_registration_id, player2_registration_id,
            player3_registration_id, player4_registration_id, shuttles_used)
         values ($1, 1, $2, $3, $4, $5, -1)`,
        [sessionId, ...registrations],
      ),
    ).rejects.toThrow(/shuttles_used/);
  });
});

describe('WO-2.7 — แอดมินสลับตัว (override ผลของ engine)', () => {
  it('เอาคนที่นั่งพักเข้าแทนคนในคอร์ท', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(5);
    await checkInAll(registrations, owner);

    const playing = registrations.slice(0, 4);
    const benched = registrations[4];

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...playing],
    );

    await pool.query(`select public.substitute_game_player($1, 2, $2, $3)`, [
      game.id,
      benched,
      owner,
    ]);

    const {
      rows: [after],
    } = await pool.query<{ p2: string }>(
      `select player2_registration_id as p2 from public.games where id = $1`,
      [game.id],
    );
    expect(after.p2).toBe(benched);
  });

  it('🔴 เอาคนจากอีกคอร์ทมา → สลับที่กัน ไม่มีใครซ้ำสองคอร์ท', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(8);
    await checkInAll(registrations, owner);

    const {
      rows: [gameA],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...registrations.slice(0, 4)],
    );
    const {
      rows: [gameB],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 2, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...registrations.slice(4, 8)],
    );

    const fromA = registrations[0];
    const fromB = registrations[5];

    await pool.query(`select public.substitute_game_player($1, 1, $2, $3)`, [
      gameA.id,
      fromB,
      owner,
    ]);

    const { rows } = await pool.query<{ id: string; players: string[] }>(
      `select id, array[player1_registration_id, player2_registration_id,
                        player3_registration_id, player4_registration_id] as players
         from public.games where id in ($1, $2)`,
      [gameA.id, gameB.id],
    );

    const a = rows.find((r) => r.id === gameA.id)!.players;
    const b = rows.find((r) => r.id === gameB.id)!.players;

    expect(a).toContain(fromB);
    expect(b).toContain(fromA);
    expect(a).not.toContain(fromA);
    expect(b).not.toContain(fromB);

    // ไม่มีใครอยู่สองคอร์ทพร้อมกัน
    expect(new Set([...a, ...b]).size).toBe(8);
  });

  it('คนที่ยังไม่เช็คอินลงสนามไม่ได้', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(5);
    await checkInAll(registrations.slice(0, 4), owner);

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...registrations.slice(0, 4)],
    );

    await expect(
      pool.query(`select public.substitute_game_player($1, 1, $2, $3)`, [
        game.id,
        registrations[4], // ยังไม่เช็คอิน
        owner,
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('slot นอกช่วง 1-4 → VALIDATION_ERROR', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(4);
    await checkInAll(registrations, owner);

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...registrations],
    );

    await expect(
      pool.query(`select public.substitute_game_player($1, 9, $2, $3)`, [
        game.id,
        registrations[0],
        owner,
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('บันทึก event ทุกครั้งที่สลับตัว (ตามรอยได้)', async () => {
    const { sessionId, registrations, owner } = await sessionWithPlayers(5);
    await checkInAll(registrations, owner);

    const {
      rows: [game],
    } = await pool.query<{ id: string }>(
      `insert into public.games
         (session_id, court_no, player1_registration_id, player2_registration_id,
          player3_registration_id, player4_registration_id, started_at)
       values ($1, 1, $2, $3, $4, $5, now()) returning id`,
      [sessionId, ...registrations.slice(0, 4)],
    );

    await pool.query(`select public.substitute_game_player($1, 3, $2, $3)`, [
      game.id,
      registrations[4],
      owner,
    ]);

    const { rows } = await pool.query(
      `select 1 from public.event_logs
        where session_id = $1 and event_type = 'game.player_substituted'`,
      [sessionId],
    );
    expect(rows).toHaveLength(1);
  });
});
