/**
 * WO-2.8 — ปิดรอบเก็บเงินผ่าน `close_session_with_charges()` (ADR-001)
 *
 * เทสต์นี้ยิงที่ระดับ DB โดยใช้ **ยอดที่ `SessionBilling` คำนวณจริง**
 * ⇒ พิสูจน์ว่า domain กับ DB function ต่อกันได้ถูกต้อง ไม่ใช่แค่ต่างคนต่างถูก
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../helpers/db';
import { calculateSessionCharges, type Participant } from '@/domain/billing/session-billing';
import { DEFAULT_CANCELLATION_POLICY } from '@/domain/policies/cancellation';
import { fromSatang, sumSatang, toSatang } from '@/domain/billing/money';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`cb-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

const SNAPSHOT = {
  snapshot_version: 1,
  pricing_plan: { id: null, name: 'เหมาจ่าย', type: 'flat_rate', params: { amount_per_person: '200.00' } },
  rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' },
  promptpay_id: '0812345678',
  cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' },
  skill_levels: [],
};

/** นัดที่เล่นจบแล้ว พร้อมปิดรอบ */
async function playedSession(playerCount: number) {
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
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, snapshot, created_by)
     values ($1, 'ปิดรอบ', now() - interval '3 hours', now() - interval '1 hour', $2, $3::jsonb, $4)
     returning id`,
    [gang.id, playerCount + 5, JSON.stringify(SNAPSHOT), owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const registrations: string[] = [];
  for (let i = 0; i < playerCount; i++) {
    const u = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, u],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      u,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    registrations.push(reg.id);
  }

  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

  return { owner, gangId: gang.id, sessionId: session.id, registrations };
}

/** คิดเงินด้วย domain จริง แล้วส่งเข้า DB function */
async function closeWithBilling(
  sessionId: string,
  ownerId: string,
  expectedStatus: string,
  toStatus = 'billing',
  midwayCancelRatio?: number,
) {
  const { rows: regs } = await pool.query<{
    id: string;
    status: string;
    cancelled_at: string | null;
  }>(
    `select id, status, cancelled_at from public.session_registrations
      where session_id = $1 and deleted_at is null`,
    [sessionId],
  );

  const {
    rows: [session],
  } = await pool.query<{ starts_at: Date }>(
    `select starts_at from public.sessions where id = $1`,
    [sessionId],
  );

  const participants: Participant[] = regs.map((r) => ({
    registrationId: r.id,
    status: r.status as Participant['status'],
    cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : null,
    isMonthlyMember: false,
  }));

  const result = calculateSessionCharges({
    snapshot: {
      pricingType: 'flat_rate',
      amountPerPerson: '200.00',
      cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
    },
    participants,
    startsAt: session.starts_at,
    ...(midwayCancelRatio !== undefined ? { midwayCancelRatio } : {}),
  });

  await pool.query(
    `select public.close_session_with_charges($1, $2::jsonb, $3, $4, $5)`,
    [
      sessionId,
      JSON.stringify(
        result.charges.map((c) => ({
          registration_id: c.registrationId,
          amount: c.amount,
          breakdown: c.breakdown,
        })),
      ),
      expectedStatus,
      toStatus,
      ownerId,
    ],
  );

  return result;
}

describe('WO-2.8 — ปิดรอบปกติ', () => {
  it('charges ถูกสร้างครบทุกคน ยอดตรงกับที่ domain คำนวณ', async () => {
    const { sessionId, owner, registrations } = await playedSession(5);

    const result = await closeWithBilling(sessionId, owner, 'in_play');

    const { rows: charges } = await pool.query<{ registration_id: string; amount: string }>(
      `select registration_id, amount from public.session_charges
        where session_id = $1 and type = 'session'`,
      [sessionId],
    );

    expect(charges).toHaveLength(registrations.length);
    expect(charges.every((c) => c.amount === '200.00')).toBe(true);

    const dbTotal = sumSatang(charges.map((c) => toSatang(c.amount)));
    expect(fromSatang(dbTotal)).toBe(result.totalCollected);
  });

  it('สถานะเปลี่ยนเป็น billing พร้อมกับ charges (atomic)', async () => {
    const { sessionId, owner } = await playedSession(4);
    await closeWithBilling(sessionId, owner, 'in_play');

    const {
      rows: [session],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      sessionId,
    ]);
    expect(session.status).toBe('billing');
  });

  it('breakdown ถูกเก็บลงฐานข้อมูลจริง (reconcile ย้อนหลังได้)', async () => {
    const { sessionId, owner } = await playedSession(3);
    await closeWithBilling(sessionId, owner, 'in_play');

    const { rows } = await pool.query<{ breakdown: Record<string, unknown> }>(
      `select breakdown from public.session_charges where session_id = $1 limit 1`,
      [sessionId],
    );

    expect(rows[0].breakdown).toHaveProperty('rounding_surplus');
    expect(rows[0].breakdown).toHaveProperty('flat_rate');
    expect(rows[0].breakdown.reason).toBe('attended');
  });

  it('🔴 คนยกเลิกทันเวลาไม่มี charge · ยกเลิกช้ามี charge', async () => {
    const { sessionId, owner, registrations } = await playedSession(4);

    // ยกเลิกช้า: นัดเริ่มไปแล้ว ⇒ เลย cutoff แน่นอน
    await pool.query(
      `update public.session_registrations
          set status = 'cancelled', cancelled_at = now() where id = $1`,
      [registrations[0]],
    );
    // ยกเลิกทัน: ก่อน cutoff 12 ชม.
    await pool.query(
      `update public.session_registrations
          set status = 'cancelled',
              cancelled_at = (select starts_at - interval '2 days' from public.sessions where id = $2)
        where id = $1`,
      [registrations[1], sessionId],
    );

    await closeWithBilling(sessionId, owner, 'in_play');

    const { rows } = await pool.query<{ registration_id: string; breakdown: Record<string, string> }>(
      `select registration_id, breakdown from public.session_charges where session_id = $1`,
      [sessionId],
    );

    const byReg = new Map(rows.map((r) => [r.registration_id, r.breakdown]));
    expect(byReg.get(registrations[0])?.reason).toBe('late_cancel');
    expect(byReg.has(registrations[1])).toBe(false);
    expect(rows).toHaveLength(3); // 2 คนที่มา + 1 คนยกเลิกช้า
  });
});

describe('WO-2.8 — optimistic guard (ADR-001)', () => {
  it('🔴 expected_status ล้าสมัย → INVALID_TRANSITION และไม่มี charges เลย', async () => {
    const { sessionId, owner } = await playedSession(4);

    await expect(
      closeWithBilling(sessionId, owner, 'open'), // ของจริงคือ in_play
    ).rejects.toThrow(/INVALID_TRANSITION/);

    const { rows } = await pool.query(
      `select 1 from public.session_charges where session_id = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(0);
  });

  it('ปิดรอบซ้ำไม่ได้', async () => {
    const { sessionId, owner } = await playedSession(4);
    await closeWithBilling(sessionId, owner, 'in_play');

    await expect(closeWithBilling(sessionId, owner, 'billing')).rejects.toThrow(
      /CHARGES_ALREADY_COMMITTED/,
    );
  });
});

