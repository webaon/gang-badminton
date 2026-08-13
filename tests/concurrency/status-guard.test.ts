/**
 * กลไก "ห้าม UPDATE status ตรง" (baseline §State Machines [v3.2]) + rate_limits
 *
 * ไม่ได้อยู่ในลิสต์ DoD 4 ข้อ แต่เป็นหัวใจของ WO-1.3 เท่ากัน — ถ้า trigger ไม่ทำงาน
 * ฟังก์ชัน transition ทั้งหมดก็เป็นแค่ "ทางที่แนะนำ" ไม่ใช่ "ทางเดียว"
 *
 * 🔴 รันผ่าน pooled port โดยตั้งใจ: GUC ถูก set แบบ transaction-local
 *    ⇒ ต้องพิสูจน์ว่าใบอนุญาตไม่รั่วข้าม request เมื่อ connection ถูกใช้ซ้ำ
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  createFixture,
  createUser,
  reloadPostgrestSchema,
} from '../helpers/db';

describe('status guard (GUC trigger) + rate_limits', () => {
  beforeAll(async () => {
    await reloadPostgrestSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('g1. UPDATE sessions.status ตรงๆ → DIRECT_STATUS_UPDATE_FORBIDDEN', async () => {
    const owner = await createUser('owner-g1');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });

    await expect(
      pool.query(`update public.sessions set status = 'in_play' where id = $1`, [fx.sessionId]),
    ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);

    const {
      rows: [s],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      fx.sessionId,
    ]);
    expect(s.status).toBe('open');
  });

  it('g2. UPDATE คอลัมน์อื่นโดยไม่แตะ status → ผ่านปกติ', async () => {
    const owner = await createUser('owner-g2');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });

    await pool.query(`update public.sessions set venue = $2 where id = $1`, [
      fx.sessionId,
      'สนามใหม่',
    ]);

    const {
      rows: [s],
    } = await pool.query<{ venue: string }>(`select venue from public.sessions where id = $1`, [
      fx.sessionId,
    ]);
    expect(s.venue).toBe('สนามใหม่');
  });

  it('g3. UPDATE payments.status ตรงๆ ก็ถูกบล็อกด้วย pattern เดียวกัน', async () => {
    const owner = await createUser('owner-g3');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });

    const {
      rows: [p],
    } = await pool.query<{ id: string }>(
      `insert into public.payments (gang_id, payer_user_id, amount) values ($1, $2, 150.00) returning id`,
      [fx.gangId, owner],
    );

    await expect(
      pool.query(`update public.payments set status = 'verified' where id = $1`, [p.id]),
    ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);
  });

  it('g4. ใบอนุญาต GUC ไม่รั่วข้าม request บน connection เดิม (pooled)', async () => {
    const owner = await createUser('owner-g4');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });

    const client = await pool.connect();
    try {
      // request แรก: transition ถูกต้องผ่านฟังก์ชัน
      await client.query('select public.transition_session($1, $2)', [fx.sessionId, 'in_play']);

      // request ที่สองบน connection เดิม — ต้องไม่ได้รับอานิสงส์จาก GUC ของ request แรก
      await expect(
        client.query(`update public.sessions set status = 'billing' where id = $1`, [fx.sessionId]),
      ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);
    } finally {
      client.release();
    }
  });

  it('g5. ใบอนุญาตครอบเฉพาะ session ที่ transition — แถวอื่นใน transaction เดียวกันยังถูกบล็อก', async () => {
    const owner = await createUser('owner-g5');
    const fxA = await createFixture({ ownerId: owner, maxPlayers: 4 });
    const fxB = await createFixture({ ownerId: owner, maxPlayers: 4 });

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select public.transition_session($1, $2)', [fxA.sessionId, 'in_play']);

      // ใน transaction เดียวกัน แอบดัน session อื่นตามไปด้วยไม่ได้
      await expect(
        client.query(`update public.sessions set status = 'in_play' where id = $1`, [
          fxB.sessionId,
        ]),
      ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);

      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('g6. check_rate_limit นับตามหน้าต่างเวลา และตัดเมื่อเกินโควต้า', async () => {
    const key = `test-rate-${Math.random()}`;

    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const {
        rows: [r],
      } = await pool.query<{ ok: boolean }>(
        `select public.check_rate_limit($1, 3, interval '1 hour') ok`,
        [key],
      );
      allowed.push(r.ok);
    }

    expect(allowed).toEqual([true, true, true, false, false]);

    // หน้าต่างหมดอายุ → เริ่มนับใหม่
    await pool.query(
      `update public.rate_limits set window_start = clock_timestamp() - interval '2 hours' where key = $1`,
      [key],
    );
    const {
      rows: [r],
    } = await pool.query<{ ok: boolean }>(
      `select public.check_rate_limit($1, 3, interval '1 hour') ok`,
      [key],
    );
    expect(r.ok).toBe(true);
  });
});
