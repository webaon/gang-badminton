/**
 * WO-3.E DoD — คำขอเข้าก๊วน
 *
 *   · 🔴 อนุมัติ = DB function เดียวที่สร้าง `gang_members` + ปิดคำขอ + เขียน event แบบ atomic
 *   · 🔴 ขอซ้ำ / กดอนุมัติสองครั้ง (รวมกดพร้อมกัน) ต้องไม่ได้สมาชิกซ้ำ
 *   · คำขอที่ถูกปฏิเสธขอใหม่ได้ · เป็นสมาชิกอยู่แล้วขอไม่ได้ตั้งแต่ต้น
 *   · แจ้งเตือนแอดมินผ่านคิวเดิม + `dedupe_key`
 *   · 🔴 ตารางนี้เขียนตรงไม่ได้อีกแล้ว (migration 0033 ถอน INSERT/UPDATE ของ authenticated)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, visibleCount, readAccess, runConcurrently } from '../helpers/db';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`jr-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function publicGang(opts: { discovery?: boolean; isPublic?: boolean } = {}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(
    `update public.gangs
        set is_public = $2,
            features  = features || jsonb_build_object('discovery', $3::boolean)
      where id = $1`,
    [gang.id, opts.isPublic ?? true, opts.discovery ?? true],
  );

  return { owner, gangId: gang.id };
}

async function request(gangId: string, userId: string, message?: string) {
  const {
    rows: [row],
  } = await pool.query<{ id: string; status: string }>(
    `select id, status from public.request_to_join_gang($1, $2, $3)`,
    [gangId, userId, message ?? null],
  );
  return row;
}

async function decide(
  requestId: string,
  gangId: string,
  decision: 'approved' | 'rejected',
  actor: string,
) {
  const {
    rows: [row],
  } = await pool.query<{ id: string; status: string }>(
    `select id, status from public.decide_join_request($1, $2, $3, $4)`,
    [requestId, gangId, decision, actor],
  );
  return row;
}

async function memberCount(gangId: string, userId: string): Promise<number> {
  const {
    rows: [row],
  } = await pool.query<{ n: string }>(
    `select count(*)::text n from public.gang_members
      where gang_id = $1 and user_id = $2 and deleted_at is null`,
    [gangId, userId],
  );
  return Number(row.n);
}

describe('WO-3.E DoD — ขอเข้าก๊วน', () => {
  it('ขอแล้วได้ใบสถานะ pending', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user, 'ขอเข้าก๊วนครับ');
    expect(row.status).toBe('pending');
  });

  it('🔴 ขอเข้าก๊วนส่วนตัวไม่ได้ และข้อความเหมือน "ไม่พบก๊วน" (กันการยืนยันว่ามีก๊วนนี้จริง)', async () => {
    const { gangId } = await publicGang({ isPublic: false });
    const user = await newUser();

    await expect(request(gangId, user)).rejects.toThrow(/NOT_FOUND/);
  });

  it('🔴 ก๊วนที่ปิด features.discovery → FEATURE_DISABLED', async () => {
    const { gangId } = await publicGang({ discovery: false });
    const user = await newUser();

    await expect(request(gangId, user)).rejects.toThrow(/FEATURE_DISABLED/);
  });

  it('เป็นสมาชิกอยู่แล้วขอไม่ได้ตั้งแต่ต้น', async () => {
    const { owner, gangId } = await publicGang();

    await expect(request(gangId, owner)).rejects.toThrow(/ALREADY_REGISTERED/);
  });

  it('🔴 ขอซ้ำระหว่างที่ใบเดิมยังรอ → ได้ใบเดิม ไม่มีแถวใหม่', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    const first = await request(gangId, user);
    const second = await request(gangId, user);

    expect(second.id).toBe(first.id);

    const {
      rows: [row],
    } = await pool.query<{ n: string }>(
      `select count(*)::text n from public.join_requests where gang_id = $1 and user_id = $2`,
      [gangId, user],
    );
    expect(Number(row.n)).toBe(1);
  });

  it('ข้อความยาวเกิน 500 ตัวอักษร → VALIDATION_ERROR', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    await expect(request(gangId, user, 'ก'.repeat(501))).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('แจ้งเตือนแอดมินผ่านคิวเดิม + dedupe_key และขอซ้ำไม่ยิงซ้ำ', async () => {
    const { owner, gangId } = await publicGang();
    const admin = await newUser();
    const plain = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')`,
      [gangId, admin, plain],
    );

    const user = await newUser();
    const row = await request(gangId, user);
    await request(gangId, user);

    const { rows } = await pool.query<{ recipient_id: string; dedupe_key: string }>(
      `select recipient_id, dedupe_key from public.notifications
        where gang_id = $1 and event_type = 'gang.join_requested'`,
      [gangId],
    );

    // เจ้าของ + แอดมิน เท่านั้น — สมาชิกทั่วไปไม่ต้องรู้
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([owner, admin].sort());
    expect(rows.every((r) => r.dedupe_key === `join_request:${row.id}:${r.recipient_id}`)).toBe(true);
  });
});

describe('WO-3.E DoD — อนุมัติ / ปฏิเสธ', () => {
  it('🔴 อนุมัติแล้วได้สมาชิกจริง + คำขอปิด + มี event', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user);
    const decided = await decide(row.id, gangId, 'approved', owner);

    expect(decided.status).toBe('approved');
    expect(await memberCount(gangId, user)).toBe(1);

    const {
      rows: [event],
    } = await pool.query<{ payload: { join_request_id: string } }>(
      `select payload from public.event_logs
        where gang_id = $1 and event_type = 'gang.join_approved'`,
      [gangId],
    );
    expect(event.payload.join_request_id).toBe(row.id);
  });

  it('🔴 กดอนุมัติซ้ำ → INVALID_TRANSITION และไม่ได้สมาชิกซ้ำ', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user);
    await decide(row.id, gangId, 'approved', owner);

    await expect(decide(row.id, gangId, 'approved', owner)).rejects.toThrow(/INVALID_TRANSITION/);
    expect(await memberCount(gangId, user)).toBe(1);
  });

  it('🔴 กดอนุมัติพร้อมกันสองคน → สำเร็จใบเดียว สมาชิกหนึ่งแถว', async () => {
    const { owner, gangId } = await publicGang();
    const admin = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'admin')`,
      [gangId, admin],
    );

    const user = await newUser();
    const row = await request(gangId, user);

    const results = await runConcurrently(2, async (client, i) =>
      client.query(`select public.decide_join_request($1, $2, 'approved', $3)`, [
        row.id,
        gangId,
        i === 0 ? owner : admin,
      ]),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await memberCount(gangId, user)).toBe(1);
  });

  it('ปฏิเสธแล้วยังไม่ได้เป็นสมาชิก และขอใหม่ได้', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const first = await request(gangId, user);
    await decide(first.id, gangId, 'rejected', owner);

    expect(await memberCount(gangId, user)).toBe(0);

    const second = await request(gangId, user);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
  });

  it('🔴 อนุมัติคำขอของก๊วนอื่นไม่ได้ (p_gang_id ผูกกับสิทธิ์ที่ตรวจมาแล้ว)', async () => {
    const a = await publicGang();
    const b = await publicGang();
    const user = await newUser();

    const row = await request(a.gangId, user);

    // แอดมินของก๊วน b ยิง id คำขอของก๊วน a เข้ามา
    await expect(decide(row.id, b.gangId, 'approved', b.owner)).rejects.toThrow(/NOT_FOUND/);
    expect(await memberCount(a.gangId, user)).toBe(0);
  });

  it('เคยถูกลบออกจากก๊วนแล้วขอกลับเข้ามา → รับกลับแถวเดิม ไม่สร้างแถวซ้ำ', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const first = await request(gangId, user);
    await decide(first.id, gangId, 'approved', owner);

    await pool.query(
      `update public.gang_members set deleted_at = now()
        where gang_id = $1 and user_id = $2`,
      [gangId, user],
    );

    const second = await request(gangId, user);
    await decide(second.id, gangId, 'approved', owner);

    const {
      rows: [row],
    } = await pool.query<{ n: string }>(
      `select count(*)::text n from public.gang_members where gang_id = $1 and user_id = $2`,
      [gangId, user],
    );
    expect(Number(row.n)).toBe(1);
    expect(await memberCount(gangId, user)).toBe(1);
  });

  it('แจ้งผลกลับไปหาคนขอ ครั้งเดียวต่อใบ', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user);
    await decide(row.id, gangId, 'approved', owner);

    const { rows } = await pool.query<{ recipient_id: string; dedupe_key: string }>(
      `select recipient_id, dedupe_key from public.notifications
        where gang_id = $1 and event_type = 'gang.join_decided'`,
      [gangId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(user);
    expect(rows[0].dedupe_key).toBe(`join_request:${row.id}:decision`);
  });

  it('decision นอกลิสต์ → VALIDATION_ERROR', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();
    const row = await request(gangId, user);

    await expect(
      pool.query(`select public.decide_join_request($1, $2, 'approved_maybe', $3)`, [
        row.id,
        gangId,
        owner,
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });
});

describe('WO-3.E — ยกเลิกคำขอของตัวเอง', () => {
  it('เจ้าของคำขอยกเลิกได้', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user);
    await pool.query(`select public.cancel_join_request($1, $2)`, [row.id, user]);

    const {
      rows: [after],
    } = await pool.query<{ status: string }>(
      `select status from public.join_requests where id = $1`,
      [row.id],
    );
    expect(after.status).toBe('cancelled');
  });

  it('🔴 คนอื่นยกเลิกคำขอให้ไม่ได้', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user);
    await expect(
      pool.query(`select public.cancel_join_request($1, $2)`, [row.id, owner]),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('ใบที่ตัดสินไปแล้วยกเลิกไม่ได้', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();

    const row = await request(gangId, user);
    await decide(row.id, gangId, 'approved', owner);

    await expect(
      pool.query(`select public.cancel_join_request($1, $2)`, [row.id, user]),
    ).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('ยกเลิกแล้วขอใหม่ได้', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    const first = await request(gangId, user);
    await pool.query(`select public.cancel_join_request($1, $2)`, [first.id, user]);

    const second = await request(gangId, user);
    expect(second.id).not.toBe(first.id);
  });
});

describe('WO-3.E — ด่านของฐานข้อมูล (RLS + grant)', () => {
  it('🔴 ผู้ใช้ที่ล็อกอินอยู่ insert `join_requests` ตรงไม่ได้อีกแล้ว', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    await asRole('authenticated', user, async (c) => {
      await expect(
        c.query(`insert into public.join_requests (gang_id, user_id) values ($1, $2)`, [
          gangId,
          user,
        ]),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });
  });

  it('🔴 แอดมินตั้ง status = approved เองไม่ได้ (ไม่งั้นคำขอโกหกว่ารับเข้าก๊วนแล้ว)', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();
    const row = await request(gangId, user);

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`update public.join_requests set status = 'approved' where id = $1`, [row.id]),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });

    expect(await memberCount(gangId, user)).toBe(0);
  });

  it('คนขอเห็นเฉพาะคำขอของตัวเอง · แอดมินของก๊วนเห็นของก๊วนตัวเอง · คนนอกไม่เห็น', async () => {
    const { owner, gangId } = await publicGang();
    const user = await newUser();
    const outsider = await newUser();

    const row = await request(gangId, user);
    const sql = 'select 1 from public.join_requests where id = $1';

    expect(await visibleCount(user, sql, [row.id])).toBe(1);
    expect(await visibleCount(owner, sql, [row.id])).toBe(1);
    expect(await visibleCount(outsider, sql, [row.id])).toBe(0);
  });

  it('🔴 anon อ่าน `join_requests` ไม่ได้เลย', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();
    const row = await request(gangId, user);

    expect(
      await readAccess(null, 'select 1 from public.join_requests where id = $1', [row.id], 'anon'),
    ).toBe('denied');
  });

  it('🔴 ผู้ใช้เรียก DB function ของ discovery ตรงไม่ได้ (service_role เท่านั้น)', async () => {
    const { gangId } = await publicGang();
    const user = await newUser();

    // แยกคนละ transaction — statement แรกที่พังทำให้ transaction เดิมใช้ต่อไม่ได้
    await asRole('authenticated', user, async (c) => {
      await expect(
        c.query(`select public.request_to_join_gang($1, $2)`, [gangId, user]),
      ).rejects.toThrow(/permission denied/i);
    });

    await asRole('authenticated', user, async (c) => {
      await expect(c.query(`select public.search_public_gangs('ก๊วน')`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    await asRole('authenticated', user, async (c) => {
      await expect(
        c.query(`select public.decide_join_request($1, $2, 'approved', $3)`, [
          crypto.randomUUID(),
          gangId,
          user,
        ]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
