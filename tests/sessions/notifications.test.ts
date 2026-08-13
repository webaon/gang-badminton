/**
 * WO-2.10 DoD — in-app notifications + worker
 *
 *   · worker ส่งจริงแล้วเปลี่ยนเป็น `sent`
 *   · ส่งไม่สำเร็จ → backoff ตาม baseline · เกิน 3 ครั้ง = `failed` ถาวร
 *   · แถวค้าง `processing` ถูก sweep คืนคิวได้จริง
 *   · ผู้ใช้เห็นเฉพาะ notification ของตัวเอง
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, visibleCount, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { dispatchNotifications } = await import('@/server/cron/notifications');

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`nt-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithSession() {
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
     values ($1, 'นัดแจ้งเตือน', now() + interval '2 days', now() + interval '2 days 2 hours', 8,
             '{"snapshot_version":1}'::jsonb, $2)
     returning id`,
    [gang.id, owner],
  );

  return { owner, gangId: gang.id, sessionId: session.id };
}

/** ปิดคิวของก๊วนอื่นไม่ให้ปนกับเทสต์นี้ (worker หยิบจากคิวทั้งตาราง) */
async function quiesceOthers(gangId: string) {
  await pool.query(
    `update public.notifications set next_retry_at = now() + interval '10 years'
      where status = 'pending' and gang_id <> $1`,
    [gangId],
  );
}

