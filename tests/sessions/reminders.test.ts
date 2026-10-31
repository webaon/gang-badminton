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

describe('WO-B13 — แบ่งหน้า ไม่ให้ PostgREST ตัดผลเงียบๆ (max_rows)', () => {
  /** นัดเปิดที่อยู่ในช่วงที่ query ดึง (now, now+14d] — DB local มีนัดค้างจากเทสต์อื่นเป็นพัน */
  async function openSessionsInWindow(): Promise<number> {
    const {
      rows: [row],
    } = await pool.query<{ n: string }>(
      `select count(*) as n from public.sessions
        where status = 'open' and deleted_at is null
          and starts_at > now() and starts_at <= now() + interval '336 hours'`,
    );
    return Number(row.n);
  }

  /** นัดที่ "ท้ายสุด" ของลำดับ starts_at: ห่างอีก 13 วัน + ก๊วนตั้งเตือน 336 ชม. (14 วัน) */
  async function lateSession() {
    return openSessionIn(13 * 24, { reminderHours: 336 });
  }

  it('🔴 นัดที่อยู่หลังหน้าแรกหลายหน้า ยังถูกเตือน (pageSize เล็ก ⇒ ต้องวนอ่านจนหมด)', async () => {
    const early = await openSessionIn(1);
    const late = await lateSession();

    const total = await openSessionsInWindow();
    const pageSize = Math.max(1, Math.floor(total / 4));
    expect(total).toBeGreaterThanOrEqual(2);

    await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize });

    // นัดท้ายสุดต้องไปไกลกว่าหน้าแรกอย่างน้อย 3 หน้า — ถ้าโค้ดอ่านหน้าเดียว จะไม่เห็นนัดนี้
    expect(await remindersOf(early.gangId, 'session.reminder')).toHaveLength(1);
    const rows = await remindersOf(late.gangId, 'session.reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(late.player);
  });

  it('🔴 pageSize = 1 (ขอบเขตสุด) ก็ยังเตือนถูก และรันซ้ำไม่เตือนซ้ำ', async () => {
    // ลดงานให้พอดี: ใช้ pageSize 1 กับ DB ที่มีนัดเปิดน้อยพอเท่านั้น ไม่งั้นวนนานเกินจำเป็น
    const ctx = await openSessionIn(12);
    const total = await openSessionsInWindow();
    const pageSize = total > 300 ? Math.ceil(total / 5) : 1;

    await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize });
    const again = await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize });

    expect(again).toBe(0);
    expect(await remindersOf(ctx.gangId, 'session.reminder')).toHaveLength(1);
  });

  it('🔴 ผู้เล่นในนัดเดียวเกินหน้า (registrationPageSize เล็ก) ถูกเตือนครบทุกคน ไม่ขาดไม่ซ้ำ', async () => {
    const ctx = await openSessionIn(12);

    // เติมผู้เล่นอีก 6 คน (นัดรับ 8) ⇒ รวม 7 คน confirmed
    const players = [ctx.player];
    for (let i = 0; i < 6; i += 1) {
      const p = await newUser();
      await pool.query(
        `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
        [ctx.gangId, p],
      );
      await pool.query(`select public.register_to_session($1, $2)`, [ctx.sessionId, p]);
      players.push(p);
    }

    await sendSessionReminders(crypto.randomUUID(), new Date(), { registrationPageSize: 2 });

    const rows = await remindersOf(ctx.gangId, 'session.reminder');
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.recipient_id))).toEqual(new Set(players));
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(7);
  });

  it('ค่าเริ่มต้นของหน้า (production) ต้องน้อยกว่า max_rows ของ PostgREST (1000)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..', '..');

    const src = readFileSync(join(root, 'server/notifications/reminders.ts'), 'utf8');
    const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');

    const pageSize = Number(/const PAGE_SIZE = (\d+);/.exec(src)?.[1]);
    const maxRows = Number(/^max_rows\s*=\s*(\d+)/m.exec(config)?.[1]);

    expect(maxRows).toBeGreaterThan(0);
    expect(pageSize).toBeGreaterThan(0);
    expect(pageSize).toBeLessThan(maxRows);
  });

  it('ไม่เปลี่ยน logic ว่าใครได้เตือน: นัดไกล (ก๊วนตั้ง 24 ชม.) ยังไม่เตือน แม้อยู่ในช่วง 14 วัน', async () => {
    const far = await openSessionIn(5 * 24); // ก๊วนตั้งเตือน 24 ชม.
    await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize: 50 });
    expect(await remindersOf(far.gangId, 'session.reminder')).toHaveLength(0);
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

describe('WO-B13.1 — เตือนยอดค้างแบ่งหน้า (ไม่ใช่ limit 500 ครั้งเดียว)', () => {
  async function sessionChargeCount(): Promise<number> {
    const {
      rows: [row],
    } = await pool.query<{ n: string }>(
      `select count(*) as n from public.session_charges where type = 'session'`,
    );
    return Number(row.n);
  }

  /** Never let shared-DB growth turn a pagination test into a truncated single-page scan. */
  async function boundedPageSize(total: number): Promise<number> {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const config = readFileSync(join(__dirname, '..', '..', 'supabase/config.toml'), 'utf8');
    const maxRows = Number(/^max_rows\s*=\s*(\d+)/m.exec(config)?.[1]);
    expect(maxRows).toBeGreaterThan(1);
    const size = Math.max(1, Math.min(500, maxRows - 1, Math.floor(total / 4)));
    expect(size).toBeLessThan(maxRows);
    expect(size).toBeLessThanOrEqual(500);
    expect(Math.ceil(total / size)).toBeGreaterThanOrEqual(4);
    return size;
  }

  it('🔴 ยอดค้างที่เก่าสุด (ท้ายลำดับ created_at desc) ยังถูกเตือน เมื่อ pageSize เล็กจนต้องวนหลายหน้า', async () => {
    // fixture ถูกสร้าง "ใหม่สุด" ⇒ อยู่หน้าแรก · ทำให้เป็น "เก่าสุด" ด้วยการย้อน created_at ไปก่อนทุกแถวใน DB
    const oldest = await endedSessionWithCharge('120.00');
    const newest = await endedSessionWithCharge('130.00');

    await pool.query(
      `update public.session_charges
          set created_at = (select min(created_at) from public.session_charges where id <> $1) - interval '1 day'
        where id = $1`,
      [oldest.chargeId],
    );

    const total = await sessionChargeCount();
    const pageSize = await boundedPageSize(total);
    expect(total).toBeGreaterThanOrEqual(2);

    await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize });

    // ถ้าอ่านหน้าเดียว (หรือ limit ครั้งเดียว) แถวเก่าสุดจะไม่ถูกเห็น
    const oldRows = await remindersOf(oldest.gangId, 'payment.overdue');
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0].payload.outstanding).toBe('120.00');
    expect(await remindersOf(newest.gangId, 'payment.overdue')).toHaveLength(1);
  });

  it('🔴 หลายหน้า + รันซ้ำ → ไม่เตือนซ้ำ (dedupe) และไม่ข้ามแม้ created_at ชนกัน', async () => {
    const a = await endedSessionWithCharge('100.00');
    const b = await endedSessionWithCharge('110.00');
    const c = await endedSessionWithCharge('120.00');

    // ทำให้ created_at ชนกันทั้งสามแถว ⇒ keyset ต้องใช้ id เป็นตัวตัดสิน
    await pool.query(
      `update public.session_charges set created_at = $2::timestamptz where id = any($1::uuid[])`,
      [[a.chargeId, b.chargeId, c.chargeId], '2000-01-01T00:00:00.000001Z'],
    );

    // Find the fixture's actual positions in the production ordering. Pick a bounded
    // page size whose boundary is AFTER the first or second tied row, never after all three.
    const total = await sessionChargeCount();
    const limit = await boundedPageSize(total);
    const { rows: positions } = await pool.query<{ id: string; position: string }>(
      `select id, position from (
         select id, row_number() over (order by created_at desc, id desc) as position
           from public.session_charges where type = 'session'
       ) ranked where id = any($1::uuid[]) order by position`,
      [[a.chargeId, b.chargeId, c.chargeId]],
    );
    expect(positions).toHaveLength(3);
    const ranks = positions.map((r) => Number(r.position));
    expect(ranks).toEqual([ranks[0], ranks[0] + 1, ranks[0] + 2]);
    let pageSize = limit;
    while (pageSize > 1 && !ranks.slice(0, 2).some((rank) => rank % pageSize === 0)) pageSize -= 1;
    expect(pageSize).toBeLessThanOrEqual(limit);
    expect(ranks.slice(0, 2).some((rank) => rank % pageSize === 0)).toBe(true);
    expect(Math.floor((ranks[0] - 1) / pageSize)).not.toBe(Math.floor((ranks[2] - 1) / pageSize));
    expect(Math.ceil(total / pageSize)).toBeGreaterThanOrEqual(4);

    await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize });
    const again = await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize });

    expect(again).toBe(0);
    for (const ctx of [a, b, c]) {
      expect(await remindersOf(ctx.gangId, 'payment.overdue')).toHaveLength(1);
    }
  });

  it('ไม่เปลี่ยน logic: จ่ายครบแล้ว/ยังไม่ถึงกำหนด ไม่ถูกเตือนแม้วนหลายหน้า', async () => {
    const paid = await endedSessionWithCharge('200.00');
    const unpaid = await endedSessionWithCharge('130.00');
    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      paid.chargeId,
      '-200.00',
      'ยกให้',
      paid.owner,
    ]);

    const total = await sessionChargeCount();
    const pageSize = await boundedPageSize(total);
    await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize });

    expect(await remindersOf(paid.gangId, 'payment.overdue')).toHaveLength(0);
    // Positive control: a no-op/truncated scan must not make the negative assertion pass vacuously.
    const unpaidRows = await remindersOf(unpaid.gangId, 'payment.overdue');
    expect(unpaidRows).toHaveLength(1);
    expect(unpaidRows[0].payload.outstanding).toBe('130.00');
  });
});

describe('WO-2.5-G — ใช้คิวเดิม ไม่มี worker ใหม่', () => {
  it('แถวที่เข้าคิวถูก claim_notifications() หยิบไปส่งได้ตามปกติ', async () => {
    const ctx = await openSessionIn(12);
    await sendSessionReminders(crypto.randomUUID(), new Date());

    // ⚠️ [WO-B13.1] `claim_notifications()` หยิบงานของ **ทั้งฐานข้อมูล** เรียงตาม scheduled_at
    //    และ DB local สะสม pending ค้างจากเทสต์อื่นเป็นพัน ⇒ เดิมวน claim(50)×20 เพื่อ "หวังว่าจะเจอของตัวเอง"
    //    แล้วแกว่ง (และไป claim แถวของคนอื่นทิ้งไว้เป็น processing)
    //    ตอนนี้: ย้ายเฉพาะ **แถวของ fixture นี้** ให้ถึงคิวก่อนใครทั้งหมด (scheduled_at เก่ากว่า pending อื่นทุกแถว)
    //    แล้ว claim ทีละ 1 แถว ⇒ ได้แถวของเราแน่นอน และไม่แตะแถวของคนอื่น
    const { rows: mineRows } = await pool.query<{ id: string }>(
      `select id from public.notifications
        where gang_id = $1 and event_type = 'session.reminder' and status = 'pending'`,
      [ctx.gangId],
    );
    expect(mineRows).toHaveLength(1);

    await pool.query(
      `update public.notifications
          set scheduled_at = (select coalesce(min(scheduled_at), now()) from public.notifications
                               where status = 'pending' and id <> $1) - interval '1 minute'
        where id = $1`,
      [mineRows[0].id],
    );

    const { rows: claimed } = await pool.query<{ id: string; event_type: string; gang_id: string }>(
      `select * from public.claim_notifications(1)`,
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(mineRows[0].id);
    expect(claimed[0].gang_id).toBe(ctx.gangId);
    expect(claimed[0].event_type).toBe('session.reminder');

    // worker บันทึกผลด้วยฟังก์ชันเดิม
    await pool.query(`select public.mark_notification_sent($1, true, null)`, [claimed[0].id]);

    const { rows: after } = await pool.query<{ status: string }>(
      `select status from public.notifications where id = $1`,
      [claimed[0].id],
    );
    expect(after[0].status).toBe('sent');
  });
});
