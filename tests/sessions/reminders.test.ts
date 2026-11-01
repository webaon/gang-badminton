/**
 * WO-2.5-G DoD — งานเตือน
 *
 *   · 🔴 **ไม่ส่งซ้ำ** — เตือนนัดเดิม/ยอดเดิมสองครั้งไม่ได้ (dedupe key)
 *   · เตือนค้างจ่ายเฉพาะคนที่ยังค้างจริง **หลังหัก allocations/adjustments**
 *   · เข้าคิว `notifications` เดิม — ❌ ไม่มี worker ใหม่
 *
 * เรียก **code path เดียวกับ route handler** (`runReminders`)
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
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
  /** Real fixture-scoped session/registration HTTP pages; proves cursors inside
   * the fixture stream, not global concurrency. Never synthesize response rows. */
  type RealRow = { id: string; starts_at?: string; session_id?: string; user_id?: string };
  type RealPage = { rows: RealRow[]; cursor: string | null };
  async function observeSessionPages(fixtures: { gangId: string; sessionId: string }[], pageSize: number, registrationPageSize: number, budget: number) {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const maxRows = Number(/^max_rows\s*=\s*(\d+)/m.exec(readFileSync(join(__dirname, '../../supabase/config.toml'), 'utf8'))?.[1]);
    for (const size of [pageSize, registrationPageSize]) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(maxRows);
      expect(size).toBeLessThanOrEqual(500);
    }
    const sessions: RealPage[] = [], registrations: RealPage[] = [];
    const fixtureIds = new Set(fixtures.map((f) => f.sessionId));
    const realFetch = globalThis.fetch;
    let requests = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const isSession = url.pathname === '/rest/v1/sessions';
      if (url.origin !== new URL(API_URL).origin) throw new Error('unexpected reminder HTTP origin');
      if (url.pathname === '/rest/v1/rpc/enqueue_notifications') return realFetch(input, init);
      if (!isSession && url.pathname !== '/rest/v1/session_registrations') throw new Error('unscoped reminder HTTP path');
      expect(url.searchParams.get('select')).toContain(isSession ? 'starts_at' : 'session_id');
      requests += 1;
      if (requests > budget) throw new Error('fixture session pager exceeded HTTP request budget');
      expect(Number(url.searchParams.get('limit'))).toBe(isSession ? pageSize : registrationPageSize);
      // Scope only the real session request; production derives registration IN ids itself.
      if (isSession) url.searchParams.set('gang_id', `in.(${fixtures.map((f) => f.gangId).join(',')})`);
      const request = new Request(url, new Request(input, init));
      if (isSession) expect(new URL(request.url).searchParams.get('gang_id')).toBe(`in.(${fixtures.map((f) => f.gangId).join(',')})`);
      else {
        const requested = url.searchParams.get('session_id')?.match(/[0-9a-f-]{36}/g) ?? [];
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.every((id) => fixtureIds.has(id))).toBe(true);
      }
      const response = await realFetch(request);
      if (!response.ok) throw new Error(`fixture session page HTTP ${response.status}`);
      const rows = await response.clone().json() as RealRow[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(isSession ? pageSize : registrationPageSize);
      expect(rows.every((r) => fixtureIds.has(isSession ? r.id : r.session_id!))).toBe(true);
      (isSession ? sessions : registrations).push({ rows, cursor: url.searchParams.get(isSession ? 'or' : 'id') });
      return response;
    });
    return { sessions, registrations, restore: () => {
      spy.mockRestore();
      expect(requests).toBeGreaterThan(0);
      expect(requests).toBe(sessions.length + registrations.length);
    } };
  }
  function assertSessionStream(pages: RealPage[], expected: string[]) {
    const ids = pages.flatMap((p) => p.rows.map((r) => r.id));
    expect(ids).toHaveLength(expected.length);
    expect(new Set(ids).size).toBe(expected.length);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(pages.filter((p) => p.rows.length).length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < pages.length; i += 1) {
      const last = pages[i - 1].rows.at(-1)!;
      expect(pages[i].cursor).toContain(`id.gt.${last.id}`);
      expect(pages[i].cursor).toContain(`starts_at.eq.\"${last.starts_at}\"`);
    }
  }


  /** นัดที่ "ท้ายสุด" ของลำดับ starts_at: ห่างอีก 13 วัน + ก๊วนตั้งเตือน 336 ชม. (14 วัน) */
  async function lateSession() {
    return openSessionIn(13 * 24, { reminderHours: 336 });
  }

  it('🔴 นัดที่อยู่หลังหน้าแรกหลายหน้า ยังถูกเตือน (pageSize เล็ก ⇒ ต้องวนอ่านจนหมด)', async () => {
    const early = await openSessionIn(1);
    const late = await lateSession();

    const fixtures = [early, await openSessionIn(2), await openSessionIn(3), late];
    const capture = await observeSessionPages(fixtures, 1, 500, 9);
    try {
      await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize: 1 });
      expect(await remindersOf(early.gangId, 'session.reminder')).toHaveLength(1);
      const rows = await remindersOf(late.gangId, 'session.reminder');
      expect(rows).toHaveLength(1);
      expect(rows[0].recipient_id).toBe(late.player);
      assertSessionStream(capture.sessions, fixtures.map((f) => f.sessionId));
      expect(capture.sessions).toHaveLength(5);
      expect(capture.sessions[3].rows[0].id).toBe(late.sessionId);
      console.info('[R2.3 session boundary]', { sessionPages: capture.sessions.map((p) => p.rows.map((r) => ({ id: r.id, startsAt: r.starts_at }))), registrationRequests: capture.registrations.length });
    } finally { capture.restore(); }
  });

  it('🔴 pageSize = 1 (ขอบเขตสุด) ก็ยังเตือนถูก และรันซ้ำไม่เตือนซ้ำ', async () => {
    const ctx = await openSessionIn(12);
    const fixtures = [ctx, await openSessionIn(1), await openSessionIn(2), await openSessionIn(3)];
    const capture = await observeSessionPages(fixtures, 1, 500, 18);
    try {
      await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize: 1 });
      const first = capture.sessions.length;
      const again = await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize: 1 });
      expect(again).toBe(0);
      expect(await remindersOf(ctx.gangId, 'session.reminder')).toHaveLength(1);
      expect(first).toBe(5);
      expect(capture.sessions).toHaveLength(10);
      assertSessionStream(capture.sessions.slice(0, first), fixtures.map((f) => f.sessionId));
      assertSessionStream(capture.sessions.slice(first), fixtures.map((f) => f.sessionId));
    } finally { capture.restore(); }
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

    const capture = await observeSessionPages([ctx], 1, 2, 6);
    try {
      await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize: 1, registrationPageSize: 2 });
      const rows = await remindersOf(ctx.gangId, 'session.reminder');
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((r) => r.recipient_id))).toEqual(new Set(players));
      expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(7);
      expect(capture.sessions).toHaveLength(2);
      expect(capture.registrations).toHaveLength(4);
      expect(capture.registrations.map((p) => p.rows.length)).toEqual([2, 2, 2, 1]);
      const observed = capture.registrations.flatMap((p) => p.rows);
      expect(new Set(observed.map((r) => r.id)).size).toBe(7);
      expect(new Set(observed.map((r) => r.user_id))).toEqual(new Set(players));
      for (let i = 1; i < capture.registrations.length; i += 1) {
        expect(capture.registrations[i].cursor).toBe(`gt.${capture.registrations[i - 1].rows.at(-1)!.id}`);
      }
    } finally { capture.restore(); }
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
    const positive = await openSessionIn(1);
    const capture = await observeSessionPages([far, positive], 50, 500, 2);
    try {
      await sendSessionReminders(crypto.randomUUID(), new Date(), { pageSize: 50 });
      expect(await remindersOf(far.gangId, 'session.reminder')).toHaveLength(0);
      expect(await remindersOf(positive.gangId, 'session.reminder')).toHaveLength(1);
      expect(capture.sessions).toHaveLength(1);
      expect(new Set(capture.sessions[0].rows.map((r) => r.id))).toEqual(new Set([far.sessionId, positive.sessionId]));
    } finally { capture.restore(); }
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
  type ObservedPage = { rows: { id: string; gang_id: string; created_at: string }[]; cursor: string | null };

  /** WO-R2.3: scope the REAL HTTP request, never stub/slice response rows.
   * Production joins, filters, ordering, cursor and enqueue remain unchanged. Only
   * this test's gang_id IN predicate is added, so shared writers cannot grow the
   * stream. Observe cloned REAL response pages before the production pager reads them.
   * This proves the pager's fixture-stream boundary, not global rank/churn behavior.
   */
  async function observePaymentPages(gangIds: string[], pageSize: number, requestBudget: number, afterPage?: (page: number) => Promise<void>) {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const config = readFileSync(join(__dirname, '..', '..', 'supabase/config.toml'), 'utf8');
    const maxRows = Number(/^max_rows\s*=\s*(\d+)/m.exec(config)?.[1]);
    expect(maxRows).toBeGreaterThan(1);
    expect(pageSize).toBeGreaterThan(0);
    expect(pageSize).toBeLessThan(maxRows);
    expect(pageSize).toBeLessThanOrEqual(500);
    const allowed = new Set(gangIds);
    const pages: ObservedPage[] = [];
    let requests = 0;
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== new URL(API_URL).origin) throw new Error('unexpected reminder HTTP origin');
      if (url.pathname === '/rest/v1/rpc/enqueue_notifications') return realFetch(input, init);
      if (url.pathname !== '/rest/v1/session_charges') throw new Error('unscoped reminder HTTP path');
      expect(url.searchParams.get('select')).toContain('sessions!inner');
      expect(url.searchParams.get('select')).toContain('session_registrations!inner');
      expect(url.searchParams.get('type')).toBe('eq.session');
      requests += 1;
      if (requests > requestBudget) throw new Error('fixture payment pager exceeded HTTP request budget');
      expect(Number(url.searchParams.get('limit'))).toBe(pageSize);
      url.searchParams.set('gang_id', `in.(${gangIds.join(',')})`);
      const request = new Request(url, new Request(input, init));
      expect(new URL(request.url).searchParams.get('gang_id')).toBe(`in.(${gangIds.join(',')})`);
      const response = await realFetch(request);
      if (!response.ok) throw new Error(`fixture payment page HTTP ${response.status}`);
      const rows = await response.clone().json() as ObservedPage['rows'];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(pageSize);
      expect(rows.every((row) => allowed.has(row.gang_id))).toBe(true);
      pages.push({ rows, cursor: url.searchParams.get('or') });
      await afterPage?.(pages.length);
      return response;
    });
    return { pages, restore: () => {
      spy.mockRestore();
      expect(requests).toBeGreaterThan(0);
      expect(requests).toBe(pages.length);
    } };
  }

  function assertCompletePages(pages: ObservedPage[], expectedIds: string[]) {
    const ids = pages.flatMap((page) => page.rows.map((row) => row.id));
    expect(ids).toHaveLength(expectedIds.length);
    expect(new Set(ids).size).toBe(expectedIds.length);
    expect([...ids].sort()).toEqual([...expectedIds].sort());
    expect(pages.filter((page) => page.rows.length > 0).length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < pages.length; i += 1) {
      const last = pages[i - 1].rows.at(-1)!;
      expect(pages[i].cursor).toContain(`id.lt.${last.id}`);
      expect(pages[i].cursor).toContain(`created_at.eq.\"${last.created_at}\"`);
    }
  }

  it('🔴 ยอดค้างที่เก่าสุด (ท้ายลำดับ created_at desc) ยังถูกเตือน เมื่อ pageSize เล็กจนต้องวนหลายหน้า', async () => {
    const oldest = await endedSessionWithCharge('120.00');
    const newest = await endedSessionWithCharge('130.00');
    const padding = [await endedSessionWithCharge('1.00'), await endedSessionWithCharge('2.00')];
    const fixtures = [oldest, newest, ...padding];
    await pool.query(`update public.session_charges set created_at='1990-01-01T00:00:00Z' where id=$1`, [oldest.chargeId]);
    const capture = await observePaymentPages(fixtures.map((f) => f.gangId), 1, 5);
    try {
      await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize: 1 });
      const oldRows = await remindersOf(oldest.gangId, 'payment.overdue');
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0].payload.outstanding).toBe('120.00');
      expect(await remindersOf(newest.gangId, 'payment.overdue')).toHaveLength(1);
      assertCompletePages(capture.pages, fixtures.map((f) => f.chargeId));
      expect(capture.pages).toHaveLength(5); // four real rows + terminal empty page
      expect(capture.pages[3].rows[0].id).toBe(oldest.chargeId);
    } finally { capture.restore(); }
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

    const newer = [await endedSessionWithCharge('1.00'), await endedSessionWithCharge('2.00')];
    const older = [await endedSessionWithCharge('3.00'), await endedSessionWithCharge('4.00'), await endedSessionWithCharge('5.00')];
    const fixtures = [...newer, a, b, c, ...older];
    await pool.query(`update public.session_charges set created_at='2001-01-01T00:00:00Z' where id=any($1::uuid[])`, [newer.map((f) => f.chargeId)]);
    await pool.query(`update public.session_charges set created_at='1999-01-01T00:00:00Z' where id=any($1::uuid[])`, [older.map((f) => f.chargeId)]);
    const capture = await observePaymentPages(fixtures.map((f) => f.gangId), 2, 10);
    try {
      await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize: 2 });
      const first = capture.pages.slice();
      const again = await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize: 2 });
      expect(again).toBe(0);
      for (const ctx of [a, b, c]) {
        expect(await remindersOf(ctx.gangId, 'payment.overdue')).toHaveLength(1);
      }
      assertCompletePages(first, fixtures.map((f) => f.chargeId));
      assertCompletePages(capture.pages.slice(first.length), fixtures.map((f) => f.chargeId));
      const tiedIds = new Set([a.chargeId, b.chargeId, c.chargeId]);
      const seen = first.flatMap((page, index) => page.rows.filter((r) => tiedIds.has(r.id)).map((r) => ({ ...r, page: index })));
      expect(seen).toHaveLength(3);
      expect(new Set(seen.map((r) => r.id)).size).toBe(3);
      expect(new Set(seen.map((r) => r.created_at)).size).toBe(1);
      expect(seen.every((r) => r.created_at.startsWith('2000-01-01T00:00:00.000001'))).toBe(true);
      expect(new Set(seen.map((r) => r.page)).size).toBeGreaterThan(1); // ACTUAL HTTP pages, not SQL ranks
      expect(first).toHaveLength(5);
      expect(capture.pages).toHaveLength(10); // 2 scans * (4 populated + 1 terminal), independent of shared DB size
      console.info('[WO-R2.3] observed real response boundary', {
        tied: seen.map((row) => ({ id: row.id, timestamp: row.created_at, responsePage: row.page })),
        requests: capture.pages.length,
      });
    } finally { capture.restore(); }
  });

  it('fixture insert/delete ระหว่างหน้าไม่ข้ามหรือซ้ำ charge ที่มีอยู่ตลอดช่วง', async () => {
    // A separate controlled fixture-stream churn case, NOT global concurrency coverage.
    const stable = [];
    for (let i = 0; i < 6; i += 1) stable.push(await endedSessionWithCharge('20.00'));
    const removed = await endedSessionWithCharge('30.00');
    const fixtures = [...stable, removed];
    await pool.query(`update public.session_charges set created_at='2000-01-01T00:00:00Z' where id=any($1::uuid[])`, [stable.map((f) => f.chargeId)]);
    await pool.query(`update public.session_charges set created_at='2002-01-01T00:00:00Z' where id=$1 and gang_id=$2`, [removed.chargeId, removed.gangId]);
    const inserted = crypto.randomUUID();
    let interleavings = 0;
    const capture = await observePaymentPages(fixtures.map((f) => f.gangId), 2, 4, async (page) => {
      if (page !== 1) return;
      const deleted = await pool.query<{ row: Record<string, unknown> }>(
        `delete from public.session_charges where id=$1 and gang_id=$2 returning to_jsonb(session_charges) as row`,
        [removed.chargeId, removed.gangId],
      );
      expect(deleted.rows).toHaveLength(1);
      const absent = await pool.query(`select id from public.session_charges where id=$1 and gang_id=$2`, [removed.chargeId, removed.gangId]);
      expect(absent.rows).toHaveLength(0);
      // Insert ahead of the cursor; it is intentionally deferred to the next scan.
      const created = await pool.query(`insert into public.session_charges select (jsonb_populate_record(null::public.session_charges,$1::jsonb)).* returning id`,
        [JSON.stringify({ ...deleted.rows[0].row, id: inserted, amount: 0, created_at: '2003-01-01T00:00:00Z' })]);
      expect(created.rows).toEqual([{ id: inserted }]);
      interleavings += 1;
    });
    try {
      await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize: 2 });
      expect(interleavings).toBe(1);
      assertCompletePages(capture.pages, fixtures.map((f) => f.chargeId));
      expect(capture.pages).toHaveLength(4);
      const observed = capture.pages.flatMap((p) => p.rows.map((r) => r.id));
      expect(observed).not.toContain(inserted);
      for (const fixture of stable) {
        expect(observed.filter((id) => id === fixture.chargeId)).toHaveLength(1);
        expect(await remindersOf(fixture.gangId, 'payment.overdue')).toHaveLength(1);
      }
    } finally {
      try {
        await pool.query(`delete from public.session_charges where id=$1 and gang_id=$2`, [inserted, removed.gangId]);
        const absent = await pool.query(`select id from public.session_charges where id=$1 and gang_id=$2`, [inserted, removed.gangId]);
        expect(absent.rows).toHaveLength(0);
      } finally { capture.restore(); }
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

    const padding = [await endedSessionWithCharge('1.00'), await endedSessionWithCharge('2.00')];
    const fixtures = [paid, unpaid, ...padding];
    const capture = await observePaymentPages(fixtures.map((f) => f.gangId), 1, 5);
    try {
      await sendPaymentReminders(crypto.randomUUID(), new Date(), { pageSize: 1 });
      expect(await remindersOf(paid.gangId, 'payment.overdue')).toHaveLength(0);
      // Positive control: a no-op/truncated scan must not make the negative assertion pass vacuously.
      const unpaidRows = await remindersOf(unpaid.gangId, 'payment.overdue');
      expect(unpaidRows).toHaveLength(1);
      expect(unpaidRows[0].payload.outstanding).toBe('130.00');
      assertCompletePages(capture.pages, fixtures.map((f) => f.chargeId));
      expect(capture.pages).toHaveLength(5);
    } finally { capture.restore(); }
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
