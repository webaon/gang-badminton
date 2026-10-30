/**
 * WO-R4 DoD — waitlist.promoted + payment.due ส่งถึง LINE · session.opened = in_app เท่านั้น
 *
 *   · ทุกเหตุการณ์เข้าคิวผ่าน enqueue_notifications() ทางเดียว (ไม่มี insert ตรง)
 *   · waitlist.promoted (อัตโนมัติ + แอดมินเลือก B11) / payment.due ⇒ in_app + line ครั้งเดียว (dedupe)
 *   · session.opened ⇒ in_app เท่านั้น (บังคับที่ DB)
 *   · ก๊วนไม่ผูก LINE / คนไม่ผูกบัญชี ⇒ ไม่มีแถว line
 *   · หนี้ที่เครดิตหักจนเหลือ 0 ⇒ ไม่มี payment.due (ADR-010)
 *   · concurrency: promote/cancel พร้อมกัน ไม่ overbook ไม่ 40P01 และแจ้งเตือนต่อใบลงชื่อ = 1 ชุดเสมอ
 *   · worker ส่งข้อความจริงผ่าน mock LINE API
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { pool, runConcurrently, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { lineMessageFor } from '@/domain/notifications/line-message';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const line = vi.hoisted(() => ({ pushTextMessage: vi.fn(async () => undefined) }));
vi.mock('@/lib/line/client', () => line);

const { dispatchNotifications } = await import('@/server/cron/notifications');

const TOKEN = 'ACCESS-TOKEN-r4-1234567890abcdefWXYZ';
const SECRET = 'channel-secret-r4-abcdef123456';

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`r4-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

type Gang = { gangId: string; owner: string };

async function newGang(opts: { line?: boolean } = {}): Promise<Gang> {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-r4-${crypto.randomUUID()}`,
  ]);
  if (opts.line ?? true) {
    await pool.query(`select public.set_gang_line_credentials($1, $2, $3, null, $4)`, [
      gang.id,
      TOKEN,
      SECRET,
      owner,
    ]);
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gang.id, owner]);
  }
  return { gangId: gang.id, owner };
}

let lineSeq = 0;

async function addMember(gangId: string, opts: { link?: boolean } = {}) {
  const userId = await newUser();
  const memberId = (
    await pool.query<{ id: string }>(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member') returning id`,
      [gangId, userId],
    )
  ).rows[0].id;
  const lineUserId = `U-r4-${crypto.randomUUID().slice(0, 8)}-${lineSeq++}`;
  if (opts.link) {
    await pool.query(`select public.link_line_account($1, $2, $3)`, [gangId, userId, lineUserId]);
  }
  return { userId, memberId, lineUserId };
}

const SNAPSHOT = {
  snapshot_version: 1,
  pricing_plan: { id: null, name: 'เหมาจ่าย', type: 'flat_rate', params: { amount_per_person: '150.00' } },
  rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
  promptpay_id: '0812345678',
  cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' },
  skill_levels: [],
};

async function openSession(g: Gang, maxPlayers: number, title = 'ซ้อมวันพุธ'): Promise<string> {
  const {
    rows: [s],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, $2, now() + interval '48 hours', now() + interval '50 hours', $3, $4::jsonb, $5) returning id`,
    [g.gangId, title, maxPlayers, JSON.stringify(SNAPSHOT), g.owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [s.id, g.owner]);
  return s.id;
}

const register = async (sessionId: string, userId: string) =>
  (
    await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [sessionId, userId])
  ).rows[0].id;

type Notif = { channel: string; event_type: string; recipient_id: string; dedupe_key: string | null; payload: Record<string, unknown> };

const notifs = async (gangId: string, eventType: string): Promise<Notif[]> =>
  (
    await pool.query<Notif>(
      `select channel, event_type, recipient_id, dedupe_key, payload from public.notifications
        where gang_id = $1 and event_type = $2 order by channel, recipient_id`,
      [gangId, eventType],
    )
  ).rows;

const channelsOf = (rows: Notif[], userId: string) =>
  rows.filter((r) => r.recipient_id === userId).map((r) => r.channel).sort();

// ---------------------------------------------------------------------------
// waitlist.promoted
// ---------------------------------------------------------------------------

describe('WO-R4 — waitlist.promoted ⇒ in_app + line ครั้งเดียว', () => {
  async function fullSessionWithQueue(g: Gang, waiterOpts: { link?: boolean }) {
    const session = await openSession(g, 1);
    const holder = await addMember(g.gangId);
    const waiter = await addMember(g.gangId, waiterOpts);
    const holderReg = await register(session, holder.userId);
    const waiterReg = await register(session, waiter.userId);
    return { session, holder, waiter, holderReg, waiterReg };
  }

  it('🔴 อัตโนมัติ (ผู้ถือที่ยกเลิก): ผู้ถูกเลื่อนได้ in_app + line · คีย์ <เดิม> / <เดิม>:line · payload มีชื่อนัด', async () => {
    const g = await newGang();
    const t = await fullSessionWithQueue(g, { link: true });
    expect(await notifs(g.gangId, 'waitlist.promoted')).toHaveLength(0);

    await pool.query(`select public.cancel_registration($1, $2)`, [t.holderReg, t.holder.userId]);

    const rows = await notifs(g.gangId, 'waitlist.promoted');
    expect(rows).toHaveLength(2);
    expect(channelsOf(rows, t.waiter.userId)).toEqual(['in_app', 'line']);
    expect(rows.find((r) => r.channel === 'in_app')!.dedupe_key).toBe(`waitlist.promoted:${t.waiterReg}`);
    expect(rows.find((r) => r.channel === 'line')!.dedupe_key).toBe(`waitlist.promoted:${t.waiterReg}:line`);
    expect(rows[0].payload).toMatchObject({ session_id: t.session, registration_id: t.waiterReg, session_title: 'ซ้อมวันพุธ' });
  });

  it('🔴 แอดมินเลือกเลื่อนเอง (B11): ได้ in_app + line ครั้งเดียว · เรียกซ้ำไม่เกิดแถวซ้ำ', async () => {
    const g = await newGang();
    const session = await openSession(g, 2);
    const a = await addMember(g.gangId);
    const b = await addMember(g.gangId);
    await register(session, a.userId);
    await register(session, b.userId);
    const w1 = await addMember(g.gangId, { link: true });
    const w2 = await addMember(g.gangId, { link: true });
    await register(session, w1.userId);
    const w2Reg = await register(session, w2.userId);
    // เพิ่มที่ว่างโดยไม่ผ่านการยกเลิก (ไม่ให้ auto-promote หัวคิว)
    await pool.query(`update public.sessions set max_players = 3 where id = $1`, [session]);

    await pool.query(`select * from public.promote_waitlist($1, null, $2, 'cid', $3)`, [session, g.owner, w2Reg]);

    const rows = await notifs(g.gangId, 'waitlist.promoted');
    expect(channelsOf(rows, w2.userId)).toEqual(['in_app', 'line']);
    expect(channelsOf(rows, w1.userId)).toEqual([]); // หัวคิวที่ถูกข้ามยังไม่ได้ที่ ⇒ ไม่มีแจ้งเตือน

    // เป้าหมายอยู่ confirmed แล้ว ⇒ เลื่อนซ้ำไม่ได้ และไม่เพิ่มแถว
    await expect(
      pool.query(`select * from public.promote_waitlist($1, null, $2, 'cid', $3)`, [session, g.owner, w2Reg]),
    ).rejects.toThrow();
    expect(await notifs(g.gangId, 'waitlist.promoted')).toHaveLength(2);
  });

  it('คนที่ไม่ผูก LINE → ได้เฉพาะ in_app · ก๊วนที่ไม่ได้ตั้ง LINE เลย → ไม่มีแถว line', async () => {
    const withLine = await newGang();
    const t1 = await fullSessionWithQueue(withLine, { link: false });
    await pool.query(`select public.cancel_registration($1, $2)`, [t1.holderReg, t1.holder.userId]);
    expect(channelsOf(await notifs(withLine.gangId, 'waitlist.promoted'), t1.waiter.userId)).toEqual(['in_app']);

    const noLine = await newGang({ line: false });
    const t2 = await fullSessionWithQueue(noLine, { link: false });
    await pool.query(`select public.cancel_registration($1, $2)`, [t2.holderReg, t2.holder.userId]);
    const rows = await notifs(noLine.gangId, 'waitlist.promoted');
    expect(rows.map((r) => r.channel)).toEqual(['in_app']);
  });

  it('guest ถูกเลื่อน → ไม่มีแจ้งเตือน (ไม่มีบัญชี) เหมือนเดิม และเลื่อนสำเร็จ', async () => {
    const g = await newGang();
    const session = await openSession(g, 1);
    const holder = await addMember(g.gangId);
    const holderReg = await register(session, holder.userId);
    const {
      rows: [guest],
    } = await pool.query<{ id: string }>(
      `insert into public.session_registrations (session_id, guest_name, status, ordering, created_by)
       values ($1, 'แขก', 'waitlist', 1, $2) returning id`,
      [session, g.owner],
    );

    await pool.query(`select public.cancel_registration($1, $2)`, [holderReg, holder.userId]);

    const { rows } = await pool.query<{ status: string }>(`select status from public.session_registrations where id = $1`, [guest.id]);
    expect(rows[0].status).toBe('confirmed');
    expect(await notifs(g.gangId, 'waitlist.promoted')).toHaveLength(0);
  });

  it('🔴 concurrency: ยกเลิก 4 คนพร้อมกัน ×10 รอบ — ไม่ overbook · ไม่ 40P01 · ผู้ถูกเลื่อนแต่ละคนได้ in_app+line ชุดเดียว', async () => {
    for (let round = 0; round < 10; round++) {
      const g = await newGang();
      const session = await openSession(g, 4);
      const holders: { userId: string; reg: string }[] = [];
      for (let i = 0; i < 4; i++) {
        const m = await addMember(g.gangId);
        holders.push({ userId: m.userId, reg: await register(session, m.userId) });
      }
      const waiters: string[] = [];
      for (let i = 0; i < 4; i++) {
        const m = await addMember(g.gangId, { link: true });
        await register(session, m.userId);
        waiters.push(m.userId);
      }

      const results = await runConcurrently(4, (c, i) =>
        c.query(`select public.cancel_registration($1, $2)`, [holders[i].reg, holders[i].userId]),
      );
      for (const r of results) {
        expect(r.status, `round ${round}`).toBe('fulfilled');
      }

      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text n from public.session_registrations
          where session_id = $1 and status in ('confirmed', 'checked_in') and deleted_at is null`,
        [session],
      );
      expect(Number(rows[0].n), `round ${round}`).toBe(4);

      const promoted = await notifs(g.gangId, 'waitlist.promoted');
      expect(promoted, `round ${round}`).toHaveLength(8);
      for (const w of waiters) expect(channelsOf(promoted, w), `round ${round}`).toEqual(['in_app', 'line']);
    }
  });
});

// ---------------------------------------------------------------------------
// payment.due + session.opened
// ---------------------------------------------------------------------------

async function playedAndClosed(g: Gang, people: string[], amounts: string[] = []) {
  const {
    rows: [s],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'นัดที่จบแล้ว', now() - interval '3 hours', now() - interval '1 hour', $2, $3::jsonb, $4) returning id`,
    [g.gangId, people.length + 2, JSON.stringify(SNAPSHOT), g.owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [s.id, g.owner]);
  const regs: string[] = [];
  for (const u of people) {
    const reg = await register(s.id, u);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg, g.owner]);
    regs.push(reg);
  }
  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [s.id, g.owner]);
  await pool.query(`select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`, [
    s.id,
    JSON.stringify(regs.map((id, i) => ({ registration_id: id, amount: amounts[i] ?? '150.00', breakdown: {} }))),
    g.owner,
  ]);
  return s.id;
}

const notifySession = async (sessionId: string, event: string, audience: string) =>
  (
    await pool.query<{ n: number }>(`select public.enqueue_session_notification($1, $2, $3) n`, [
      sessionId,
      event,
      audience,
    ])
  ).rows[0].n;

describe('WO-R4 — payment.due ⇒ in_app + line · session.opened ⇒ in_app เท่านั้น', () => {
  it('🔴 payment.due: คนที่ผูก LINE ได้ in_app + line · คนไม่ผูกได้ in_app · เรียกซ้ำไม่เกิดแถวซ้ำ · คนที่ amount 0 ไม่ได้', async () => {
    const g = await newGang();
    const linked = await addMember(g.gangId, { link: true });
    const plain = await addMember(g.gangId);
    const free = await addMember(g.gangId, { link: true });
    const sessionId = await playedAndClosed(g, [linked.userId, plain.userId, free.userId], ['150.00', '150.00', '0.00']);

    expect(await notifySession(sessionId, 'payment.due', 'charged')).toBe(3); // linked ×2 + plain ×1
    const rows = await notifs(g.gangId, 'payment.due');
    expect(channelsOf(rows, linked.userId)).toEqual(['in_app', 'line']);
    expect(channelsOf(rows, plain.userId)).toEqual(['in_app']);
    expect(channelsOf(rows, free.userId)).toEqual([]);
    expect(rows.find((r) => r.recipient_id === linked.userId && r.channel === 'line')!.dedupe_key).toBe(
      `payment.due:${sessionId}:${linked.userId}:line`,
    );

    // เรียกซ้ำ (retry) ⇒ ไม่เกิดแถวใหม่
    expect(await notifySession(sessionId, 'payment.due', 'charged')).toBe(0);
    expect(await notifs(g.gangId, 'payment.due')).toHaveLength(3);
  });

  it('🔴 หนี้ที่เครดิตหักจนเหลือ 0 → ไม่มี payment.due · หักบางส่วนยังได้ (ADR-010)', async () => {
    const g = await newGang();
    const paidByCredit = await addMember(g.gangId, { link: true });
    const partly = await addMember(g.gangId, { link: true });
    const noCredit = await addMember(g.gangId, { link: true });

    for (const [u, amount] of [
      [paidByCredit.userId, '200.00'],
      [partly.userId, '100.00'],
    ] as const) {
      const {
        rows: [p],
      } = await pool.query<{ id: string }>(
        `insert into public.payments (gang_id, payer_user_id, amount, created_by) values ($1, $2, 1, $3) returning id`,
        [g.gangId, u, g.owner],
      );
      await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [p.id, u]);
      await pool.query(`select public.transition_payment($1, 'verified', $2)`, [p.id, g.owner]);
      await pool.query(`select public.record_overpayment($1, $2, 'ทดสอบ', $3)`, [p.id, amount, g.owner]);
    }

    const sessionId = await playedAndClosed(g, [paidByCredit.userId, partly.userId, noCredit.userId]);
    await notifySession(sessionId, 'payment.due', 'charged');

    const rows = await notifs(g.gangId, 'payment.due');
    expect(channelsOf(rows, paidByCredit.userId)).toEqual([]); // 150 หักด้วยเครดิต 200 ⇒ ค้าง 0
    expect(channelsOf(rows, partly.userId)).toEqual(['in_app', 'line']); // เครดิต 100 < 150 ⇒ ยังค้าง 50
    expect(channelsOf(rows, noCredit.userId)).toEqual(['in_app', 'line']);
  });

  it('🔴 session.opened: ทุกคนได้ in_app เท่านั้น แม้ผูก LINE · เรียกซ้ำไม่เกิดแถวซ้ำ', async () => {
    const g = await newGang();
    const linked = await addMember(g.gangId, { link: true });
    const plain = await addMember(g.gangId);
    const sessionId = await openSession(g, 8);

    const created = await notifySession(sessionId, 'session.opened', 'gang_members');
    expect(created).toBe(3); // owner + linked + plain — ไม่มี line เลย

    const rows = await notifs(g.gangId, 'session.opened');
    expect(rows.every((r) => r.channel === 'in_app')).toBe(true);
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([g.owner, linked.userId, plain.userId].sort());
    expect(rows[0].dedupe_key).toContain(`session.opened:${sessionId}:`);

    expect(await notifySession(sessionId, 'session.opened', 'gang_members')).toBe(0);
    expect(await notifs(g.gangId, 'session.opened')).toHaveLength(3);
  });

  it('ก๊วนไม่ได้ตั้ง LINE → payment.due / session.opened ไม่มีแถว line', async () => {
    const g = await newGang({ line: false });
    const m = await addMember(g.gangId);
    const open = await openSession(g, 8);
    await notifySession(open, 'session.opened', 'gang_members');
    const sessionId = await playedAndClosed(g, [m.userId]);
    await notifySession(sessionId, 'payment.due', 'charged');

    const { rows } = await pool.query<{ channel: string }>(
      `select distinct channel from public.notifications where gang_id = $1`,
      [g.gangId],
    );
    expect(rows.map((r) => r.channel)).toEqual(['in_app']);
  });

  it('audience ที่ไม่รู้จัก / นัดไม่มีอยู่ ยัง error เดิม', async () => {
    const g = await newGang();
    const s = await openSession(g, 2);
    await expect(notifySession(s, 'x', 'ทุกคนในโลก')).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(notifySession(crypto.randomUUID(), 'x', 'gang_members')).rejects.toThrow(/NOT_FOUND/);
  });

  it('ผู้เรียก enqueue_notifications เดิม (ไม่ส่ง channels) ยัง fan-out ครบ in_app + line · ["in_app"] ตัด line · ["in_app","line"] = ทุกช่อง (regression)', async () => {
    const g = await newGang();
    const m = await addMember(g.gangId, { link: true });
    const run = async (name: string, channels?: unknown) =>
      (
        await pool.query<{ n: number }>(`select public.enqueue_notifications($1::jsonb) n`, [
          JSON.stringify([
            {
              gang_id: g.gangId,
              recipient_id: m.userId,
              event_type: 'announcement.published',
              payload: { title: 'x' },
              dedupe_key: `r4-reg:${crypto.randomUUID()}:${name}`,
              ...(channels === undefined ? {} : { channels }),
            },
          ]),
        ])
      ).rows[0].n;
    const lines = async () =>
      Number(
        (
          await pool.query<{ n: string }>(
            `select count(*)::text n from public.notifications where gang_id = $1 and channel = 'line'`,
            [g.gangId],
          )
        ).rows[0].n,
      );

    expect(await run('none')).toBe(2); // ไม่ส่ง channels = พฤติกรรมเดิม
    expect(await lines()).toBe(1);
    expect(await run('in-app-only', ['in_app'])).toBe(1);
    expect(await lines()).toBe(1); // ไม่เพิ่ม
    expect(await run('both', ['in_app', 'line'])).toBe(2);
    expect(await run('junk', 'not-an-array')).toBe(2); // ค่าที่ไม่ใช่ array = ไม่จำกัดช่อง (ไม่ error)
    expect(await lines()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// EXECUTE matrix
// ---------------------------------------------------------------------------

describe('WO-R4 — EXECUTE matrix ไม่เปลี่ยน', () => {
  it('🔴 enqueue_notifications / enqueue_session_notification / promote_waitlist: service_role เท่านั้น และไม่มี overload ซ้ำ', async () => {
    const { rows } = await pool.query<{ sig: string; fn: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text sig, p.proname fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('enqueue_notifications', 'enqueue_session_notification', 'promote_waitlist')`,
    );
    expect(new Set(rows.map((r) => r.sig)).size).toBe(3);
    for (const r of rows) expect(r.ok, `${r.sig} → ${r.role}`).toBe(r.role === 'service_role');
  });
});

// ---------------------------------------------------------------------------
// worker ส่ง LINE จริง (mock LINE API)
// ---------------------------------------------------------------------------

describe('WO-R4 — worker ส่งข้อความ LINE ของทั้งสองเหตุการณ์ได้จริง', () => {
  it('🔴 waitlist.promoted + payment.due ⇒ pushTextMessage(token, lineUserId, ข้อความจาก line-message.ts) · session.opened ไม่ถูกส่งเข้า LINE', async () => {
    const g = await newGang();
    const holder = await addMember(g.gangId);
    const waiter = await addMember(g.gangId, { link: true });
    const payer = await addMember(g.gangId, { link: true });

    // waitlist.promoted
    const session = await openSession(g, 1, 'ซ้อมวันพุธ');
    const holderReg = await register(session, holder.userId);
    await register(session, waiter.userId);
    await pool.query(`select public.cancel_registration($1, $2)`, [holderReg, holder.userId]);

    // payment.due
    const closed = await playedAndClosed(g, [payer.userId]);
    await notifySession(closed, 'payment.due', 'charged');

    // session.opened (ผู้ผูก LINE ได้ in_app เท่านั้น)
    const open = await openSession(g, 8, 'นัดใหม่');
    await notifySession(open, 'session.opened', 'gang_members');

    // worker หยิบจากคิวทั้งตาราง ⇒ ปิดคิวของก๊วนอื่นไม่ให้ปนกับเทสต์นี้ (แบบเดียวกับ notifications.test.ts)
    await pool.query(
      `update public.notifications set next_retry_at = now() + interval '10 years'
        where status = 'pending' and gang_id <> $1`,
      [g.gangId],
    );
    line.pushTextMessage.mockClear();

    for (let i = 0; i < 6; i++) {
      const r = await dispatchNotifications('r4-test', 25);
      if (r.claimed === 0) break;
    }

    const calls = line.pushTextMessage.mock.calls as unknown as [string, string, string][];
    const sentTo = (lineUserId: string) => calls.filter((c) => c[1] === lineUserId).map((c) => c[2]);

    expect(sentTo(waiter.lineUserId)).toEqual([
      lineMessageFor('waitlist.promoted', { session_title: 'ซ้อมวันพุธ' }),
    ]);
    expect(sentTo(waiter.lineUserId)[0]).toBe('คิวถึงคุณแล้ว — ได้ที่เล่นแล้ว: ซ้อมวันพุธ');
    expect(sentTo(payer.lineUserId)).toEqual([lineMessageFor('payment.due', {})]);
    expect(sentTo(payer.lineUserId)[0]).toContain('มียอดที่ต้องจ่าย');
    expect(sentTo(payer.lineUserId)[0]).not.toMatch(/\d/); // ไม่มียอดเงินในข้อความ LINE
    for (const c of calls.filter((x) => [waiter.lineUserId, payer.lineUserId].includes(x[1]))) {
      expect(c[0]).toBe(TOKEN);
    }

    // ทุกแถวของก๊วนนี้ถูกส่งสำเร็จ (in_app + line) และ session.opened ไม่มีแถว line
    const { rows } = await pool.query<{ channel: string; event_type: string; status: string }>(
      `select channel, event_type, status from public.notifications where gang_id = $1`,
      [g.gangId],
    );
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows.filter((r) => r.event_type === 'session.opened' && r.channel === 'line')).toHaveLength(0);
    expect(rows.filter((r) => r.event_type === 'waitlist.promoted').map((r) => r.channel).sort()).toEqual(['in_app', 'line']);
    expect(rows.filter((r) => r.event_type === 'payment.due').map((r) => r.channel).sort()).toEqual(['in_app', 'line']);

    const { rows: logs } = await pool.query<{ n: string }>(
      `select count(*)::text n from public.notification_logs where gang_id = $1 and channel = 'line' and success`,
      [g.gangId],
    );
    expect(Number(logs[0].n)).toBe(2);
  });
});
