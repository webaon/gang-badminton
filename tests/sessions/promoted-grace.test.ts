/**
 * WO-B11 DoD (ADR-011) — สละสิทธิ์หลังถูกเลื่อนคิว + แอดมินเลื่อน/ยกเลิกแทนแบบไม่คิดค่าปรับ
 *
 *   1. ยกเลิกภายใน grace ⇒ ไม่มีค่าปรับ ไม่กระทบ reliability
 *   2. เกิน grace ⇒ คิดตามเดิม
 *   3. grace ไม่เกินเวลาเริ่มนัด
 *   4. นัดเก่าที่ snapshot ไม่มีคีย์ ⇒ พฤติกรรมเดิม
 *   5. แอดมินเลื่อนข้ามคิวได้ / member ทำไม่ได้
 *   6. concurrency: เลื่อนพร้อมกับมีคนยกเลิกไม่เกิน capacity
 *   7. billing ของนัดที่มีคนสละสิทธิ์ถูกต้อง
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, runConcurrently, reloadPostgrestSchema } from '../helpers/db';
import { calculateSessionCharges, type Participant } from '@/domain/billing/session-billing';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';

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

type Ctx = { gangId: string; admin: string };

async function newGang(): Promise<Ctx> {
  const admin = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select * from public.create_gang($1, $2)`, [
    admin,
    `ก๊วนทดสอบ-${crypto.randomUUID()}`,
  ]);
  return { gangId: gang.id, admin };
}

async function addMember(gangId: string, role = 'member'): Promise<string> {
  const u = await newUser();
  await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, $3)`, [
    gangId,
    u,
    role,
  ]);
  return u;
}

async function newSession(
  ctx: Ctx,
  opts: {
    maxPlayers?: number;
    startsInHours?: number;
    cutoffHours?: number;
    allowAfterCutoff?: boolean;
    /** undefined = ไม่ใส่คีย์ (นัดเก่า) */
    graceHours?: number;
  } = {},
): Promise<string> {
  const { maxPlayers = 1, startsInHours = 2, cutoffHours = 12, allowAfterCutoff = true, graceHours } = opts;
  const snapshot = {
    snapshot_version: 1,
    cancellation_policy: {
      cutoff_hours: cutoffHours,
      allow_cancel_after_cutoff: allowAfterCutoff,
      penalty_type: 'full_share',
      ...(graceHours !== undefined ? { promoted_grace_hours: graceHours } : {}),
    },
    rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
    pricing_plan: { type: 'flat_rate', params: { amount_per_person: '150.00' } },
    promptpay_id: '0812345678',
  };
  const {
    rows: [s],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, allow_guests, snapshot, created_by)
     values ($1, 'ทดสอบ grace', now() + ($2 || ' hours')::interval,
             now() + (($2::numeric + 2) || ' hours')::interval, $3, 'open', false, $4::jsonb, $5)
     returning id`,
    [ctx.gangId, String(startsInHours), maxPlayers, JSON.stringify(snapshot), ctx.admin],
  );
  return s.id;
}

async function register(sessionId: string, userId: string) {
  await pool.query(`select public.register_to_session($1, $2)`, [sessionId, userId]);
}

type Reg = { id: string; status: string; cancel_waiver: string | null; promoted_at: string | null };
async function reg(sessionId: string, userId: string): Promise<Reg> {
  const {
    rows: [r],
  } = await pool.query<Reg>(
    `select id, status, cancel_waiver, promoted_at from public.session_registrations
      where session_id = $1 and user_id = $2 and deleted_at is null`,
    [sessionId, userId],
  );
  return r;
}

const cancel = (id: string, actor: string | null = null, waive = false, reason: string | null = null, promote: string | null = null) =>
  pool.query(`select public.cancel_registration($1, $2, 'cid-test', $3, $4, $5)`, [id, actor, waive, reason, promote]);

const promote = (sessionId: string, actor: string | null, regId: string | null) =>
  pool.query(`select * from public.promote_waitlist($1, null, $2, 'cid-test', $3)`, [sessionId, actor, regId]);

const reliability = async (gangId: string, userId: string) =>
  Number(
    (await pool.query<{ r: string }>(`select public.member_reliability($1, $2) r`, [gangId, userId])).rows[0].r,
  );

async function cancelledEvent(regId: string) {
  const {
    rows: [e],
  } = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from public.event_logs where aggregate_id = $1 and event_type = 'registration.cancelled'`,
    [regId],
  );
  return e.payload;
}

