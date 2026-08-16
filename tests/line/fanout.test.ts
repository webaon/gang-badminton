/**
 * WO-4.C DoD — fan-out ช่องทาง `line` + โควต้า
 *
 *   · 🔴 คีย์ dedupe ของ `in_app` **ไม่เปลี่ยนรูป** ⇒ ของที่เคยส่งแล้วไม่ถูกยิงใหม่
 *   · 🔴 ปิด flag / ยังไม่ผูกบัญชี / บล็อก OA → ไม่มีแถว `line` เลย
 *   · in-app ยังได้เหมือนเดิมทุกกรณี
 *   · 🔴 เกินโควต้า = ไม่เข้าคิวเพิ่ม (นับจาก `notification_logs` เท่านั้น)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../helpers/db';
import { lineMessageFor } from '@/domain/notifications/line-message';

const TOKEN = 'ACCESS-TOKEN-1234567890abcdefWXYZ';
const SECRET = 'channel-secret-abcdef123456';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`fan-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithLine(opts: { enabled?: boolean } = {}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนคิว-${crypto.randomUUID()}`,
  ]);

  await pool.query(`select public.set_gang_line_credentials($1, $2, $3, null, $4)`, [
    gang.id,
    TOKEN,
    SECRET,
    owner,
  ]);

  if (opts.enabled ?? true) {
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gang.id, owner]);
  }

  return { owner, gangId: gang.id };
}

async function addMember(gangId: string, opts: { link?: string; blocked?: boolean } = {}) {
  const userId = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gangId, userId],
  );

  if (opts.link) {
    await pool.query(`select public.link_line_account($1, $2, $3)`, [gangId, userId, opts.link]);

    if (opts.blocked) {
      await pool.query(`select public.set_line_link_blocked($1, $2, true)`, [gangId, opts.link]);
    }
  }

  return userId;
}

async function enqueue(rows: unknown[]): Promise<number> {
  const {
    rows: [row],
  } = await pool.query<{ enqueue_notifications: number }>(
    `select public.enqueue_notifications($1::jsonb)`,
    [JSON.stringify(rows)],
  );
  return row.enqueue_notifications;
}

async function queued(gangId: string) {
  const { rows } = await pool.query<{
    channel: string;
    recipient_id: string;
    dedupe_key: string | null;
    event_type: string;
  }>(
    `select channel, recipient_id, dedupe_key, event_type from public.notifications
      where gang_id = $1 order by channel`,
    [gangId],
  );
  return rows;
}

/**
 * ⚠️ `dedupe_key` เป็น unique **ทั้งตาราง** และเทสต์ไม่ล้างข้อมูลหลังรัน
 *    ⇒ คีย์ต้องไม่ซ้ำข้ามการรัน ไม่งั้นรอบที่สองจะ `do nothing` ทั้งหมดแล้วเทสต์แดงแบบงงๆ
 */
const RUN = crypto.randomUUID().slice(0, 8);

function key(name: string): string {
  return `${RUN}:${name}`;
}

function row(gangId: string, recipientId: string, key: string | null = null) {
  return {
    gang_id: gangId,
    recipient_id: recipientId,
    event_type: 'session.opened',
    payload: { session_title: 'ซ้อมวันพุธ' },
    dedupe_key: key,
  };
}

