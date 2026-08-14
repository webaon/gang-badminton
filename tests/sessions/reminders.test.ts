/**
 * WO-2.5-G DoD — งานเตือน
 *
 *   · 🔴 **ไม่ส่งซ้ำ** — เตือนนัดเดิม/ยอดเดิมสองครั้งไม่ได้ (dedupe key)
 *   · เตือนค้างจ่ายเฉพาะคนที่ยังค้างจริง **หลังหัก allocations/adjustments**
 *   · เข้าคิว `notifications` เดิม — ❌ ไม่มี worker ใหม่
 *
 * เรียก **code path เดียวกับ route handler** (`runReminders`)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { sendSessionReminders, sendPaymentReminders } = await import(
  '@/server/notifications/reminders'
);

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`rm-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วนที่ตั้งเวลาเตือนไว้ + นัดที่เปิดรับสมัคร + ผู้เล่นที่ได้ที่ */
async function openSessionIn(hours: number, opts: { reminderHours?: number } = {}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(
    `update public.gangs
        set settings = jsonb_build_object('reminder',
              jsonb_build_object('session_hours_before', $2::int, 'payment_due_after_hours', 24))
      where id = $1`,
    [gang.id, opts.reminderHours ?? 24],
  );

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'ซ้อมประจำ', now() + make_interval(hours => $2::int),
             now() + make_interval(hours => $2::int + 2), 8, '{"snapshot_version":1}'::jsonb, $3)
     returning id`,
    [gang.id, hours, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const player = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gang.id, player],
  );
  const {
    rows: [reg],
  } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
    session.id,
    player,
  ]);

  return { owner, gangId: gang.id, sessionId: session.id, player, registrationId: reg.id };
}

async function remindersOf(gangId: string, eventType: string) {
  const { rows } = await pool.query<{
    recipient_id: string;
    dedupe_key: string;
    payload: Record<string, unknown>;
    status: string;
  }>(
    `select recipient_id, dedupe_key, payload, status from public.notifications
      where gang_id = $1 and event_type = $2`,
    [gangId, eventType],
  );
  return rows;
}

describe('WO-2.5-G DoD — เตือนก่อนถึงนัด', () => {
  it('นัดที่จะถึงในอีก 12 ชม. (ตั้งเตือน 24) → เข้าคิวให้คนที่ได้ที่', async () => {
    const ctx = await openSessionIn(12);

    await sendSessionReminders(crypto.randomUUID(), new Date());

    const rows = await remindersOf(ctx.gangId, 'session.reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(ctx.player);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].payload.session_id).toBe(ctx.sessionId);
  });

  it('🔴 รันซ้ำไม่เตือนซ้ำ (dedupe key)', async () => {
    const ctx = await openSessionIn(12);

    await sendSessionReminders(crypto.randomUUID(), new Date());
    const created = await sendSessionReminders(crypto.randomUUID(), new Date());

    expect(created).toBe(0);
    expect(await remindersOf(ctx.gangId, 'session.reminder')).toHaveLength(1);
  });

  it('🔴 unique index กันซ้ำที่ระดับฐานข้อมูล — INSERT ตรงก็ยังชน', async () => {
    const ctx = await openSessionIn(12);
    await sendSessionReminders(crypto.randomUUID(), new Date());

    await expect(
      pool.query(
        `insert into public.notifications (gang_id, recipient_id, channel, event_type, dedupe_key)
         values ($1, $2, 'in_app', 'session.reminder', $3)`,
        [ctx.gangId, ctx.player, `session_reminder:${ctx.sessionId}:${ctx.player}`],
      ),
    ).rejects.toThrow(/notifications_dedupe_key/);
  });

  it('นัดที่ยังอีกไกล (72 ชม. แต่ตั้งเตือน 24) → ยังไม่เตือน', async () => {
    const ctx = await openSessionIn(72);

    await sendSessionReminders(crypto.randomUUID(), new Date());
    expect(await remindersOf(ctx.gangId, 'session.reminder')).toHaveLength(0);
  });

  it('ก๊วนที่ตั้งเวลาเตือน = 0 → ปิดการเตือน', async () => {
    const ctx = await openSessionIn(12, { reminderHours: 0 });

    await sendSessionReminders(crypto.randomUUID(), new Date());
    expect(await remindersOf(ctx.gangId, 'session.reminder')).toHaveLength(0);
  });

  it('🔴 คนที่อยู่ waitlist ไม่ถูกเตือน (ยังไม่มีอะไรให้เตือน)', async () => {
    const ctx = await openSessionIn(12);

    // เติมคนจนเต็มแล้วให้คนถัดไปตกคิวรอ
    await pool.query(`update public.sessions set max_players = 1 where id = $1`, [ctx.sessionId]);
    const late = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [ctx.gangId, late],
    );
    await pool.query(`select public.register_to_session($1, $2)`, [ctx.sessionId, late]);

    await sendSessionReminders(crypto.randomUUID(), new Date());

    const rows = await remindersOf(ctx.gangId, 'session.reminder');
    expect(rows.map((r) => r.recipient_id)).toEqual([ctx.player]);
  });

  it('นัดที่ยังเป็น draft ไม่เตือน (ยังไม่เปิดรับสมัคร)', async () => {
    const ctx = await openSessionIn(12);
    await pool.query(
      `select set_config('app.allow_transition', $1::text, true)`,
      [ctx.sessionId],
    );

    // ปิดรับสมัครกลับไป draft ไม่ได้ตาม state machine ⇒ ใช้นัดใหม่ที่ยังไม่ transition แทน
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วน-${crypto.randomUUID()}`,
    ]);
    await pool.query(
      `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
       values ($1, 'ยังร่าง', now() + interval '5 hours', now() + interval '7 hours', 8,
               '{"snapshot_version":1}'::jsonb, $2)`,
      [gang.id, owner],
    );

    await sendSessionReminders(crypto.randomUUID(), new Date());
    expect(await remindersOf(gang.id, 'session.reminder')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/** นัดที่จบไปแล้ว + ปิดรอบ + charge ของผู้เล่นหนึ่งคน */
async function endedSessionWithCharge(amount = '200.00') {
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
     values ($1, 'นัดที่จบแล้ว', now() - interval '3 days', now() - interval '3 days' + interval '2 hours',
             8, '{"snapshot_version":1}'::jsonb, $2)
     returning id`,
    [gang.id, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const player = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gang.id, player],
  );
  const {
    rows: [reg],
  } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
    session.id,
    player,
  ]);
  await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);
  await pool.query(
    `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
    [
      session.id,
      JSON.stringify([{ registration_id: reg.id, amount, breakdown: { flat_rate: amount } }]),
      owner,
    ],
  );

  const {
    rows: [charge],
  } = await pool.query<{ id: string }>(
    `select id from public.session_charges where session_id = $1`,
    [session.id],
  );

  return { owner, gangId: gang.id, sessionId: session.id, player, chargeId: charge.id };
}