/** นัดจุ 1 คน: holder ถือที่, waiter รอคิว → holder ยกเลิก → waiter ถูกเลื่อน (promoted_at = now) */
async function promotedScenario(ctx: Ctx, opts: Parameters<typeof newSession>[1] = {}) {
  const holder = await addMember(ctx.gangId);
  const waiter = await addMember(ctx.gangId);
  const session = await newSession(ctx, opts);
  await register(session, holder);
  await register(session, waiter);
  await cancel((await reg(session, holder)).id, holder);
  const w = await reg(session, waiter);
  expect(w.status).toBe('confirmed');
  expect(w.promoted_at).not.toBeNull();
  return { holder, waiter, session };
}

beforeAll(async () => {
  await reloadPostgrestSchema();
});
afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// DoD 1–4 — grace
// ---------------------------------------------------------------------------

describe('WO-B11 — grace หลังถูกเลื่อนคิว', () => {
  it('🔴 ยกเลิกภายใน grace (เลย cutoff แล้ว) ⇒ ไม่ใช่ยกเลิกช้า · ไม่กระทบ reliability', async () => {
    const ctx = await newGang();
    const { waiter, session } = await promotedScenario(ctx, { startsInHours: 2, graceHours: 3 });

    const w = await reg(session, waiter);
    await cancel(w.id, waiter);

    const after = await reg(session, waiter);
    expect(after.status).toBe('cancelled');
    expect(after.cancel_waiver).toBe('promoted_grace');

    const ev = await cancelledEvent(w.id);
    expect(ev.is_late_cancel).toBe(false);
    expect(ev.would_be_late_cancel).toBe(true);
    expect(ev.penalty_waived_by).toBe('promoted_grace');

    // ไม่มีประวัติเสีย ⇒ 1.0 (ไม่ถูกนับเป็น late cancel)
    expect(await reliability(ctx.gangId, waiter)).toBe(1);
  });

  it('เกิน grace ⇒ คิดตามเดิม: ยกเลิกช้า · ไม่มี waiver · reliability ลด', async () => {
    const ctx = await newGang();
    const { waiter, session } = await promotedScenario(ctx, { startsInHours: 2, graceHours: 3 });
    const w = await reg(session, waiter);
    await pool.query(`update public.session_registrations set promoted_at = now() - interval '4 hours' where id = $1`, [w.id]);

    await cancel(w.id, waiter);

    expect((await reg(session, waiter)).cancel_waiver).toBeNull();
    expect((await cancelledEvent(w.id)).is_late_cancel).toBe(true);
    expect(await reliability(ctx.gangId, waiter)).toBe(0);
  });

  it('🔴 grace ไม่เกินเวลาเริ่มนัด: นัดเริ่มไปแล้ว แม้เพิ่งถูกเลื่อน 1 ชม. (< 3 ชม.) ก็ยังนับว่าช้า', async () => {
    const ctx = await newGang();
    const { waiter, session } = await promotedScenario(ctx, { startsInHours: 2, graceHours: 3 });
    const w = await reg(session, waiter);
    await pool.query(
      `update public.sessions set starts_at = now() - interval '30 minutes', ends_at = now() + interval '2 hours' where id = $1`,
      [session],
    );
    await pool.query(`update public.session_registrations set promoted_at = now() - interval '1 hour' where id = $1`, [w.id]);

    await cancel(w.id, waiter);

    expect((await reg(session, waiter)).cancel_waiver).toBeNull();
    expect((await cancelledEvent(w.id)).is_late_cancel).toBe(true);
  });

  it('🔴 นัดเก่า (snapshot ไม่มี promoted_grace_hours) ⇒ พฤติกรรมเดิม: เพิ่งถูกเลื่อนก็ยังนับช้า', async () => {
    const ctx = await newGang();
    const { waiter, session } = await promotedScenario(ctx, { startsInHours: 2 /* ไม่ใส่ graceHours */ });
    const w = await reg(session, waiter);

    await cancel(w.id, waiter);

    expect((await reg(session, waiter)).cancel_waiver).toBeNull();
    expect((await cancelledEvent(w.id)).is_late_cancel).toBe(true);
  });

  it('grace = 0 ⇒ ไม่มี grace', async () => {
    const ctx = await newGang();
    const { waiter, session } = await promotedScenario(ctx, { startsInHours: 2, graceHours: 0 });
    await cancel((await reg(session, waiter)).id, waiter);
    expect((await reg(session, waiter)).cancel_waiver).toBeNull();
  });

  it('ยกเลิกก่อน cutoff ⇒ ไม่ใช่ช้าอยู่แล้ว ไม่ต้องบันทึก waiver', async () => {
    const ctx = await newGang();
    const { waiter, session } = await promotedScenario(ctx, { startsInHours: 48, graceHours: 3 });
    await cancel((await reg(session, waiter)).id, waiter);
    const after = await reg(session, waiter);
    expect(after.cancel_waiver).toBeNull();
    expect((await cancelledEvent(after.id)).is_late_cancel).toBe(false);
  });

  it('คนที่ไม่เคยถูกเลื่อน (ได้ที่ตั้งแต่ลงชื่อ) ยกเลิกหลัง cutoff ⇒ ช้าตามเดิม แม้มี grace', async () => {
    const ctx = await newGang();
    const u = await addMember(ctx.gangId);
    const session = await newSession(ctx, { startsInHours: 2, graceHours: 3, maxPlayers: 2 });
    await register(session, u);
    const r = await reg(session, u);
    expect(r.promoted_at).toBeNull();

    await cancel(r.id, u);

    expect((await cancelledEvent(r.id)).is_late_cancel).toBe(true);
    expect(await reliability(ctx.gangId, u)).toBe(0);
  });

  it('ก๊วนห้ามยกเลิกหลัง cutoff: คนที่อยู่ใน grace สละสิทธิ์ได้ (ผ่านด่าน CANCEL_CUTOFF_PASSED)', async () => {
    const ctx = await newGang();
    const holder = await addMember(ctx.gangId);
    const waiter = await addMember(ctx.gangId);
    // เริ่มอีก 48 ชม. ⇒ holder ยกเลิกก่อน cutoff ได้ → waiter ถูกเลื่อน แล้วค่อยขยับนัดให้เข้าช่วงหลัง cutoff
    const session = await newSession(ctx, { startsInHours: 48, graceHours: 3, allowAfterCutoff: false });
    await register(session, holder);
    await register(session, waiter);
    await cancel((await reg(session, holder)).id, holder);
    await pool.query(
      `update public.sessions set starts_at = now() + interval '2 hours', ends_at = now() + interval '4 hours' where id = $1`,
      [session],
    );

    await cancel((await reg(session, waiter)).id, waiter);
    expect((await reg(session, waiter)).cancel_waiver).toBe('promoted_grace');
  });

  it('allow_cancel_after_cutoff = false: คนที่ไม่ได้อยู่ใน grace ยกเลิกหลัง cutoff ไม่ได้', async () => {
    const ctx = await newGang();
    const u = await addMember(ctx.gangId);
    const session = await newSession(ctx, { startsInHours: 2, graceHours: 3, allowAfterCutoff: false, maxPlayers: 2 });
    await register(session, u);

    await expect(cancel((await reg(session, u)).id, u)).rejects.toThrow(/CANCEL_CUTOFF_PASSED/);
    expect((await reg(session, u)).status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// DoD 5 — แอดมินเลื่อนข้ามคิว / ยกเลิกแทน
// ---------------------------------------------------------------------------

describe('WO-B11 — แอดมินเลือกเลื่อนคนเอง', () => {
  async function queue(ctx: Ctx, n: number, freeSeats = 1) {
    const session = await newSession(ctx, { maxPlayers: 1, startsInHours: 48, graceHours: 3 });
    const holder = await addMember(ctx.gangId);
    await register(session, holder);
    const waiters: string[] = [];
    for (let i = 0; i < n; i++) {
      const u = await addMember(ctx.gangId);
      await register(session, u);
      waiters.push(u);
    }
    // เพิ่มที่ว่างโดยไม่ผ่านการยกเลิก (ไม่ให้ auto-promote หัวคิว)
    await pool.query(`update public.sessions set max_players = max_players + $2 where id = $1`, [session, freeSeats]);
    return { session, holder, waiters };
  }

  it('🔴 แอดมินเลื่อนคนท้ายคิวข้ามคนที่รอก่อน: ได้ที่ · คนอื่นยังรอ · promoted_at ถูกเขียน · audit บอกว่าข้ามกี่คน', async () => {
    const ctx = await newGang();
    const { session, waiters } = await queue(ctx, 3);
    const last = await reg(session, waiters[2]);

    const { rows } = await promote(session, ctx.admin, last.id);
    expect(rows).toHaveLength(1);

    const after = await reg(session, waiters[2]);
    expect(after.status).toBe('confirmed');
    expect(after.promoted_at).not.toBeNull();
    expect((await reg(session, waiters[0])).status).toBe('waitlist');
    expect((await reg(session, waiters[1])).status).toBe('waitlist');

    const { rows: ev } = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `select event_type, payload from public.event_logs
        where aggregate_id = $1 and event_type in ('waitlist.promoted', 'audit.waitlist_promoted_by_admin')`,
      [last.id],
    );
    const byType = Object.fromEntries(ev.map((e) => [e.event_type, e.payload]));
    expect(byType['waitlist.promoted'].by_admin).toBe(true);
    expect(byType['audit.waitlist_promoted_by_admin'].skipped_ahead).toBe(2);
  });

  it('🔴 member ธรรมดา / actor ว่าง / แอดมินก๊วนอื่น เลือกเลื่อนไม่ได้ → FORBIDDEN และไม่มีใครถูกเลื่อน', async () => {
    const ctx = await newGang();
    const { session, waiters } = await queue(ctx, 2);
    const target = await reg(session, waiters[1]);
    const member = await addMember(ctx.gangId);
    const otherAdmin = (await newGang()).admin;

    for (const actor of [member, null, otherAdmin]) {
      await expect(promote(session, actor, target.id), String(actor)).rejects.toThrow(/FORBIDDEN/);
    }
    expect((await reg(session, waiters[1])).status).toBe('waitlist');
  });

  it('ไม่มีที่ว่าง → SESSION_FULL · เป้าหมายไม่ได้อยู่ใน waitlist → INVALID_REGISTRATION_TRANSITION · คนละนัด → REGISTRATION_NOT_FOUND', async () => {
    const ctx = await newGang();
    const full = await queue(ctx, 1, 0);
    await expect(promote(full.session, ctx.admin, (await reg(full.session, full.waiters[0])).id)).rejects.toThrow(/SESSION_FULL/);

    const roomy = await queue(ctx, 1, 2);
    await expect(promote(roomy.session, ctx.admin, (await reg(roomy.session, roomy.holder)).id)).rejects.toThrow(
      /INVALID_REGISTRATION_TRANSITION/,
    );
    await expect(promote(roomy.session, ctx.admin, (await reg(full.session, full.waiters[0])).id)).rejects.toThrow(
      /REGISTRATION_NOT_FOUND/,
    );
  });

  it('เส้นทางอัตโนมัติ (ไม่ส่ง registration) ยังเลื่อนตามคิวเหมือนเดิม', async () => {
    const ctx = await newGang();
    const { session, waiters } = await queue(ctx, 3);
    await promote(session, null, null);
    expect((await reg(session, waiters[0])).status).toBe('confirmed');
    expect((await reg(session, waiters[1])).status).toBe('waitlist');
  });

  it('🔴 เปลี่ยนคน: ยกเลิก A แบบไม่คิดค่าปรับ + เลื่อน B (ท้ายคิว) ใน transaction เดียว — หัวคิวไม่แย่งที่', async () => {
    const ctx = await newGang();
    const a = await addMember(ctx.gangId);
    const q: string[] = [];
    const session = await newSession(ctx, { maxPlayers: 1, startsInHours: 2, graceHours: 3 });
    await register(session, a);
    for (let i = 0; i < 3; i++) {
      const u = await addMember(ctx.gangId);
      await register(session, u);
      q.push(u);
    }

    await cancel((await reg(session, a)).id, ctx.admin, true, 'A ติดธุระ แอดมินเปลี่ยนคน', (await reg(session, q[2])).id);

    const ra = await reg(session, a);
    expect(ra.status).toBe('cancelled');
    expect(ra.cancel_waiver).toBe('admin'); // เลย cutoff แล้วแต่ไม่คิดค่าปรับ
    expect((await cancelledEvent(ra.id)).is_late_cancel).toBe(false);
    expect((await reg(session, q[2])).status).toBe('confirmed');
    expect((await reg(session, q[0])).status).toBe('waitlist');
    expect(await reliability(ctx.gangId, a)).toBe(1);

    // เหตุผลอยู่ใน audit.* (admin-only) ไม่ใช่ใน event ที่สมาชิกอ่านได้
    const { rows } = await pool.query(
      `select payload from public.event_logs where aggregate_id = $1 and event_type = 'audit.registration_penalty_waived'`,
      [ra.id],
    );
    expect(rows[0].payload.reason).toBe('A ติดธุระ แอดมินเปลี่ยนคน');
    expect(JSON.stringify(await cancelledEvent(ra.id))).not.toContain('ติดธุระ');
  });

  it('เปลี่ยนคนแล้ว B เลือกไม่ได้ (ไม่ได้อยู่ใน waitlist) ⇒ ทั้งก้อน rollback: A ยังถือที่', async () => {
    const ctx = await newGang();
    const a = await addMember(ctx.gangId);
    const other = await addMember(ctx.gangId);
    const session = await newSession(ctx, { maxPlayers: 2, startsInHours: 48 });
    await register(session, a);
    await register(session, other); // confirmed ไม่ใช่ waitlist

    await expect(
      cancel((await reg(session, a)).id, ctx.admin, false, null, (await reg(session, other)).id),
    ).rejects.toThrow(/INVALID_REGISTRATION_TRANSITION/);
    expect((await reg(session, a)).status).toBe('confirmed');
  });

  it('ขอยกเว้นค่าปรับ: ไม่มีเหตุผล → VALIDATION_ERROR · ไม่ใช่แอดมิน → FORBIDDEN · ก๊วนห้ามยกเลิกหลัง cutoff แอดมินยกเว้นแล้วผ่านได้', async () => {
    const ctx = await newGang();
    const u = await addMember(ctx.gangId);
    const session = await newSession(ctx, { maxPlayers: 2, startsInHours: 2, allowAfterCutoff: false });
    await register(session, u);
    const r = await reg(session, u);

    await expect(cancel(r.id, ctx.admin, true, '   ')).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(cancel(r.id, u, true, 'ขอยกเว้นเอง')).rejects.toThrow(/FORBIDDEN/);
    await expect(cancel(r.id, u)).rejects.toThrow(/CANCEL_CUTOFF_PASSED/);
    expect((await reg(session, u)).status).toBe('confirmed');

    await cancel(r.id, ctx.admin, true, 'ฝนตก');
    expect((await reg(session, u)).cancel_waiver).toBe('admin');
  });

  it('เลือกคนเลื่อนตอนยกเลิกคนที่อยู่ waitlist → VALIDATION_ERROR (ไม่ใช่ no-op เงียบ)', async () => {
    const ctx = await newGang();
    const { session, waiters } = await queue(ctx, 2, 0);
    await expect(
      cancel((await reg(session, waiters[0])).id, ctx.admin, false, null, (await reg(session, waiters[1])).id),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('EXECUTE ของฟังก์ชันใหม่: service_role เท่านั้น และไม่มี overload เก่าเหลือ', async () => {
    const { rows } = await pool.query<{ sig: string; role: string; ok: boolean }>(
      `select p.oid::regprocedure::text sig, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('promote_waitlist', 'cancel_registration', 'actor_is_gang_admin')`,
    );
    const sigs = new Set(rows.map((r) => r.sig));
    expect([...sigs].filter((s) => s.startsWith('promote_waitlist'))).toHaveLength(1);
    expect([...sigs].filter((s) => s.startsWith('cancel_registration('))).toHaveLength(1);
    for (const r of rows) expect(r.ok, `${r.sig} → ${r.role}`).toBe(r.role === 'service_role');
  });
});

// ---------------------------------------------------------------------------
// DoD 6 — concurrency
// ---------------------------------------------------------------------------

describe('WO-B11 — concurrency: เลื่อนพร้อมกับมีคนยกเลิกไม่เกิน capacity', () => {
  it('🔴 แอดมินเลือกเลื่อน 2 คน + เส้นทางอัตโนมัติ พร้อมกัน บนที่ว่าง 1 ที่ ⇒ ได้ที่เดียว ไม่ overbook', async () => {
    for (let round = 0; round < 8; round++) {
      const ctx = await newGang();
      const session = await newSession(ctx, { maxPlayers: 4, startsInHours: 48 });
      for (let i = 0; i < 3; i++) await register(session, await addMember(ctx.gangId));
      const w: string[] = [];
      for (let i = 0; i < 3; i++) {
        const u = await addMember(ctx.gangId);
        await register(session, u);
        w.push(u);
      }
      const ids = [(await reg(session, w[1])).id, (await reg(session, w[2])).id];

      const results = await runConcurrently(3, (c, i) =>
        i < 2
          ? c.query(`select * from public.promote_waitlist($1, null, $2, 'cid', $3)`, [session, ctx.admin, ids[i]])
          : c.query(`select * from public.promote_waitlist($1)`, [session]),
      );

      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text n from public.session_registrations
          where session_id = $1 and status in ('confirmed', 'checked_in') and deleted_at is null`,
        [session],
      );
      expect(Number(rows[0].n), `round ${round}`).toBe(4);

      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason.message, `round ${round}`).toMatch(/SESSION_FULL/);
      }
    }
  });

  it('🔴 คนยกเลิกพร้อมแอดมินเลือกเลื่อน ⇒ confirmed ไม่เกิน max_players', async () => {
    for (let round = 0; round < 8; round++) {
      const ctx = await newGang();
      const session = await newSession(ctx, { maxPlayers: 2, startsInHours: 48 });
      const holders = [await addMember(ctx.gangId), await addMember(ctx.gangId)];
      for (const h of holders) await register(session, h);
      const w = [await addMember(ctx.gangId), await addMember(ctx.gangId)];
      for (const u of w) await register(session, u);
      const holderRegs = [await reg(session, holders[0]), await reg(session, holders[1])];
      const target = await reg(session, w[1]);

      await runConcurrently(3, (c, i) =>
        i === 0
          ? c.query(`select public.cancel_registration($1)`, [holderRegs[0].id])
          : i === 1
            ? c.query(`select public.cancel_registration($1)`, [holderRegs[1].id])
            : c.query(`select * from public.promote_waitlist($1, null, $2, 'cid', $3)`, [session, ctx.admin, target.id]),
      );

      const { rows } = await pool.query<{ n: string }>(
        `select count(*)::text n from public.session_registrations
          where session_id = $1 and status in ('confirmed', 'checked_in') and deleted_at is null`,
        [session],
      );
      expect(Number(rows[0].n), `round ${round}`).toBeLessThanOrEqual(2);
      expect(Number(rows[0].n), `round ${round}`).toBe(2); // ว่าง 2 ที่ คนรอ 2 คน ⇒ เต็มพอดี
    }
  });
});

// ---------------------------------------------------------------------------
// DoD 7 — billing
// ---------------------------------------------------------------------------

describe('WO-B11 — billing ของนัดที่มีคนสละสิทธิ์', () => {
  it('🔴 คนที่ได้รับการยกเว้น (grace / แอดมิน) ไม่ถูกเก็บ · คนยกเลิกช้าธรรมดายังถูกเก็บ', async () => {
    const ctx = await newGang();
    const u1 = await addMember(ctx.gangId); // มาเล่น
    const u3 = await addMember(ctx.gangId); // ยกเลิกช้า (ไม่ได้รับการยกเว้น)
    const w2 = await addMember(ctx.gangId); // ถูกเลื่อน → สละสิทธิ์ใน grace
    const w4 = await addMember(ctx.gangId); // ถูกเลื่อน → แอดมินยกเลิกแทนไม่คิดค่าปรับ

    const session = await newSession(ctx, { maxPlayers: 2, startsInHours: 2, graceHours: 3 });
    await register(session, u1);
    await register(session, u3);
    await register(session, w2);
    await register(session, w4);

    await pool.query(`select public.check_in_registration($1, $2)`, [(await reg(session, u1)).id, ctx.admin]);
    await cancel((await reg(session, u3)).id, u3); // ช้า → w2 ถูกเลื่อน
    await cancel((await reg(session, w2)).id, w2); // ใน grace → w4 ถูกเลื่อน
    await cancel((await reg(session, w4)).id, ctx.admin, true, 'แอดมินยกเว้น');

    const {
      rows: [snap],
    } = await pool.query<{ snapshot: { cancellation_policy: unknown } }>(
      `select snapshot from public.sessions where id = $1`,
      [session],
    );
    const { rows } = await pool.query<{ id: string; status: string; cancelled_at: string | null; cancel_waiver: string | null }>(
      `select id, status, cancelled_at, cancel_waiver from public.session_registrations
        where session_id = $1 and deleted_at is null`,
      [session],
    );
    const startsAt = new Date(
      (await pool.query<{ s: string }>(`select starts_at s from public.sessions where id = $1`, [session])).rows[0].s,
    );

    // สร้าง Participant จากแถวจริงใน DB แบบเดียวกับ server/actions/billing.ts
    const participants: Participant[] = rows.map((r) => ({
      registrationId: r.id,
      status: r.status as Participant['status'],
      cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : null,
      cancelPenaltyWaived: r.cancel_waiver !== null,
      isMonthlyMember: false,
    }));

    const result = calculateSessionCharges({
      snapshot: {
        pricingType: 'flat_rate',
        amountPerPerson: '150.00',
        cancellationPolicy: policyFromJson(snap.snapshot.cancellation_policy),
      },
      participants,
      startsAt,
    });

    const payers = new Map(result.charges.map((c) => [c.registrationId, c]));
    expect(payers.size).toBe(2);
    expect(payers.get((await reg(session, u1)).id)?.amount).toBe('150.00');
    expect(payers.get((await reg(session, u3)).id)?.breakdown.reason).toBe('late_cancel');
    expect(payers.has((await reg(session, w2)).id)).toBe(false);
    expect(payers.has((await reg(session, w4)).id)).toBe(false);
    expect(result.totalCollected).toBe('300.00');
  });
});