describe('WO-2.10 — สร้าง notification เข้าคิว', () => {
  it('เปิดรับสมัคร → สมาชิกก๊วนทุกคนได้รับ', async () => {
    const { gangId, sessionId, owner } = await gangWithSession();

    const mate = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gangId, mate],
    );

    const {
      rows: [{ n }],
    } = await pool.query<{ n: number }>(
      `select public.enqueue_session_notification($1, 'session.opened', 'gang_members') n`,
      [sessionId],
    );

    expect(n).toBe(2); // owner + mate

    const { rows } = await pool.query<{ recipient_id: string; status: string }>(
      `select recipient_id, status from public.notifications where gang_id = $1`,
      [gangId],
    );
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([owner, mate].sort());
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('เตือนจ่าย → เฉพาะคนที่มียอดจริง ไม่ใช่ทุกคนในก๊วน', async () => {
    const { gangId, sessionId, owner } = await gangWithSession();

    const payer = await newUser();
    const bystander = await newUser();
    for (const u of [payer, bystander]) {
      await pool.query(
        `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
        [gangId, u],
      );
    }

    await pool.query(`select public.transition_session($1, 'open', $2)`, [sessionId, owner]);
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      sessionId,
      payer,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    await pool.query(`select public.transition_session($1, 'in_play', $2)`, [sessionId, owner]);
    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
      [
        sessionId,
        JSON.stringify([{ registration_id: reg.id, amount: '200.00', breakdown: {} }]),
        owner,
      ],
    );

    await pool.query(
      `select public.enqueue_session_notification($1, 'payment.due', 'charged')`,
      [sessionId],
    );

    const { rows } = await pool.query<{ recipient_id: string }>(
      `select recipient_id from public.notifications
        where gang_id = $1 and event_type = 'payment.due'`,
      [gangId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(payer);
  });

  it('audience ที่ไม่รู้จัก → VALIDATION_ERROR', async () => {
    const { sessionId } = await gangWithSession();
    await expect(
      pool.query(`select public.enqueue_session_notification($1, 'x', 'ทุกคนในโลก')`, [sessionId]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });
});

describe('WO-2.10 DoD — worker ส่งจริง', () => {
  it('🔴 in_app → เปลี่ยนเป็น sent + บันทึก notification_logs', async () => {
    const { gangId, sessionId, owner } = await gangWithSession();
    await quiesceOthers(gangId);
    await pool.query(`select public.enqueue_session_notification($1, 'session.opened')`, [
      sessionId,
    ]);

    const result = await dispatchNotifications('test-cid');

    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ status: string; sent_at: Date | null }>(
      `select status, sent_at from public.notifications where gang_id = $1`,
      [gangId],
    );
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows.every((r) => r.sent_at !== null)).toBe(true);

    const { rows: logs } = await pool.query<{ success: boolean }>(
      `select success from public.notification_logs where gang_id = $1`,
      [gangId],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(true);

    void owner;
  });

  it('🔴 channel ที่ยังไม่รองรับ (line) → failed พร้อม last_error ไม่ mark sent หลอกๆ', async () => {
    const { gangId, owner } = await gangWithSession();
    await quiesceOthers(gangId);

    await pool.query(
      `insert into public.notifications (gang_id, recipient_id, channel, event_type)
       values ($1, $2, 'line', 'session.opened')`,
      [gangId, owner],
    );

    await dispatchNotifications('test-cid');

    const {
      rows: [row],
    } = await pool.query<{ status: string; last_error: string; attempt: number }>(
      `select status, last_error, attempt from public.notifications
        where gang_id = $1 and channel = 'line'`,
      [gangId],
    );

    // attempt 1 ⇒ ยังไม่ failed ถาวร แต่ต้องมี last_error และถูกเลื่อนไป retry
    expect(row.status).toBe('pending');
    expect(row.last_error).toMatch(/LINE/);
    expect(Number(row.attempt)).toBe(1);
  });

  it('🔴 ลองครบ 3 ครั้ง → failed ถาวร (ไม่วนไม่รู้จบ)', async () => {
    const { gangId, owner } = await gangWithSession();
    await quiesceOthers(gangId);

    await pool.query(
      `insert into public.notifications (gang_id, recipient_id, channel, event_type, attempt)
       values ($1, $2, 'line', 'session.opened', 2)`,
      [gangId, owner],
    );

    await dispatchNotifications('test-cid');

    const {
      rows: [row],
    } = await pool.query<{ status: string }>(
      `select status from public.notifications where gang_id = $1 and channel = 'line'`,
      [gangId],
    );
    expect(row.status).toBe('failed');
  });

  it('ไม่มีงานในคิว → ไม่พัง คืน 0', async () => {
    const { gangId } = await gangWithSession();
    await quiesceOthers(gangId);

    const result = await dispatchNotifications('test-cid');
    expect(result.claimed).toBe(0);
  });

  it('🔴 แถวค้าง processing ถูก sweep คืนคิวแล้ว worker หยิบต่อได้', async () => {
    const { gangId, owner } = await gangWithSession();
    await quiesceOthers(gangId);

    // จำลอง worker ตายกลางทาง
    await pool.query(
      `insert into public.notifications
         (gang_id, recipient_id, channel, event_type, status, claimed_at, attempt)
       values ($1, $2, 'in_app', 'session.opened', 'processing', now() - interval '1 hour', 1)`,
      [gangId, owner],
    );

    await pool.query(`select public.sweep_stuck_notifications()`);
    await pool.query(
      `update public.notifications set next_retry_at = now() where gang_id = $1`,
      [gangId],
    );

    const result = await dispatchNotifications('test-cid');
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const {
      rows: [row],
    } = await pool.query<{ status: string }>(
      `select status from public.notifications where gang_id = $1`,
      [gangId],
    );
    expect(row.status).toBe('sent');
  });
});

describe('WO-2.10 DoD — เห็นเฉพาะของตัวเอง', () => {
  it('🔴 ผู้ใช้อ่าน notification ของคนอื่นไม่ได้', async () => {
    const { gangId, owner } = await gangWithSession();

    const other = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gangId, other],
    );

    const {
      rows: [notification],
    } = await pool.query<{ id: string }>(
      `insert into public.notifications (gang_id, recipient_id, channel, event_type)
       values ($1, $2, 'in_app', 'session.opened') returning id`,
      [gangId, owner],
    );

    const sql = 'select 1 from public.notifications where id = $1';
    expect(await visibleCount(owner, sql, [notification.id])).toBe(1);
    // อยู่ก๊วนเดียวกันก็ไม่เห็นกระดิ่งของคนอื่น
    expect(await visibleCount(other, sql, [notification.id])).toBe(0);
  });
});