describe('WO-4.C DoD — fan-out', () => {
  it('ผู้รับที่ผูกบัญชีไว้ได้ทั้ง in_app และ line', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-fan-1' });

    const created = await enqueue([row(gangId, userId, key('session:1:u'))]);
    expect(created).toBe(2);

    const rows = await queued(gangId);
    expect(rows.map((r) => r.channel).sort()).toEqual(['in_app', 'line']);
  });

  it('🔴 คีย์ของ in_app ไม่เปลี่ยนรูป · line ได้คีย์ `<เดิม>:line`', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-fan-2' });

    await enqueue([row(gangId, userId, key('announcement:abc:u1'))]);

    const rows = await queued(gangId);
    expect(rows.find((r) => r.channel === 'in_app')?.dedupe_key).toBe(key('announcement:abc:u1'));
    expect(rows.find((r) => r.channel === 'line')?.dedupe_key).toBe(
      `${key('announcement:abc:u1')}:line`,
    );
  });

  it('🔴 ของที่ `in_app` เคยส่งไปแล้ว ไม่ถูกยิงใหม่หลังเปิด LINE', async () => {
    const { gangId } = await gangWithLine({ enabled: false });
    const userId = await addMember(gangId);

    // รอบแรก: ยังไม่เปิด LINE — ได้ in_app ใบเดียว แล้วสมมติว่าส่งไปแล้ว
    await enqueue([row(gangId, userId, key('session:old:u'))]);
    await pool.query(`update public.notifications set status = 'sent' where gang_id = $1`, [gangId]);

    // เปิด LINE + ผูกบัญชีทีหลัง แล้วงานเดิมถูก enqueue ซ้ำ (เช่น cron รันใหม่)
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gangId, userId]);
    await pool.query(`select public.link_line_account($1, $2, 'U-fan-3')`, [gangId, userId]);

    const created = await enqueue([row(gangId, userId, key('session:old:u'))]);

    // ได้เฉพาะแถว line ใบใหม่ — in_app ใบเดิมยังนับว่าเคยส่งแล้ว ไม่มีใครโดนซ้ำ
    expect(created).toBe(1);

    const rows = await queued(gangId);
    expect(rows.filter((r) => r.channel === 'in_app')).toHaveLength(1);
    expect(rows.filter((r) => r.channel === 'line')).toHaveLength(1);
  });

  it('🔴 ก๊วนที่ปิด features.line → ไม่มีแถว line เลย (แต่ in_app ยังได้)', async () => {
    // ผูกบัญชีตอนที่ยังเปิดอยู่ แล้วค่อยปิด — พิสูจน์ว่า flag เป็นตัวตัดสินตอน fan-out
    // ไม่ใช่แค่ตอนผูกบัญชี (`link_line_account()` ปฏิเสธถ้าปิดอยู่ ซึ่งเป็นอีกด่านหนึ่ง)
    const { gangId, owner } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-fan-4' });
    await pool.query(`select public.set_gang_line_enabled($1, false, $2)`, [gangId, owner]);

    await enqueue([row(gangId, userId, key('session:2:u'))]);

    const rows = await queued(gangId);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('in_app');
  });

  it('🔴 คนที่ยังไม่ผูกบัญชี → ได้เฉพาะ in_app', async () => {
    const { gangId } = await gangWithLine();
    const linked = await addMember(gangId, { link: 'U-fan-5' });
    const unlinked = await addMember(gangId);

    await enqueue([row(gangId, linked, key('k1')), row(gangId, unlinked, key('k2'))]);

    const rows = await queued(gangId);
    expect(rows.filter((r) => r.channel === 'line')).toHaveLength(1);
    expect(rows.filter((r) => r.channel === 'line')[0].recipient_id).toBe(linked);
    expect(rows.filter((r) => r.channel === 'in_app')).toHaveLength(2);
  });

  it('🔴 คนที่บล็อก OA → ไม่มีแถว line (แต่ in_app ยังได้)', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-fan-6', blocked: true });

    await enqueue([row(gangId, userId, key('k3'))]);

    const rows = await queued(gangId);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('in_app');
  });

  it('งานที่ไม่ต้องกันซ้ำ (dedupe_key = null) ยัง fan-out ได้', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-fan-7' });

    await enqueue([row(gangId, userId, null)]);

    const rows = await queued(gangId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dedupe_key === null)).toBe(true);
  });
});

