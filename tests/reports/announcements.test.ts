/**
 * WO-3.D DoD — ประกาศของก๊วน
 *
 *   · 🔴 ร่าง (ยังไม่ publish) สมาชิกทั่วไป **มองไม่เห็น** — เทสต์ระดับ RLS
 *   · publish แล้วเข้าคิวแจ้งเตือนผ่าน `enqueue_notifications()` พร้อม `dedupe_key`
 *   · 🔴 publish ซ้ำ / แก้แล้ว publish ใหม่ **ไม่ส่งซ้ำ**
 *   · เวลาที่ประกาศครั้งแรกไม่ถูกเลื่อน
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, visibleCount } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`an-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithMembers(n = 2) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  const members: string[] = [];
  for (let i = 0; i < n; i++) {
    const userId = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, userId],
    );
    members.push(userId);
  }

  return { owner, gangId: gang.id, members };
}

async function draft(gangId: string, actor: string, title = 'ขึ้นราคาเดือนหน้า') {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into public.announcements (gang_id, title, body, created_by)
     values ($1, $2, 'รายละเอียดตามนี้', $3) returning id`,
    [gangId, title, actor],
  );
  return row.id;
}

async function publish(announcementId: string, actor: string) {
  const {
    rows: [row],
  } = await pool.query<{ id: string; published_at: string | null }>(
    `select id, published_at from public.publish_announcement($1, $2)`,
    [announcementId, actor],
  );
  return row;
}

async function notificationsOf(gangId: string) {
  const { rows } = await pool.query<{ recipient_id: string; dedupe_key: string }>(
    `select recipient_id, dedupe_key from public.notifications
      where gang_id = $1 and event_type = 'announcement.published'`,
    [gangId],
  );
  return rows;
}

describe('WO-3.D DoD — ร่างต้องไม่หลุดถึงสมาชิก', () => {
  it('🔴 สมาชิกทั่วไปมองไม่เห็นร่าง · แอดมินเห็น', async () => {
    const ctx = await gangWithMembers();
    const id = await draft(ctx.gangId, ctx.owner);

    const sql = 'select 1 from public.announcements where id = $1';

    expect(await visibleCount(ctx.members[0], sql, [id])).toBe(0);
    expect(await visibleCount(ctx.owner, sql, [id])).toBe(1);
  });

  it('publish แล้วสมาชิกเห็น', async () => {
    const ctx = await gangWithMembers();
    const id = await draft(ctx.gangId, ctx.owner);

    await publish(id, ctx.owner);

    expect(
      await visibleCount(ctx.members[0], 'select 1 from public.announcements where id = $1', [id]),
    ).toBe(1);
  });

  it('🔴 คนนอกก๊วนไม่เห็นแม้ประกาศแล้ว', async () => {
    const ctx = await gangWithMembers();
    const id = await draft(ctx.gangId, ctx.owner);
    await publish(id, ctx.owner);

    const outsider = await newUser();
    expect(
      await visibleCount(outsider, 'select 1 from public.announcements where id = $1', [id]),
    ).toBe(0);
  });

  it('🔴 สมาชิกทั่วไปเขียนประกาศเองไม่ได้', async () => {
    const ctx = await gangWithMembers();

    await asRole('authenticated', ctx.members[0], async (c) => {
      await expect(
        c.query(
          `insert into public.announcements (gang_id, title, body) values ($1, 'ยัดเอง', 'เนื้อหา')`,
          [ctx.gangId],
        ),
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });
});

describe('WO-3.D DoD — แจ้งเตือนตอน publish', () => {
  it('เข้าคิวให้สมาชิกทุกคนของก๊วน', async () => {
    const ctx = await gangWithMembers(3);
    const id = await draft(ctx.gangId, ctx.owner);

    await publish(id, ctx.owner);

    const rows = await notificationsOf(ctx.gangId);
    // สมาชิก 3 คน + เจ้าของก๊วน
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.dedupe_key.startsWith(`announcement:${id}:`))).toBe(true);
  });

  it('🔴 กด publish ซ้ำ → ไม่ส่งซ้ำ และเวลาประกาศไม่ถูกเลื่อน', async () => {
    const ctx = await gangWithMembers(2);
    const id = await draft(ctx.gangId, ctx.owner);

    const first = await publish(id, ctx.owner);
    const countAfterFirst = (await notificationsOf(ctx.gangId)).length;

    const second = await publish(id, ctx.owner);

    expect(second.published_at).toEqual(first.published_at);
    expect((await notificationsOf(ctx.gangId)).length).toBe(countAfterFirst);
  });

  it('🔴 แก้เนื้อหาแล้ว publish ใหม่ → ยังไม่ส่งซ้ำ', async () => {
    const ctx = await gangWithMembers(2);
    const id = await draft(ctx.gangId, ctx.owner);

    await publish(id, ctx.owner);
    const before = (await notificationsOf(ctx.gangId)).length;

    await pool.query(`update public.announcements set body = 'แก้ใหม่' where id = $1`, [id]);
    await publish(id, ctx.owner);

    expect((await notificationsOf(ctx.gangId)).length).toBe(before);
  });

  it('สมาชิกที่เพิ่งเข้าก๊วนหลังประกาศ ได้รับตอน publish รอบถัดไป', async () => {
    const ctx = await gangWithMembers(1);
    const id = await draft(ctx.gangId, ctx.owner);
    await publish(id, ctx.owner);

    const late = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [ctx.gangId, late],
    );

    await publish(id, ctx.owner);

    const rows = await notificationsOf(ctx.gangId);
    expect(rows.some((r) => r.recipient_id === late)).toBe(true);
  });

  it('บันทึก event ของก๊วนพร้อมจำนวนที่แจ้ง', async () => {
    const ctx = await gangWithMembers(2);
    const id = await draft(ctx.gangId, ctx.owner);
    await publish(id, ctx.owner);

    const {
      rows: [event],
    } = await pool.query<{ payload: { notified: number; announcement_id: string } }>(
      `select payload from public.event_logs
        where gang_id = $1 and event_type = 'announcement.published'`,
      [ctx.gangId],
    );

    expect(event.payload.announcement_id).toBe(id);
    expect(event.payload.notified).toBe(3);
  });

  it('ประกาศที่ไม่มีเนื้อหา → VALIDATION_ERROR (ไม่ยิงแจ้งเตือนเปล่า)', async () => {
    const ctx = await gangWithMembers(1);
    const {
      rows: [row],
    } = await pool.query<{ id: string }>(
      `insert into public.announcements (gang_id, title, body, created_by)
       values ($1, '   ', '   ', $2) returning id`,
      [ctx.gangId, ctx.owner],
    );

    await expect(publish(row.id, ctx.owner)).rejects.toThrow(/VALIDATION_ERROR/);
    expect(await notificationsOf(ctx.gangId)).toHaveLength(0);
  });

  it('🔴 ผู้ใช้ที่ล็อกอินอยู่เรียก publish_announcement() ตรงไม่ได้', async () => {
    const ctx = await gangWithMembers(1);
    const id = await draft(ctx.gangId, ctx.owner);

    await asRole('authenticated', ctx.owner, async (c) => {
      await expect(
        c.query(`select public.publish_announcement($1, $2)`, [id, ctx.owner]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