describe('WO-2.5-G DoD — เตือนยอดค้างจ่าย', () => {
  it('ค้างจริง → เข้าคิวพร้อมยอดคงเหลือ', async () => {
    const ctx = await endedSessionWithCharge('200.00');

    await sendPaymentReminders(crypto.randomUUID(), new Date());

    const rows = await remindersOf(ctx.gangId, 'payment.overdue');
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(ctx.player);
    expect(rows[0].payload.outstanding).toBe('200.00');
  });

  it('🔴 รันซ้ำไม่เตือนซ้ำ', async () => {
    const ctx = await endedSessionWithCharge();

    await sendPaymentReminders(crypto.randomUUID(), new Date());
    const created = await sendPaymentReminders(crypto.randomUUID(), new Date());

    expect(created).toBe(0);
    expect(await remindersOf(ctx.gangId, 'payment.overdue')).toHaveLength(1);
  });

  it('🔴 เพื่อนจ่ายแทนไปแล้ว (allocation จากสลิปที่ verified) → ไม่ตามเก็บ', async () => {
    const ctx = await endedSessionWithCharge('200.00');

    const {
      rows: [payment],
    } = await pool.query<{ id: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [ctx.gangId, ctx.owner, [ctx.chargeId], ctx.owner],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      ctx.owner,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [
      payment.id,
      ctx.owner,
    ]);

    await sendPaymentReminders(crypto.randomUUID(), new Date());
    expect(await remindersOf(ctx.gangId, 'payment.overdue')).toHaveLength(0);
  });

  it('🔴 ได้เครดิตจนหนี้เป็น 0 → ไม่ตามเก็บ (คิดจาก ledger ไม่ใช่ payments.status)', async () => {
    const ctx = await endedSessionWithCharge('200.00');

    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      ctx.chargeId,
      '-200.00',
      'ยกให้เพราะมาช่วยจัดของ',
      ctx.owner,
    ]);

    await sendPaymentReminders(crypto.randomUUID(), new Date());
    expect(await remindersOf(ctx.gangId, 'payment.overdue')).toHaveLength(0);
  });

  it('จ่ายมาบางส่วน → ยังเตือน และยอดในข้อความเป็นยอดคงเหลือจริง', async () => {
    const ctx = await endedSessionWithCharge('200.00');

    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      ctx.chargeId,
      '-50.00',
      'ส่วนลด',
      ctx.owner,
    ]);

    await sendPaymentReminders(crypto.randomUUID(), new Date());

    const rows = await remindersOf(ctx.gangId, 'payment.overdue');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.outstanding).toBe('150.00');
  });

  it('นัดเพิ่งจบ ยังไม่ถึงเวลาเตือน → ยังไม่เตือน', async () => {
    const ctx = await endedSessionWithCharge();

    // ย้อนเวลาไปตอนที่นัดเพิ่งจบ (ตั้งไว้ 24 ชม.)
    await sendPaymentReminders(
      crypto.randomUUID(),
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
    );

    expect(await remindersOf(ctx.gangId, 'payment.overdue')).toHaveLength(0);
  });
});

describe('WO-2.5-G — ใช้คิวเดิม ไม่มี worker ใหม่', () => {
  it('แถวที่เข้าคิวถูก claim_notifications() หยิบไปส่งได้ตามปกติ', async () => {
    const ctx = await openSessionIn(12);
    await sendSessionReminders(crypto.randomUUID(), new Date());

    const { rows } = await pool.query<{ id: string; event_type: string }>(
      `select * from public.claim_notifications(50)`,
    );

    const mine = rows.filter((r) => r.event_type === 'session.reminder');
    expect(mine.length).toBeGreaterThan(0);

    // worker บันทึกผลด้วยฟังก์ชันเดิม
    await pool.query(`select public.mark_notification_sent($1, true, null)`, [mine[0].id]);

    const { rows: after } = await pool.query<{ status: string }>(
      `select status from public.notifications where id = $1`,
      [mine[0].id],
    );
    expect(after[0].status).toBe('sent');
    expect(ctx.gangId).toBeTruthy();
  });
});
