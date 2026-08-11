/**
 * DoD ข้อ 3 — "notification worker 2 ตัวรันทับกัน → ไม่ส่งซ้ำ (SKIP LOCKED)"
 *
 * ทดสอบแบบ deterministic: เปิด transaction ของ worker A ค้างไว้ (ยังไม่ commit)
 * แล้วให้ worker B เข้ามา claim ขณะที่แถวของ A ยังถูกล็อกอยู่
 *
 *   - ถ้าเขียน `FOR UPDATE` เฉยๆ  → B จะ **ค้างรอ** A (เทสต์นี้จะ timeout)
 *   - ถ้าลืม `FOR UPDATE` ไปเลย    → B จะได้แถวชุดเดียวกับ A = ส่งซ้ำ
 *   - `FOR UPDATE SKIP LOCKED`     → B ข้ามแถวที่ A ถืออยู่ ได้ชุดที่ไม่ทับกัน ✅
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  createFixture,
  createUser,
  addGangMember,
  runConcurrently,
  reloadPostgrestSchema,
} from '../helpers/db';

async function seedNotifications(gangId: string, recipientId: string, n: number) {
  await pool.query(
    `insert into public.notifications (gang_id, recipient_id, channel, event_type, payload)
     select $1, $2, 'in_app', 'test.queued', jsonb_build_object('i', g)
       from generate_series(1, $3) g`,
    [gangId, recipientId, n],
  );
}

describe('DoD 3 — worker claim ด้วย SKIP LOCKED ไม่หยิบงานซ้ำ', () => {
  beforeAll(async () => {
    await reloadPostgrestSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('3a. worker A ถือ lock ค้างไว้ · worker B claim ต่อ → ได้คนละชุด ไม่ทับกันเลย', async () => {
    const owner = await createUser('owner-3a');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });
    await addGangMember(fx.gangId, owner);
    await seedNotifications(fx.gangId, owner, 20);

    const a = await pool.connect();
    const b = await pool.connect();
    let aIds: string[] = [];
    let bIds: string[] = [];

    try {
      await a.query('begin');
      const aRes = await a.query<{ id: string }>(
        'select id from public.claim_notifications($1)',
        [10],
      );
      aIds = aRes.rows.map((r) => r.id);

      // B เข้ามาขณะที่ A ยังไม่ commit — ต้องไม่ค้างรอ และต้องไม่ได้แถวของ A
      await b.query('begin');
      const bRes = await b.query<{ id: string }>(
        'select id from public.claim_notifications($1)',
        [10],
      );
      bIds = bRes.rows.map((r) => r.id);

      await a.query('commit');
      await b.query('commit');
    } finally {
      a.release();
      b.release();
    }

    expect(aIds).toHaveLength(10);
    expect(bIds).toHaveLength(10);

    // 🔴 หัวใจของ DoD ข้อนี้ — ไม่มี id ไหนโผล่ทั้งสองฝั่ง
    const overlap = aIds.filter((id) => bIds.includes(id));
    expect(overlap, `งานที่ถูกหยิบซ้ำ: ${overlap.join(', ')}`).toHaveLength(0);

    expect(new Set([...aIds, ...bIds]).size).toBe(20);
  });

  it('3b. worker 4 ตัวยิงพร้อมกัน → ทุกงานถูกหยิบครั้งเดียวเป๊ะ', async () => {
    const owner = await createUser('owner-3b');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });
    await addGangMember(fx.gangId, owner);
    await seedNotifications(fx.gangId, owner, 40);

    const results = await runConcurrently(4, (client) =>
      client
        .query<{ id: string }>('select id from public.claim_notifications($1)', [10])
        .then((r) => r.rows.map((x) => x.id)),
    );

    const claimed = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    // ไม่มีงานไหนถูกหยิบสองครั้ง
    expect(new Set(claimed).size, 'มีงานถูก claim ซ้ำ').toBe(claimed.length);

    const {
      rows: [counts],
    } = await pool.query<{ processing: string; pending: string }>(
      `select count(*) filter (where status = 'processing') processing,
              count(*) filter (where status = 'pending')    pending
         from public.notifications where gang_id = $1`,
      [fx.gangId],
    );
    expect(Number(counts.processing)).toBe(claimed.length);
    expect(Number(counts.processing) + Number(counts.pending)).toBe(40);
  });

  it('3c. งานที่ยังไม่ถึง next_retry_at ต้องไม่ถูกหยิบ', async () => {
    const owner = await createUser('owner-3c');
    const fx = await createFixture({ ownerId: owner, maxPlayers: 4 });
    await addGangMember(fx.gangId, owner);

    await pool.query(
      `insert into public.notifications
         (gang_id, recipient_id, channel, event_type, next_retry_at)
       values ($1, $2, 'in_app', 'test.backoff', now() + interval '1 hour')`,
      [fx.gangId, owner],
    );

    const { rows } = await pool.query(
      `select n.id from public.claim_notifications(50) n where n.gang_id = $1`,
      [fx.gangId],
    );
    expect(rows).toHaveLength(0);
  });
});