describe('WO-2.8 — ยกเลิกกลางคัน (in_play → cancelled)', () => {
  it('🔴 เก็บเงินบางส่วนพร้อมเปลี่ยนสถานะเป็น cancelled แบบ atomic', async () => {
    const { sessionId, owner } = await playedSession(4);

    const result = await closeWithBilling(sessionId, owner, 'in_play', 'cancelled', 0.5);

    const {
      rows: [session],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      sessionId,
    ]);
    expect(session.status).toBe('cancelled');

    const { rows: charges } = await pool.query<{ amount: string }>(
      `select amount from public.session_charges where session_id = $1`,
      [sessionId],
    );
    expect(charges).toHaveLength(4);
    expect(charges.every((c) => c.amount === '100.00')).toBe(true);
    expect(result.totalCollected).toBe('400.00');
  });

  it('ยกเลิกกลางคันแบบไม่เก็บเงิน → charges เป็น 0 แต่ยังบันทึกไว้', async () => {
    const { sessionId, owner } = await playedSession(3);
    await closeWithBilling(sessionId, owner, 'in_play', 'cancelled', 0);

    const { rows } = await pool.query<{ amount: string }>(
      `select amount from public.session_charges where session_id = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((c) => c.amount === '0.00')).toBe(true);
  });
});
