/**
 * DoD ข้อ 2 — "cancel พร้อมกัน 2 คน → promote ไม่ซ้ำคน ไม่ข้ามคิว"
 *
 * จุดที่พังง่ายถ้าทำผิด: cancel_registration() เรียก promote_waitlist() ในตัว
 * ⇒ ถ้าสอง transaction ยกเลิกพร้อมกันแล้วไม่ได้ serialize ที่แถว session
 *   ทั้งคู่จะเห็น "ที่ว่าง 1 ที่" เท่ากัน แล้วเลื่อน **คนเดียวกัน** ขึ้นมาสองรอบ
 *   (หรือเลื่อนสองคนทั้งที่มีที่ว่างที่เดียว = overbook ทางอ้อม)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  createFixture,
  createUser,
  addGangMember,
  countByStatus,
  registrationsOf,
  runConcurrently,
  reloadPostgrestSchema,
} from '../helpers/db';

describe('DoD 2 — promote_waitlist ไม่ซ้ำคน ไม่ข้ามคิว', () => {
  beforeAll(async () => {
    await reloadPostgrestSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('2a. cancel 2 คนพร้อมกัน → เลื่อนหัวคิว 2 คนแรกพอดี ไม่ซ้ำ ไม่ข้าม', async () => {
    const owner = await createUser('owner-2a');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 2 });

    const names = ['A', 'B', 'C', 'D', 'E'];
    const users: Record<string, string> = {};
    for (const n of names) {
      const u = await createUser(`user-2a-${n}`);
      await addGangMember(fx.gangId, u);
      users[n] = u;
      await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
    }

    // A,B = confirmed · C,D,E = waitlist ordering 1,2,3
    const before = await registrationsOf(fx.sessionId);
    const regOf = (n: string) => before.find((r) => r.user_id === users[n])!;
    expect(regOf('A').status).toBe('confirmed');
    expect(regOf('B').status).toBe('confirmed');
    expect(regOf('C').ordering).toBe(1);
    expect(regOf('D').ordering).toBe(2);
    expect(regOf('E').ordering).toBe(3);

    // 🔴 ยกเลิกพร้อมกัน — ทั้งสอง transaction จะพยายาม promote พร้อมกัน
    const results = await runConcurrently(2, (client, i) =>
      client.query('select public.cancel_registration($1)', [
        i === 0 ? regOf('A').id : regOf('B').id,
      ]),
    );
    expect(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results)).toBe(true);

    const after = await registrationsOf(fx.sessionId);
    const statusOf = (n: string) => after.find((r) => r.user_id === users[n])!.status;

    expect(statusOf('A')).toBe('cancelled');
    expect(statusOf('B')).toBe('cancelled');
    // ไม่ข้ามคิว: C กับ D ได้ขึ้น, E ยังรอ
    expect(statusOf('C')).toBe('confirmed');
    expect(statusOf('D')).toBe('confirmed');
    expect(statusOf('E')).toBe('waitlist');

    const counts = await countByStatus(fx.sessionId);
    expect(counts.confirmed).toBe(2); // ไม่เกิน max_players
    expect(counts.cancelled).toBe(2);
    expect(counts.waitlist).toBe(1);

    // ไม่ซ้ำคน: event promote ต้องมี 2 ใบ ต่อ registration คนละคน
    const { rows: events } = await pool.query<{ aggregate_id: string }>(
      `select aggregate_id from public.event_logs
        where session_id = $1 and event_type = 'waitlist.promoted'`,
      [fx.sessionId],
    );
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.aggregate_id)).size).toBe(2);
  });

  it('2b. ยกเลิกคนใน waitlist ไม่ทำให้เกิดการเลื่อนคิว (ไม่มีที่ว่างใหม่)', async () => {
    const owner = await createUser('owner-2b');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 1 });

    const a = await createUser('user-2b-A');
    const b = await createUser('user-2b-B');
    const c = await createUser('user-2b-C');
    for (const u of [a, b, c]) {
      await addGangMember(fx.gangId, u);
      await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
    }

    const rows = await registrationsOf(fx.sessionId);
    const bReg = rows.find((r) => r.user_id === b)!;
    expect(bReg.status).toBe('waitlist');

    await pool.query('select public.cancel_registration($1)', [bReg.id]);

    const after = await registrationsOf(fx.sessionId);
    expect(after.find((r) => r.user_id === a)!.status).toBe('confirmed');
    expect(after.find((r) => r.user_id === b)!.status).toBe('cancelled');
    // C ต้องยังรออยู่ — ที่นั่งไม่ได้ว่างเพิ่มเพราะ B ไม่เคยถือที่
    expect(after.find((r) => r.user_id === c)!.status).toBe('waitlist');

    const { rows: events } = await pool.query(
      `select 1 from public.event_logs where session_id = $1 and event_type = 'waitlist.promoted'`,
      [fx.sessionId],
    );
    expect(events).toHaveLength(0);
  });

  it('2c. [D-8] ordering เท่ากัน → reliability สูงกว่าได้ขึ้นก่อน', async () => {
    const owner = await createUser('owner-2c');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 1 });

    const holder = await createUser('user-2c-holder');
    const good = await createUser('user-2c-good'); // ประวัติ: มาเล่นจริง
    const bad = await createUser('user-2c-bad'); // ประวัติ: ไม่มาโดยไม่บอก
    for (const u of [holder, good, bad]) await addGangMember(fx.gangId, u);

    // ---- สร้างประวัติในนัดเก่าของก๊วนเดียวกัน ----
    const {
      rows: [past],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, status, snapshot)
       values ($1, 'นัดเก่า', now() - interval '7 days', now() - interval '7 days' + interval '2 hours',
               10, 'settled', $2::jsonb)
       returning id`,
      [
        fx.gangId,
        JSON.stringify({
          snapshot_version: 1,
          cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true },
        }),
      ],
    );
    await pool.query(
      `insert into public.session_registrations (session_id, user_id, status) values ($1, $2, 'checked_in')`,
      [past.id, good],
    );
    await pool.query(
      `insert into public.session_registrations (session_id, user_id, status) values ($1, $2, 'no_show')`,
      [past.id, bad],
    );

    expect(
      Number(
        (
          await pool.query<{ r: string }>(`select public.member_reliability($1, $2) r`, [
            fx.gangId,
            good,
          ])
        ).rows[0].r,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await pool.query<{ r: string }>(`select public.member_reliability($1, $2) r`, [
            fx.gangId,
            bad,
          ])
        ).rows[0].r,
      ),
    ).toBe(0);

    // ---- นัดปัจจุบัน: holder ถือที่ · bad กับ good รออยู่ที่ ordering เท่ากัน ----
    await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, holder]);
    // ลง bad ก่อนโดยตั้งใจ — ถ้าเรียงผิดจะได้ bad ขึ้นเพราะมาก่อน
    await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, bad]);
    await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, good]);

    await pool.query(
      `update public.session_registrations set ordering = 1
        where session_id = $1 and status = 'waitlist'`,
      [fx.sessionId],
    );

    const holderReg = (await registrationsOf(fx.sessionId)).find((r) => r.user_id === holder)!;
    await pool.query('select public.cancel_registration($1)', [holderReg.id]);

    const after = await registrationsOf(fx.sessionId);
    expect(after.find((r) => r.user_id === good)!.status).toBe('confirmed');
    expect(after.find((r) => r.user_id === bad)!.status).toBe('waitlist');
  });

  it('2d. waitlist → checked_in ตรงๆ ไม่ได้ → INVALID_REGISTRATION_TRANSITION', async () => {
    const owner = await createUser('owner-2d');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 1 });

    const a = await createUser('user-2d-A');
    const b = await createUser('user-2d-B');
    for (const u of [a, b]) {
      await addGangMember(fx.gangId, u);
      await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
    }

    const rows = await registrationsOf(fx.sessionId);
    const bReg = rows.find((r) => r.user_id === b)!;
    expect(bReg.status).toBe('waitlist');

    await expect(
      pool.query('select public.check_in_registration($1)', [bReg.id]),
    ).rejects.toThrow(/INVALID_REGISTRATION_TRANSITION/);

    // confirmed → checked_in ต้องได้ปกติ
    const aReg = rows.find((r) => r.user_id === a)!;
    await pool.query('select public.check_in_registration($1)', [aReg.id]);
    const after = await registrationsOf(fx.sessionId);
    expect(after.find((r) => r.user_id === a)!.status).toBe('checked_in');
  });

  it('2e. [D-10] คนที่ checked_in แล้วยังกินที่นั่ง — ไม่มีการเลื่อนคิวเกินโควต้า', async () => {
    const owner = await createUser('owner-2e');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 1 });

    const a = await createUser('user-2e-A');
    const b = await createUser('user-2e-B');
    for (const u of [a, b]) {
      await addGangMember(fx.gangId, u);
      await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
    }

    const aReg = (await registrationsOf(fx.sessionId)).find((r) => r.user_id === a)!;
    await pool.query('select public.check_in_registration($1)', [aReg.id]);

    // เรียก promote ตรงๆ — ต้องไม่เลื่อน B ขึ้นมา เพราะ A ที่ checked_in ยังถือที่อยู่
    await pool.query('select * from public.promote_waitlist($1)', [fx.sessionId]);

    const after = await registrationsOf(fx.sessionId);
    expect(after.find((r) => r.user_id === b)!.status).toBe('waitlist');
  });
});
