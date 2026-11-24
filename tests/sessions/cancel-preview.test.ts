/**
 * WO-B11.1 DoD — preview_cancel_registration (read-only) ต้องตรงกับ cancel_registration() จริง
 *
 *   1. ทุก outcome: free_before_cutoff / free_in_grace / penalty / blocked
 *   2. เทสต์ความสอดคล้อง: ทุกเคส preview แล้วยกเลิกจริง ⇒ ผลตรงกัน
 *   3. snapshot เก่าไม่มีคีย์ promoted_grace_hours = ไม่มี grace
 *   4. ไม่เขียนอะไรเลย (นับแถว/event ก่อนหลัง + รันใน READ ONLY transaction)
 *   5. สิทธิ์: เจ้าของใบ/แอดมินเท่านั้น · EXECUTE เฉพาะ service_role
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, reloadPostgrestSchema } from '../helpers/db';

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

async function addMember(gangId: string): Promise<string> {
  const u = await newUser();
  await pool.query(`insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`, [gangId, u]);
  return u;
}

type CaseOpts = {
  /** ผู้ลงชื่อเป็น waitlist (มีคนถือที่เต็มอยู่) */
  waitlist?: boolean;
  startsInHours: number;
  cutoffHours?: number;
  allowAfterCutoff?: boolean;
  /** undefined = snapshot เก่า ไม่มีคีย์ */
  graceHours?: number;
  /** ถูกเลื่อนมาแล้วกี่ชั่วโมงก่อน (undefined = ไม่เคยถูกเลื่อน) */
  promotedHoursAgo?: number;
};

