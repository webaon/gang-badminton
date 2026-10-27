/**
 * WO-B2 DoD (ADR-012) — ออกจากก๊วน + โอนความเป็นเจ้าของ
 *
 *   1. owner คนสุดท้าย leave ไม่ได้
 *   2. โอนให้คนนอกก๊วนไม่ได้
 *   3. member ธรรมดา (และ admin) โอนไม่ได้
 *   4. concurrency: โอน 2 ทางพร้อมกัน ⇒ ได้ owner 1 คนเสมอ
 *   5. leave แล้ว registration อนาคตถูกยกเลิก และ waitlist ถูกเลื่อน
 *   6. RLS: ออกแล้วอ่านข้อมูลก๊วนไม่ได้
 *
 * ต้องมี supabase local รันอยู่ + migration 0040
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, asRole, runConcurrently, reloadPostgrestSchema } from '../helpers/db';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`u-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function createGang(ownerId: string, opts: { features?: Record<string, boolean> } = {}) {
  const {
    rows: [gang],
  } = await pool.query<{ id: string; org_id: string }>(
    `select * from public.create_gang($1, $2)`,
    [ownerId, `ก๊วนทดสอบ-${crypto.randomUUID()}`],
  );
  if (opts.features) {
    await pool.query(
      `update public.gangs set features = features || $2::jsonb, is_public = true where id = $1`,
      [gang.id, JSON.stringify(opts.features)],
    );
  }
  return gang;
}

async function addMember(gangId: string, role: 'member' | 'admin' | 'owner' = 'member'): Promise<string> {
  const userId = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`,
    [gangId, userId, role],
  );
  return userId;
}

async function createSession(
  gangId: string,
  createdBy: string,
  opts: {
    maxPlayers?: number;
    status?: string;
    startsInHours?: number;
    cutoffHours?: number;
    allowCancelAfterCutoff?: boolean;
  } = {},
): Promise<string> {
  const {
    maxPlayers = 10,
    status = 'open',
    startsInHours = 48,
    cutoffHours = 12,
    allowCancelAfterCutoff = true,
  } = opts;

  const policy = { cutoff_hours: cutoffHours, allow_cancel_after_cutoff: allowCancelAfterCutoff };
  const snapshot = {
    snapshot_version: 1,
    cancellation_policy: policy,
    rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
    pricing_plan: { type: 'flat_rate', params: { amount_per_person: '150.00' } },
    promptpay_id: '0812345678',
  };

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, allow_guests, snapshot, created_by)
     values ($1, 'ทดสอบออกจากก๊วน', now() + ($2 || ' hours')::interval,
             now() + (($2::numeric + 2) || ' hours')::interval,
             $3, $4, false, $5::jsonb, $6)
     returning id`,
    [gangId, String(startsInHours), maxPlayers, status, JSON.stringify(snapshot), createdBy],
  );
  return session.id;
}

async function register(sessionId: string, userId: string) {
  await pool.query(`select public.register_to_session($1, $2)`, [sessionId, userId]);
}

async function regStatus(sessionId: string, userId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    `select status from public.session_registrations
      where session_id = $1 and user_id = $2 and deleted_at is null`,
    [sessionId, userId],
  );
  return rows[0]?.status;
}

async function roles(gangId: string): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ user_id: string; role: string }>(
    `select user_id, role from public.gang_members where gang_id = $1 and deleted_at is null`,
    [gangId],
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
}

async function ownerCount(gangId: string): Promise<number> {
  return Object.values(await roles(gangId)).filter((r) => r === 'owner').length;
}

const leave = (gangId: string, userId: string) =>
  pool.query<{
    leave_gang: {
      member_id: string;
      cancelled_registrations: number;
      outstanding_charges: number;
      outstanding_amount: string;
    };
  }>(
    `select public.leave_gang($1, $2, 'cid-test')`,
    [gangId, userId],
  );

const transfer = (gangId: string, actor: string, to: string) =>
  pool.query(`select public.transfer_gang_ownership($1, $2, $3, 'cid-test')`, [gangId, actor, to]);

beforeAll(async () => {
  await reloadPostgrestSchema();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// DoD 1 — owner คนสุดท้ายออกไม่ได้
// ---------------------------------------------------------------------------

describe('WO-B2 DoD 1 — owner คนสุดท้าย leave ไม่ได้', () => {
  it('owner เดี่ยว leave → VALIDATION_ERROR และยังเป็น owner อยู่', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    await addMember(gang.id);

    await expect(leave(gang.id, owner)).rejects.toThrow(/VALIDATION_ERROR/);

    expect((await roles(gang.id))[owner]).toBe('owner');
  });

  it('ก๊วนมี owner สองคน → owner คนหนึ่งออกได้ (เหลืออีกคน)', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const second = await addMember(gang.id, 'owner');

    await leave(gang.id, owner);

    const r = await roles(gang.id);
    expect(r[owner]).toBeUndefined();
    expect(r[second]).toBe('owner');
  });

  it('คนที่ไม่ใช่สมาชิก leave → NOT_GANG_MEMBER', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const stranger = await newUser();

    await expect(leave(gang.id, stranger)).rejects.toThrow(/NOT_GANG_MEMBER/);
  });

  it('ก๊วนที่ไม่มีอยู่ → NOT_FOUND', async () => {
    const user = await newUser();
    await expect(leave(crypto.randomUUID(), user)).rejects.toThrow(/NOT_FOUND/);
  });

  it('member ธรรมดา leave ได้: แถวถูก soft-delete (ไม่ลบจริง) + มี event', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const member = await addMember(gang.id);

    const { rows } = await leave(gang.id, member);
    expect(rows[0].leave_gang.cancelled_registrations).toBe(0);

    const {
      rows: [row],
    } = await pool.query<{ deleted_at: string | null; deleted_by: string | null }>(
      `select deleted_at, deleted_by from public.gang_members where gang_id = $1 and user_id = $2`,
      [gang.id, member],
    );
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(member);

    const { rows: ev } = await pool.query(
      `select payload from public.event_logs where gang_id = $1 and event_type = 'gang.member_left'`,
      [gang.id],
    );
    expect(ev).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DoD 2 + 3 — โอนให้คนนอกไม่ได้ · member/admin โอนไม่ได้
// ---------------------------------------------------------------------------

describe('WO-B2 DoD 2/3 — เงื่อนไขการโอน', () => {
  it('โอนให้คนนอกก๊วน → VALIDATION_ERROR และ role ไม่เปลี่ยน', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const outsider = await newUser();

    await expect(transfer(gang.id, owner, outsider)).rejects.toThrow(/VALIDATION_ERROR/);

    expect(await roles(gang.id)).toEqual({ [owner]: 'owner' });
  });

  it('โอนให้คนที่เคยอยู่แต่ออกไปแล้ว → VALIDATION_ERROR', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const gone = await addMember(gang.id);
    await leave(gang.id, gone);

    await expect(transfer(gang.id, owner, gone)).rejects.toThrow(/VALIDATION_ERROR/);
    expect((await roles(gang.id))[owner]).toBe('owner');
  });

  it('โอนให้ตัวเอง / ให้ owner อยู่แล้ว → VALIDATION_ERROR', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const other = await addMember(gang.id, 'owner');

    await expect(transfer(gang.id, owner, owner)).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(transfer(gang.id, owner, other)).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('🔴 member ธรรมดาโอนไม่ได้ → FORBIDDEN', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const member = await addMember(gang.id, 'member');
    const target = await addMember(gang.id, 'member');

    await expect(transfer(gang.id, member, target)).rejects.toThrow(/FORBIDDEN/);

    const r = await roles(gang.id);
    expect(r[owner]).toBe('owner');
    expect(r[member]).toBe('member');
    expect(r[target]).toBe('member');
  });

  it('🔴 admin ก็โอนไม่ได้ (เฉพาะ owner) และ owner ปลอมจากก๊วนอื่นก็ไม่ได้', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const admin = await addMember(gang.id, 'admin');
    const target = await addMember(gang.id, 'member');

    await expect(transfer(gang.id, admin, target)).rejects.toThrow(/FORBIDDEN/);

    // owner ของก๊วนอื่นยิงมาที่ก๊วนนี้ ⇒ ไม่ใช่สมาชิกของก๊วนนี้เลย
    const otherOwner = await newUser();
    await createGang(otherOwner);
    await expect(transfer(gang.id, otherOwner, target)).rejects.toThrow(/NOT_GANG_MEMBER/);

    expect((await roles(gang.id))[owner]).toBe('owner');
  });

  it('โอนสำเร็จ: ผู้รับเป็น owner · ผู้โอนเป็น admin · มี event', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const target = await addMember(gang.id, 'member');

    await transfer(gang.id, owner, target);

    const r = await roles(gang.id);
    expect(r[owner]).toBe('admin');
    expect(r[target]).toBe('owner');

    const { rows: ev } = await pool.query(
      `select payload from public.event_logs
        where gang_id = $1 and event_type = 'gang.ownership_transferred'`,
      [gang.id],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.to_user_id).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// DoD 4 — concurrency
// ---------------------------------------------------------------------------

describe('WO-B2 DoD 4 — concurrency: ได้ owner 1 คนเสมอ', () => {
  const ROUNDS = 8;

  it('🔴 owner โอนให้ B กับ C พร้อมกัน → สำเร็จใบเดียว owner = 1', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const owner = await newUser();
      const gang = await createGang(owner);
      const b = await addMember(gang.id);
      const c = await addMember(gang.id);

      const results = await runConcurrently(2, (client, idx) =>
        client.query(`select public.transfer_gang_ownership($1, $2, $3)`, [
          gang.id,
          owner,
          idx === 0 ? b : c,
        ]),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok, `round ${i}`).toHaveLength(1);
      expect(failed[0].reason.message, `round ${i}`).toMatch(/FORBIDDEN/);
      expect(await ownerCount(gang.id), `round ${i}`).toBe(1);
      expect((await roles(gang.id))[owner]).toBe('admin');
    }
  });

  it('🔴 A→B กับ B→A พร้อมกัน → owner = 1 เสมอ (ไม่ว่าใครชนะ)', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const a = await newUser();
      const gang = await createGang(a);
      const b = await addMember(gang.id);

      await runConcurrently(2, (client, idx) =>
        client.query(`select public.transfer_gang_ownership($1, $2, $3)`, [
          gang.id,
          idx === 0 ? a : b,
          idx === 0 ? b : a,
        ]),
      );

      expect(await ownerCount(gang.id), `round ${i}`).toBe(1);
    }
  });

  it('🔴 owner สองคนออกพร้อมกัน → ออกได้คนเดียว ก๊วนไม่ไร้ owner', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const a = await newUser();
      const gang = await createGang(a);
      const b = await addMember(gang.id, 'owner');

      const results = await runConcurrently(2, (client, idx) =>
        client.query(`select public.leave_gang($1, $2)`, [gang.id, idx === 0 ? a : b]),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok, `round ${i}`).toHaveLength(1);
      expect(failed[0].reason.message, `round ${i}`).toMatch(/VALIDATION_ERROR/);
      expect(await ownerCount(gang.id), `round ${i}`).toBe(1);
    }
  });

  it('🔴 owner โอน + owner ออกพร้อมกัน → owner = 1 เสมอ', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const owner = await newUser();
      const gang = await createGang(owner);
      const b = await addMember(gang.id);

      await runConcurrently(2, (client, idx) =>
        idx === 0
          ? client.query(`select public.transfer_gang_ownership($1, $2, $3)`, [gang.id, owner, b])
          : client.query(`select public.leave_gang($1, $2)`, [gang.id, owner]),
      );

      // ผลที่เป็นไปได้: โอนก่อน → ออกสำเร็จ (owner = b) · ออกก่อน → ถูกปฏิเสธ (owner เดิมยังอยู่
      // แล้วโอนสำเร็จ) — ทั้งสองทางต้องจบด้วย owner 1 คนที่ยัง active
      expect(await ownerCount(gang.id), `round ${i}`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// DoD 5 — registration อนาคต
// ---------------------------------------------------------------------------

describe('WO-B2 DoD 5 — leave ยกเลิก registration อนาคตผ่าน cancel_registration()', () => {
  it('ยกเลิกใบที่ confirmed + waitlist แล้วเลื่อนคนรอคิว · นัดที่เริ่มแล้วไม่แตะ', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const leaver = await addMember(gang.id);
    const waiter = await addMember(gang.id);
    const other = await addMember(gang.id);

    // นัด A: จุ 1 คน — leaver ถือที่, waiter รอคิว
    const sessionA = await createSession(gang.id, owner, { maxPlayers: 1, startsInHours: 72 });
    await register(sessionA, leaver);
    await register(sessionA, waiter);
    expect(await regStatus(sessionA, leaver)).toBe('confirmed');
    expect(await regStatus(sessionA, waiter)).toBe('waitlist');

    // นัด B: leaver เองอยู่ waitlist (other ถือที่)
    const sessionB = await createSession(gang.id, owner, { maxPlayers: 1, startsInHours: 96 });
    await register(sessionB, other);
    await register(sessionB, leaver);
    expect(await regStatus(sessionB, leaver)).toBe('waitlist');

    // นัด C: กำลังเล่น (in_play) — ห้ามแตะ
    const sessionC = await createSession(gang.id, owner, { status: 'in_play', startsInHours: 1 });
    await pool.query(
      `insert into public.session_registrations (session_id, user_id, status, ordering)
       values ($1, $2, 'confirmed', 0)`,
      [sessionC, leaver],
    );

    const { rows } = await leave(gang.id, leaver);
    expect(rows[0].leave_gang.cancelled_registrations).toBe(2);

    expect(await regStatus(sessionA, leaver)).toBe('cancelled');
    expect(await regStatus(sessionA, waiter)).toBe('confirmed'); // เลื่อนจาก waitlist แล้ว
    expect(await regStatus(sessionB, leaver)).toBe('cancelled');
    expect(await regStatus(sessionB, other)).toBe('confirmed');
    expect(await regStatus(sessionC, leaver)).toBe('confirmed'); // นัดที่เล่นอยู่ไม่แตะ

    // ผ่าน cancel_registration() จริง ⇒ มี event + promote (ไม่ใช่เขียน status ตรง)
    const { rows: ev } = await pool.query(
      `select event_type from public.event_logs
        where gang_id = $1 and session_id = $2
          and event_type in ('registration.cancelled', 'waitlist.promoted')`,
      [gang.id, sessionA],
    );
    expect(ev.map((e) => e.event_type).sort()).toEqual(['registration.cancelled', 'waitlist.promoted']);
  });

  it('ยกเลิกใกล้นัด (เลย cutoff) ได้ is_late_cancel = true ตาม policy เหมือนยกเลิกเอง', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const leaver = await addMember(gang.id);
    const session = await createSession(gang.id, owner, { startsInHours: 3, cutoffHours: 12 });
    await register(session, leaver);

    await leave(gang.id, leaver);

    const {
      rows: [ev],
    } = await pool.query<{ payload: { is_late_cancel: boolean } }>(
      `select payload from public.event_logs
        where session_id = $1 and event_type = 'registration.cancelled'`,
      [session],
    );
    expect(ev.payload.is_late_cancel).toBe(true);
  });

  it('🔴 ก๊วนห้ามยกเลิกหลัง cutoff → leave ล้มทั้งก้อน (CANCEL_CUTOFF_PASSED) ไม่ออกครึ่งๆ กลางๆ', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const leaver = await addMember(gang.id);
    const early = await createSession(gang.id, owner, { startsInHours: 72 });
    const blocked = await createSession(gang.id, owner, {
      startsInHours: 3,
      cutoffHours: 12,
      allowCancelAfterCutoff: false,
    });
    await register(early, leaver);
    await register(blocked, leaver);

    await expect(leave(gang.id, leaver)).rejects.toThrow(/CANCEL_CUTOFF_PASSED/);

    // atomic: ยังเป็นสมาชิก และ registration ทั้งสองใบยังอยู่ตามเดิม
    expect((await roles(gang.id))[leaver]).toBe('member');
    expect(await regStatus(early, leaver)).toBe('confirmed');
    expect(await regStatus(blocked, leaver)).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// หนี้ไม่หาย (ADR-012 ข้อ 4)
// ---------------------------------------------------------------------------

describe('WO-B2 — ยอดค้างจ่ายไม่ถูกแตะเมื่อออกจากก๊วน', () => {
  it('ไม่มีหนี้ → outstanding = 0.00', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const member = await addMember(gang.id);

    const { rows } = await leave(gang.id, member);
    expect(rows[0].leave_gang.outstanding_charges).toBe(0);
    expect(rows[0].leave_gang.outstanding_amount).toBe('0.00');
  });

  it('charge ยังอยู่ครบ · แจ้งยอดค้างตอนออก · แอดมินยังเห็น · ใบจ่ายของผู้ออกยังอ่านได้', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const leaver = await addMember(gang.id);

    const {
      rows: [m],
    } = await pool.query<{ id: string }>(
      `select id from public.gang_members where gang_id = $1 and user_id = $2`,
      [gang.id, leaver],
    );
    await pool.query(
      `insert into public.session_charges (gang_id, type, gang_member_id, billing_month, amount)
       values ($1, 'monthly_fee', $2, date_trunc('month', now())::date, 300.00)`,
      [gang.id, m.id],
    );
    await pool.query(
      `insert into public.payments (gang_id, payer_user_id, amount) values ($1, $2, 300.00)`,
      [gang.id, leaver],
    );

    const sum = () =>
      pool.query<{ n: string; total: string }>(
        `select count(*)::text n, coalesce(sum(amount), 0)::text total
           from public.session_charges where gang_id = $1`,
        [gang.id],
      );
    const before = (await sum()).rows[0];

    const { rows } = await leave(gang.id, leaver);

    // หนี้ไม่ถูกแตะ + แจ้งยอดครั้งสุดท้าย (เป็น string ไม่ใช่ number)
    expect((await sum()).rows[0]).toEqual(before);
    expect(rows[0].leave_gang.outstanding_charges).toBe(1);
    expect(rows[0].leave_gang.outstanding_amount).toBe('300.00');

    const countAs = (userId: string, table: string) =>
      asRole('authenticated', userId, async (c) => {
        const { rows: r } = await c.query<{ n: string }>(
          `select count(*)::text n from public.${table} where gang_id = $1`,
          [gang.id],
        );
        return Number(r[0].n);
      });

    // แอดมินเห็นหนี้ของคนที่ออกไปแล้ว (is_gang_admin) และใบจ่ายของเขา
    expect(await countAs(owner, 'session_charges')).toBe(1);
    expect(await countAs(owner, 'payments')).toBe(1);

    // ใบจ่ายที่ผู้ออกเป็น payer ยังอ่านได้ (payments_select ผูกกับ payer_user_id ไม่ผูกกับการเป็นสมาชิก)
    expect(await countAs(leaver, 'payments')).toBe(1);

    // ⚠️ ADR-012: รายการหนี้ (session_charges) ผู้ออกอ่านเองไม่ได้แล้ว — policy ผูกกับ gang_members /
    //    session_registrations ซึ่ง RLS ของมันเองกรองคนนอกออก ⇒ จึงต้องแจ้งยอดตอนออก (ด้านบน)
    expect(await countAs(leaver, 'session_charges')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DoD 6 — RLS
// ---------------------------------------------------------------------------

describe('WO-B2 DoD 6 — ออกแล้วอ่านข้อมูลก๊วนไม่ได้', () => {
  it('🔴 ก่อนออกอ่านได้ · หลังออก gangs / gang_members / sessions / registrations = 0 แถว', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const leaver = await addMember(gang.id);
    const session = await createSession(gang.id, owner);
    await register(session, owner);

    const count = (table: string, col: string) =>
      asRole('authenticated', leaver, async (c) => {
        const { rows } = await c.query<{ n: string }>(
          `select count(*)::text n from public.${table} where ${col} = $1`,
          [gang.id],
        );
        return Number(rows[0].n);
      });

    const probes: Array<[string, string]> = [
      ['gangs', 'id'],
      ['gang_members', 'gang_id'],
      ['sessions', 'gang_id'],
      ['event_logs', 'gang_id'],
    ];

    for (const [t, c] of probes) {
      expect(await count(t, c), `ก่อนออก ${t}`).toBeGreaterThan(0);
    }

    await leave(gang.id, leaver);

    for (const [t, c] of probes) {
      expect(await count(t, c), `หลังออก ${t}`).toBe(0);
    }

    const regs = await asRole('authenticated', leaver, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `select count(*)::text n from public.session_registrations where session_id = $1`,
        [session],
      );
      return Number(rows[0].n);
    });
    expect(regs).toBe(0);
  });

  it('ผู้ใช้ทั่วไป (authenticated/anon) เรียกฟังก์ชันสองตัวนี้ตรงๆ ไม่ได้ — service_role เท่านั้น', async () => {
    const { rows } = await pool.query<{ fn: string; role: string; ok: boolean }>(
      `select f.fn, r.role, has_function_privilege(r.role, f.sig, 'EXECUTE') as ok
         from (values
                ('leave_gang',                'public.leave_gang(uuid, uuid, text)'),
                ('transfer_gang_ownership',   'public.transfer_gang_ownership(uuid, uuid, uuid, text)')
              ) as f(fn, sig)
        cross join (values ('anon'), ('authenticated'), ('service_role')) as r(role)`,
    );

    for (const r of rows) {
      expect(r.ok, `${r.fn} → ${r.role}`).toBe(r.role === 'service_role');
    }
  });
});

// ---------------------------------------------------------------------------
// LINE + กลับเข้าก๊วน
// ---------------------------------------------------------------------------

describe('WO-B2 — LINE link ถูกลบ · กลับเข้าก๊วนผ่าน join request เดิมได้', () => {
  it('ออกแล้ว member_line_links ของก๊วนนั้นหาย (ก๊วนอื่นไม่กระทบ)', async () => {
    const owner = await newUser();
    const gang = await createGang(owner);
    const otherGang = await createGang(await newUser());
    const leaver = await addMember(gang.id);

    await pool.query(
      `insert into public.member_line_links (gang_id, user_id, line_user_id) values
         ($1, $3, $4), ($2, $3, $5)`,
      [gang.id, otherGang.id, leaver, `U${crypto.randomUUID()}`, `U${crypto.randomUUID()}`],
    );

    await leave(gang.id, leaver);

    const { rows } = await pool.query<{ gang_id: string }>(
      `select gang_id from public.member_line_links where user_id = $1`,
      [leaver],
    );
    expect(rows.map((r) => r.gang_id)).toEqual([otherGang.id]);
  });

  it('ก๊วน public + discovery: ออกแล้วขอเข้าใหม่ → แอดมินอนุมัติ → กลับมาเป็นสมาชิก (แถวเดิมถูกกู้)', async () => {
    const owner = await newUser();
    const gang = await createGang(owner, { features: { discovery: true } });
    const leaver = await addMember(gang.id);

    await leave(gang.id, leaver);

    const {
      rows: [req],
    } = await pool.query<{ id: string; status: string }>(
      `select * from public.request_to_join_gang($1, $2, 'ขอกลับเข้ามา', 'cid-test')`,
      [gang.id, leaver],
    );
    expect(req.status).toBe('pending');

    await pool.query(`select * from public.decide_join_request($1, $2, 'approved', $3, 'cid-test')`, [
      req.id,
      gang.id,
      owner,
    ]);

    const r = await roles(gang.id);
    expect(r[leaver]).toBe('member');

    const { rows } = await pool.query(
      `select id from public.gang_members where gang_id = $1 and user_id = $2`,
      [gang.id, leaver],
    );
    expect(rows).toHaveLength(1);
  });
});