describe('WO-4.C DoD — โควต้า', () => {
  async function usage(gangId: string) {
    const {
      rows: [row],
    } = await pool.query<{ used: number; monthly_quota: number | null; is_over: boolean }>(
      `select used, monthly_quota, is_over from public.line_quota_status($1)`,
      [gangId],
    );
    return row;
  }

  /** จำลองว่าส่ง LINE สำเร็จไปแล้ว n ข้อความในเดือนนี้ */
  async function logSent(gangId: string, n: number, success = true) {
    for (let i = 0; i < n; i++) {
      await pool.query(
        `insert into public.notification_logs (gang_id, channel, success) values ($1, 'line', $2)`,
        [gangId, success],
      );
    }
  }

  it('ค่าเริ่มต้นคือ 200 ข้อความต่อเดือน (free tier ของ LINE OA)', async () => {
    const { gangId } = await gangWithLine();
    expect((await usage(gangId)).monthly_quota).toBe(200);
  });

  it('🔴 นับเฉพาะข้อความที่ส่งสำเร็จ — ส่งไม่สำเร็จไม่กินโควต้า', async () => {
    const { gangId } = await gangWithLine();

    await logSent(gangId, 3, true);
    await logSent(gangId, 5, false);

    expect((await usage(gangId)).used).toBe(3);
  });

  it('🔴 เกินโควต้า → ไม่มีแถว line เข้าคิวอีก (in_app ยังเข้าปกติ)', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-quota-1' });

    await pool.query(`select public.set_gang_line_quota($1, 2, $2)`, [gangId, userId]);
    await logSent(gangId, 2);

    expect((await usage(gangId)).is_over).toBe(true);

    await enqueue([row(gangId, userId, key('q1'))]);

    const rows = await queued(gangId);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('in_app');
  });

  it('ยังไม่เต็มโควต้า → เข้าคิวได้ตามปกติ', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-quota-2' });

    await pool.query(`select public.set_gang_line_quota($1, 5, $2)`, [gangId, userId]);
    await logSent(gangId, 4);

    await enqueue([row(gangId, userId, key('q2'))]);
    expect((await queued(gangId)).filter((r) => r.channel === 'line')).toHaveLength(1);
  });

  it('เพดาน null = ไม่จำกัด', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-quota-3' });

    await pool.query(`select public.set_gang_line_quota($1, null, $2)`, [gangId, userId]);
    await logSent(gangId, 500);

    const status = await usage(gangId);
    expect(status.monthly_quota).toBeNull();
    expect(status.is_over).toBe(false);

    await enqueue([row(gangId, userId, key('q3'))]);
    expect((await queued(gangId)).filter((r) => r.channel === 'line')).toHaveLength(1);
  });

  it('เพดานติดลบ → VALIDATION_ERROR', async () => {
    const { gangId, owner } = await gangWithLine();

    await expect(
      pool.query(`select public.set_gang_line_quota($1, -1, $2)`, [gangId, owner]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });
});

describe('WO-4.C — ข้อมูลปลายทางของ worker', () => {
  it('คืน line_user_id + token + สถานะครบในครั้งเดียว', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId, { link: 'U-ctx-1' });

    const {
      rows: [context],
    } = await pool.query<{
      line_user_id: string;
      access_token: string;
      is_enabled: boolean;
      is_blocked: boolean;
      is_over_quota: boolean;
    }>(`select * from public.line_delivery_context($1, $2)`, [gangId, userId]);

    expect(context.line_user_id).toBe('U-ctx-1');
    expect(context.access_token).toBe(TOKEN);
    expect(context.is_enabled).toBe(true);
    expect(context.is_blocked).toBe(false);
    expect(context.is_over_quota).toBe(false);
  });

  it('คนที่ยังไม่ผูกบัญชี → ไม่มีแถว (worker จะไม่ส่ง)', async () => {
    const { gangId } = await gangWithLine();
    const userId = await addMember(gangId);

    const { rows } = await pool.query(`select * from public.line_delivery_context($1, $2)`, [
      gangId,
      userId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('🔴 ผู้ใช้เรียกฟังก์ชันที่คืน token ตรงไม่ได้', async () => {
    const { gangId, owner } = await gangWithLine();
    const { asRole } = await import('../helpers/db');

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select public.line_delivery_context($1, $2)`, [gangId, owner]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe('WO-4.C — ข้อความที่ส่งเข้า LINE (pure)', () => {
  it('event ที่รู้จักได้ข้อความเฉพาะของมัน', () => {
    expect(lineMessageFor('session.opened', { session_title: 'ซ้อมวันพุธ' })).toContain('ซ้อมวันพุธ');
    expect(lineMessageFor('waitlist.promoted', {})).toContain('คิวถึงคุณแล้ว');
    expect(lineMessageFor('line.linked', {})).toContain('ผูกบัญชีเรียบร้อย');
  });

  it('🔴 ข้อความเรื่องเงินไม่มีตัวเลขยอดติดไปด้วย', () => {
    const text = lineMessageFor('payment.due', { amount: '1234.00', outstanding: '999.00' });
    expect(text).not.toContain('1234');
    expect(text).not.toContain('999');
  });

  it('🔴 event ที่ไม่รู้จัก → ข้อความกลางๆ ไม่ใช่ payload ดิบ', () => {
    const text = lineMessageFor('something.new', { secret_token: 'abc123', amount: '500.00' });
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('500');
    expect(text).toContain('เปิดแอป');
  });

  it('payload ที่ไม่ใช่ scalar ถูกทิ้ง (ไม่มี [object Object] โผล่ในแชต)', () => {
    const text = lineMessageFor('announcement.published', { title: { nested: 'x' } });
    expect(text).not.toContain('object');
  });
});
