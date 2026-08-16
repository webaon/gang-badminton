/**
 * WO-3.C DoD — ใครเห็นสถิติของใคร (migration 0031)
 *
 *   · 🔴 สมาชิกเห็น **แถวของตัวเองเท่านั้น** — `total_paid` ของเพื่อนไม่ควรหลุด
 *     (กติกาเดียวกับ `payments` ใน WO-2.9)
 *   · แอดมินเห็นทั้งก๊วน
 *   · คนนอกก๊วนไม่เห็นอะไรเลย
 *   · timeline: `event_logs` ยังเป็นของสมาชิกก๊วนเท่านั้น
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, visibleCount } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`sp-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วนที่มีสมาชิกสองคนและ rollup แล้ว */
async function gangWithStats() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const members: { userId: string; memberId: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const userId = await newUser();
    const {
      rows: [m],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
      [gang.id, userId],
    );
    members.push({ userId, memberId: m.id });
  }

  await pool.query(`select public.rollup_member_statistics($1)`, [gang.id]);

  return { owner, gangId: gang.id, members };
}

describe('WO-3.C DoD — สิทธิ์อ่าน member_statistics', () => {
  it('🔴 สมาชิกเห็นแถวของตัวเองเท่านั้น — ของเพื่อนไม่เห็น', async () => {
    const ctx = await gangWithStats();
    const [me, friend] = ctx.members;

    const sql = 'select 1 from public.member_statistics where gang_member_id = $1';

    expect(await visibleCount(me.userId, sql, [me.memberId])).toBe(1);
    expect(await visibleCount(me.userId, sql, [friend.memberId])).toBe(0);
  });

  it('แอดมินเห็นทั้งก๊วน', async () => {
    const ctx = await gangWithStats();

    const seen = await visibleCount(
      ctx.owner,
      'select 1 from public.member_statistics where gang_id = $1',
      [ctx.gangId],
    );

    // เจ้าของก๊วนเองก็เป็นสมาชิกหนึ่งแถว ⇒ 3 แถว
    expect(seen).toBe(3);
  });

  it('🔴 คนนอกก๊วนไม่เห็นอะไรเลย', async () => {
    const ctx = await gangWithStats();
    const outsider = await newUser();

    expect(
      await visibleCount(outsider, 'select 1 from public.member_statistics where gang_id = $1', [
        ctx.gangId,
      ]),
    ).toBe(0);
  });

  it('🔴 สมาชิกเขียนทับสถิติตัวเองไม่ได้ (มีแต่ rollup ที่เขียนได้)', async () => {
    const ctx = await gangWithStats();
    const [me] = ctx.members;

    const { asRole } = await import('../helpers/db');
    await asRole('authenticated', me.userId, async (c) => {
      await expect(
        c.query(`update public.member_statistics set total_paid = '999999.00' where gang_member_id = $1`, [
          me.memberId,
        ]),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });
  });
});

describe('WO-3.C DoD — timeline อ่านผ่าน RLS', () => {
  it('สมาชิกก๊วนเห็น event ของก๊วนตัวเอง · คนนอกไม่เห็น', async () => {
    const ctx = await gangWithStats();

    const {
      rows: [session],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'นัดมีไทม์ไลน์', now(), now() + interval '2 hours', 8,
               '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [ctx.gangId, ctx.owner],
    );
    await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, ctx.owner]);

    const sql = 'select 1 from public.event_logs where session_id = $1';
    const outsider = await newUser();

    expect(await visibleCount(ctx.members[0].userId, sql, [session.id])).toBeGreaterThan(0);
    expect(await visibleCount(outsider, sql, [session.id])).toBe(0);
  });
});
