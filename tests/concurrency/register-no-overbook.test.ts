/**
 * DoD ข้อ 1 — "ยิง register_to_session พร้อมกัน 2 request ตอนเหลือ 1 ที่
 *              → confirmed 1 + waitlist 1 เสมอ ไม่ overbook"
 *
 * ทดสอบสองชั้น:
 *   1a. เคสตามตัวอักษรของ baseline แบบ **deterministic** — บังคับให้ request ที่สอง
 *       ชน lock ของ request แรกจริงๆ (ไม่ปล่อยให้ขึ้นกับจังหวะ) เพื่อพิสูจน์ว่า
 *       `SELECT ... FOR UPDATE` เป็นตัวกัน ไม่ใช่ความบังเอิญว่ามันไม่ทับกัน
 *   1b. เคสกดหนัก — 8 request พร้อมกันตอนเหลือ 1 ที่ ผ่าน supabase-js RPC
 *       (client path เดียวกับ production)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  serviceClient,
  createFixture,
  createUser,
  addGangMember,
  countByStatus,
  registrationsOf,
  reloadPostgrestSchema,
} from '../helpers/db';

describe('DoD 1 — register_to_session ไม่ overbook', () => {
  beforeAll(async () => {
    await reloadPostgrestSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('1a. เหลือ 1 ที่ · 2 request ที่ชน lock กันจริง → confirmed 1 + waitlist 1', async () => {
    const owner = await createUser('owner-1a');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 2 });

    // เติมให้เหลือที่ว่างพอดี 1 ที่
    const filler = await createUser('filler-1a');
    await addGangMember(fx.gangId, filler);
    await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, filler]);

    const userA = await createUser('racer-1a-A');
    const userB = await createUser('racer-1a-B');
    await addGangMember(fx.gangId, userA);
    await addGangMember(fx.gangId, userB);

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('begin');
      await b.query('begin');

      // A คว้า lock แถว session ไว้ แล้วยังไม่ commit
      await a.query('select public.register_to_session($1, $2)', [fx.sessionId, userA]);

      // B ยิงตาม — ต้องไปค้างที่ FOR UPDATE ไม่ใช่วิ่งผ่านไปนับที่ว่างเอง
      const bPending = b.query('select public.register_to_session($1, $2)', [fx.sessionId, userB]);

      // ให้เวลา B ไปติด lock จริงก่อน
      await new Promise((r) => setTimeout(r, 500));

      await a.query('commit');
      await bPending;
      await b.query('commit');
    } finally {
      a.release();
      b.release();
    }

    const rows = await registrationsOf(fx.sessionId);
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r.status]));

    expect(byUser[userA]).toBe('confirmed');
    expect(byUser[userB]).toBe('waitlist');

    const counts = await countByStatus(fx.sessionId);
    expect(counts.confirmed).toBe(2); // = max_players พอดี ไม่เกิน
    expect(counts.waitlist).toBe(1);
  });

  it('1b. เหลือ 1 ที่ · 8 request พร้อมกันผ่าน RPC → confirmed 1 + waitlist 7', async () => {
    const owner = await createUser('owner-1b');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 5 });

    // เติม 4 คน เหลือที่ว่าง 1
    for (let i = 0; i < 4; i++) {
      const u = await createUser(`filler-1b-${i}`);
      await addGangMember(fx.gangId, u);
      await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
    }
    expect((await countByStatus(fx.sessionId)).confirmed).toBe(4);

    const racers: string[] = [];
    for (let i = 0; i < 8; i++) {
      const u = await createUser(`racer-1b-${i}`);
      await addGangMember(fx.gangId, u);
      racers.push(u);
    }

    // ยิงผ่าน supabase-js — client path เดียวกับ production (baseline §Verification)
    const results = await Promise.allSettled(
      racers.map((u) =>
        serviceClient()
          .rpc('register_to_session', { p_session_id: fx.sessionId, p_user_id: u })
          .then(({ data, error }) => {
            if (error) throw new Error(error.message);
            return data;
          }),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected, `ไม่ควรมี request ไหน error: ${JSON.stringify(rejected)}`).toHaveLength(0);

    const counts = await countByStatus(fx.sessionId);
    expect(counts.confirmed).toBe(5); // 🔴 ห้ามเกิน max_players เด็ดขาด
    expect(counts.waitlist).toBe(7);

    // ทุกคนที่เข้า waitlist ต้องได้ ordering ไม่ซ้ำกัน ไม่งั้นคิวจะกำกวม
    const waitlisted = (await registrationsOf(fx.sessionId)).filter((r) => r.status === 'waitlist');
    const orderings = waitlisted.map((r) => r.ordering);
    expect(new Set(orderings).size).toBe(orderings.length);
  });

  it('1c. นัดที่ยังไม่ open ลงชื่อไม่ได้ → SESSION_NOT_OPEN', async () => {
    const owner = await createUser('owner-1c');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4, status: 'draft' });
    const u = await createUser('racer-1c');

    await expect(
      pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]),
    ).rejects.toThrow(/SESSION_NOT_OPEN/);
  });

  it('1d. ลงชื่อซ้ำคนเดิม → ALREADY_REGISTERED', async () => {
    const owner = await createUser('owner-1d');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });
    const u = await createUser('racer-1d');

    await pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]);
    await expect(
      pool.query('select public.register_to_session($1, $2)', [fx.sessionId, u]),
    ).rejects.toThrow(/ALREADY_REGISTERED/);
  });

  it('1e. guest ลงชื่อตอน features.guests = false → FEATURE_DISABLED', async () => {
    const owner = await createUser('owner-1e');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4, guestsFeature: false });

    await expect(
      pool.query(
        `select public.register_to_session($1, null, $2, null, $3)`,
        [fx.sessionId, 'ผู้มาเยือน', 'any-token'],
      ),
    ).rejects.toThrow(/FEATURE_DISABLED/);
  });

  it('1f. guest ที่ไม่มี invite token ที่ถูกต้อง → INVITE_TOKEN_INVALID', async () => {
    const owner = await createUser('owner-1f');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });

    await expect(
      pool.query(
        `select public.register_to_session($1, null, $2, null, $3)`,
        [fx.sessionId, 'ผู้มาเยือน', 'token-ที่ไม่มีอยู่จริง'],
      ),
    ).rejects.toThrow(/INVITE_TOKEN_INVALID/);
  });

  it('1g. guest ที่มี invite token ถูกต้อง ลงชื่อได้ และ used_count เพิ่ม', async () => {
    const owner = await createUser('owner-1g');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });

    // token_hash unique ทั้งตาราง (ไม่ scope ต่อ session) — ต้องสุ่มไม่งั้นชนกับรอบรันก่อนหน้า
    const token = `plaintext-invite-token-1g-${crypto.randomUUID()}`;
    await pool.query(
      `insert into public.session_invite_tokens (session_id, token_hash, expires_at, max_uses)
       values ($1, extensions.digest($2, 'sha256'), now() + interval '1 day', 2)`,
      [fx.sessionId, token],
    );

    await pool.query(`select public.register_to_session($1, null, $2, null, $3)`, [
      fx.sessionId,
      'ผู้มาเยือน A',
      token,
    ]);

    const counts = await countByStatus(fx.sessionId);
    expect(counts.confirmed).toBe(1);

    const {
      rows: [t],
    } = await pool.query<{ used_count: number }>(
      `select used_count from public.session_invite_tokens where session_id = $1`,
      [fx.sessionId],
    );
    expect(t.used_count).toBe(1);

    // ใช้ครบโควต้าแล้วต้องถูกปฏิเสธ
    await pool.query(`select public.register_to_session($1, null, $2, null, $3)`, [
      fx.sessionId,
      'ผู้มาเยือน B',
      token,
    ]);
    await expect(
      pool.query(`select public.register_to_session($1, null, $2, null, $3)`, [
        fx.sessionId,
        'ผู้มาเยือน C',
        token,
      ]),
    ).rejects.toThrow(/INVITE_TOKEN_EXHAUSTED/);
  });
});