async function setup(opts: CaseOpts) {
  const ctx = await newGang();
  const { cutoffHours = 12, allowAfterCutoff = true, graceHours } = opts;
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
  } = await pool.query<{ id: string; starts_at: Date }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, allow_guests, snapshot, created_by)
     values ($1, 'ทดสอบ preview', now() + ($2 || ' hours')::interval,
             now() + (($2::numeric + 2) || ' hours')::interval, $3, 'open', false, $4::jsonb, $5)
     returning id, starts_at`,
    [ctx.gangId, String(opts.startsInHours), opts.waitlist ? 1 : 4, JSON.stringify(snapshot), ctx.admin],
  );

  if (opts.waitlist) {
    const filler = await addMember(ctx.gangId);
    await pool.query(`select public.register_to_session($1, $2)`, [s.id, filler]);
  }
  const user = await addMember(ctx.gangId);
  await pool.query(`select public.register_to_session($1, $2)`, [s.id, user]);
  const {
    rows: [reg],
  } = await pool.query<{ id: string; status: string }>(
    `select id, status from public.session_registrations where session_id = $1 and user_id = $2`,
    [s.id, user],
  );
  expect(reg.status).toBe(opts.waitlist ? 'waitlist' : 'confirmed');

  if (opts.promotedHoursAgo !== undefined) {
    await pool.query(
      `update public.session_registrations set promoted_at = now() - ($2 || ' hours')::interval where id = $1`,
      [reg.id, String(opts.promotedHoursAgo)],
    );
  }
  return { ctx, sessionId: s.id as string, startsAt: s.starts_at, user, regId: reg.id };
}

type Preview = { outcome: string; free_until: string | null; penalty_type: string | null; reason: string };

const preview = async (regId: string, actor: string | null): Promise<Preview> =>
  (
    await pool.query<{ p: Preview }>(`select public.preview_cancel_registration($1, $2) p`, [regId, actor])
  ).rows[0].p;

/** ยกเลิกจริงแล้วสรุปเป็น outcome แบบเดียวกับ preview */
async function actualOutcome(regId: string, actor: string): Promise<string> {
  try {
    await pool.query(`select public.cancel_registration($1, $2, 'cid-test')`, [regId, actor]);
  } catch (e) {
    if (/CANCEL_CUTOFF_PASSED/.test((e as Error).message)) return 'blocked';
    throw e;
  }
  const {
    rows: [r],
  } = await pool.query<{ cancel_waiver: string | null; payload: { is_late_cancel: boolean } }>(
    `select r.cancel_waiver, e.payload
       from public.session_registrations r
       join public.event_logs e on e.aggregate_id = r.id and e.event_type = 'registration.cancelled'
      where r.id = $1`,
    [regId],
  );
  if (r.payload.is_late_cancel) return 'penalty';
  if (r.cancel_waiver === 'promoted_grace') return 'free_in_grace';
  return 'free_before_cutoff';
}

const near = (iso: string | null, expected: Date, toleranceMs = 2000) =>
  iso !== null && Math.abs(new Date(iso).getTime() - expected.getTime()) <= toleranceMs;

beforeAll(async () => {
  await reloadPostgrestSchema();
});
afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// ตาราง: preview ต้องได้ outcome ที่คาด และตรงกับการยกเลิกจริง
// ---------------------------------------------------------------------------

type Row = {
  name: string;
  opts: CaseOpts;
  outcome: string;
  reason: string;
  freeUntil?: (startsAt: Date, opts: CaseOpts, promotedAt: Date | null) => Date | null;
  penaltyType?: string;
};

const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

const CASES: Row[] = [
  {
    name: 'confirmed ก่อน cutoff → free_before_cutoff (ถึง starts_at - cutoff)',
    opts: { startsInHours: 48 },
    outcome: 'free_before_cutoff',
    reason: 'before_cutoff',
    freeUntil: (s) => hours(s, -12),
  },
  {
    name: 'confirmed หลัง cutoff ไม่เคยถูกเลื่อน → penalty (full_share)',
    opts: { startsInHours: 2, graceHours: 3 },
    outcome: 'penalty',
    reason: 'late_cancel',
    penaltyType: 'full_share',
  },
  {
    name: 'หลัง cutoff + ก๊วนห้ามยกเลิกหลัง cutoff → blocked',
    opts: { startsInHours: 2, allowAfterCutoff: false },
    outcome: 'blocked',
    reason: 'cutoff_passed',
  },
  {
    name: 'เพิ่งถูกเลื่อน (1 ชม. ก่อน) หลัง cutoff, grace 3 → free_in_grace ถึง promoted_at + 3 ชม.',
    opts: { startsInHours: 10, graceHours: 3, promotedHoursAgo: 1 },
    outcome: 'free_in_grace',
    reason: 'promoted_grace',
    freeUntil: (_s, _o, p) => hours(p!, 3),
  },
  {
    name: 'ถูกเลื่อนมาเกิน grace (4 ชม. ก่อน) หลัง cutoff → penalty',
    opts: { startsInHours: 10, graceHours: 3, promotedHoursAgo: 4 },
    outcome: 'penalty',
    reason: 'late_cancel',
    penaltyType: 'full_share',
  },
  {
    name: 'grace ถูกจำกัดที่เวลาเริ่มนัด: เริ่มอีก 1 ชม. เพิ่งเลื่อน grace 3 → free_until = starts_at',
    opts: { startsInHours: 1, graceHours: 3, promotedHoursAgo: 0 },
    outcome: 'free_in_grace',
    reason: 'promoted_grace',
    freeUntil: (s) => s,
  },
  {
    name: 'นัดเริ่มไปแล้ว แม้เพิ่งถูกเลื่อน → penalty (grace ไม่เกินเวลาเริ่ม)',
    opts: { startsInHours: -0.5, graceHours: 3, promotedHoursAgo: 0.1 },
    outcome: 'penalty',
    reason: 'late_cancel',
    penaltyType: 'full_share',
  },
  {
    name: 'snapshot เก่า (ไม่มี promoted_grace_hours) เพิ่งถูกเลื่อนหลัง cutoff → penalty ไม่มี grace',
    opts: { startsInHours: 2, promotedHoursAgo: 0 },
    outcome: 'penalty',
    reason: 'late_cancel',
    penaltyType: 'full_share',
  },
  {
    name: 'grace = 0 → ไม่มี grace',
    opts: { startsInHours: 2, graceHours: 0, promotedHoursAgo: 0 },
    outcome: 'penalty',
    reason: 'late_cancel',
    penaltyType: 'full_share',
  },
  {
    name: 'ก่อน cutoff แต่ grace ยาวกว่า → free_before_cutoff ฟรีไปถึงปลาย grace',
    opts: { startsInHours: 13, graceHours: 6, promotedHoursAgo: 0 },
    outcome: 'free_before_cutoff',
    reason: 'before_cutoff',
    freeUntil: (_s, _o, p) => hours(p!, 6), // cutoff = starts-12h = +1h · grace_until = +6h ⇒ greatest = +6h
  },
  {
    name: 'ห้ามยกเลิกหลัง cutoff แต่ยังอยู่ใน grace → free_in_grace (ไม่ blocked)',
    opts: { startsInHours: 2, allowAfterCutoff: false, graceHours: 3, promotedHoursAgo: 0 },
    outcome: 'free_in_grace',
    reason: 'promoted_grace',
    freeUntil: (s) => s,
  },
  {
    name: 'คนอยู่ waitlist (หลัง cutoff) → ฟรีเสมอ ไม่มีเส้นตาย',
    opts: { startsInHours: 2, waitlist: true, allowAfterCutoff: false },
    outcome: 'free_before_cutoff',
    reason: 'waitlist',
    freeUntil: () => null,
  },
];

describe('WO-B11.1 — preview ตรงกับ cancel_registration() ทุกเคส', () => {
  for (const c of CASES) {
    it(`${c.name}`, async () => {
      const t = await setup(c.opts);
      const promotedAt =
        c.opts.promotedHoursAgo !== undefined
          ? (
              await pool.query<{ p: Date }>(`select promoted_at p from public.session_registrations where id = $1`, [
                t.regId,
              ])
            ).rows[0].p
          : null;
      // นัดที่เริ่มไปแล้ว: ขยับ starts_at หลังสร้างได้ (ลงชื่อก่อนแล้วค่อยเลื่อนเวลา)
      const startsAt = (
        await pool.query<{ s: Date }>(`select starts_at s from public.sessions where id = $1`, [t.sessionId])
      ).rows[0].s;

      const p = await preview(t.regId, t.user);

      expect(p.outcome).toBe(c.outcome);
      expect(p.reason).toBe(c.reason);
      expect(p.penalty_type).toBe(c.penaltyType ?? null);
      if (c.freeUntil) {
        const expected = c.freeUntil(startsAt, c.opts, promotedAt);
        if (expected === null) expect(p.free_until).toBeNull();
        else expect(near(p.free_until, expected), `free_until ${p.free_until} vs ${expected.toISOString()}`).toBe(true);
      } else {
        expect(p.free_until).toBeNull();
      }
      expect(JSON.stringify(p)).not.toMatch(/amount|baht|THB/i); // ไม่คืนเงิน

      // 🔴 เทสต์ความสอดคล้อง: ยกเลิกจริงแล้วต้องได้ผลเดียวกับที่ preview บอก
      expect(await actualOutcome(t.regId, t.user), 'ผลจริงต้องตรง preview').toBe(p.outcome);
    });
  }
});

// ---------------------------------------------------------------------------
// read-only
// ---------------------------------------------------------------------------

describe('WO-B11.1 — preview ไม่เขียนอะไรเลย', () => {
  async function snapshotOfWorld(sessionId: string) {
    const [regs, events, all] = await Promise.all([
      pool.query<{ h: string }>(
        `select md5(string_agg(r::text, '|' order by r.id)) h from public.session_registrations r where session_id = $1`,
        [sessionId],
      ),
      pool.query<{ n: string }>(`select count(*)::text n from public.event_logs where session_id = $1`, [sessionId]),
      pool.query<{ n: string }>(`select count(*)::text n from public.event_logs`),
    ]);
    return { regs: regs.rows[0].h, events: events.rows[0].n, allEvents: all.rows[0].n };
  }

  it('🔴 เรียก preview ซ้ำหลายรอบ (ทุกประเภท) → แถวลงชื่อ + event ก่อนหลังเหมือนเดิมทุกไบต์', async () => {
    for (const opts of [
      { startsInHours: 48 },
      { startsInHours: 2 },
      { startsInHours: 2, allowAfterCutoff: false },
      { startsInHours: 10, graceHours: 3, promotedHoursAgo: 1 },
      { startsInHours: 2, waitlist: true },
    ] as CaseOpts[]) {
      const t = await setup(opts);
      const before = await snapshotOfWorld(t.sessionId);
      for (let i = 0; i < 3; i++) await preview(t.regId, t.user);
      await preview(t.regId, t.ctx.admin);
      const after = await snapshotOfWorld(t.sessionId);
      expect(after.regs).toBe(before.regs);
      expect(after.events).toBe(before.events);
      expect(after.allEvents).toBe(before.allEvents);
    }
  });

  it('รันใน READ ONLY transaction ได้ (พิสูจน์ว่าไม่มี write path)', async () => {
    const t = await setup({ startsInHours: 10, graceHours: 3, promotedHoursAgo: 1 });
    const c = await pool.connect();
    try {
      await c.query('begin read only');
      const {
        rows: [r],
      } = await c.query<{ p: Preview }>(`select public.preview_cancel_registration($1, $2) p`, [t.regId, t.user]);
      expect(r.p.outcome).toBe('free_in_grace');
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('ฟังก์ชันเป็น STABLE (provolatile = s) ทั้ง preview และ helper', async () => {
    const { rows } = await pool.query<{ proname: string; provolatile: string }>(
      `select proname, provolatile from pg_proc
        where pronamespace = 'public'::regnamespace and proname in ('preview_cancel_registration', 'cancel_decision')`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual(['cancel_decision', 'preview_cancel_registration']);
    for (const r of rows) expect(r.provolatile, r.proname).toBe('s');
  });
});

// ---------------------------------------------------------------------------
// สิทธิ์ + ขอบเขต
// ---------------------------------------------------------------------------

describe('WO-B11.1 — สิทธิ์และ error', () => {
  it('เจ้าของใบ/แอดมินดูได้ · member คนอื่น/actor ว่าง/แอดมินก๊วนอื่น → FORBIDDEN', async () => {
    const t = await setup({ startsInHours: 48 });
    const other = await addMember(t.ctx.gangId);
    const foreignAdmin = (await newGang()).admin;

    expect((await preview(t.regId, t.user)).outcome).toBe('free_before_cutoff');
    expect((await preview(t.regId, t.ctx.admin)).outcome).toBe('free_before_cutoff');
    for (const actor of [other, null, foreignAdmin]) {
      await expect(preview(t.regId, actor), String(actor)).rejects.toThrow(/FORBIDDEN/);
    }
  });

  it('ใบที่ยกเลิกแล้ว → INVALID_REGISTRATION_TRANSITION · ไม่มีใบ → REGISTRATION_NOT_FOUND (เหมือน cancel)', async () => {
    const t = await setup({ startsInHours: 48 });
    await pool.query(`select public.cancel_registration($1, $2)`, [t.regId, t.user]);
    await expect(preview(t.regId, t.user)).rejects.toThrow(/INVALID_REGISTRATION_TRANSITION/);
    await expect(preview(crypto.randomUUID(), t.user)).rejects.toThrow(/REGISTRATION_NOT_FOUND/);
  });

  it('EXECUTE: preview เฉพาะ service_role · cancel_decision ไม่มีใครเรียกตรงได้', async () => {
    const { rows } = await pool.query<{ fn: string; role: string; ok: boolean }>(
      `select p.proname fn, r.role, has_function_privilege(r.role, p.oid, 'EXECUTE') ok
         from pg_proc p
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('preview_cancel_registration', 'cancel_decision')`,
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      const allowed = r.fn === 'preview_cancel_registration' && r.role === 'service_role';
      expect(r.ok, `${r.fn} → ${r.role}`).toBe(allowed);
    }
  });
});
