/**
 * WO-2.4 DoD — snapshot เป็นบันทึกแช่แข็งจริง
 *
 *   🔴 "เทสต์: เปลี่ยนราคาในก๊วนหลังสร้างนัด แล้วนัดเก่าต้องยังคิดจากราคาเดิม"
 *
 * นี่คือข้อที่พังแล้วเสียหายเงียบที่สุด — ยอดของนัดเก่าจะเปลี่ยนย้อนหลังทุกครั้ง
 * ที่แก้ราคา ทำให้รายงานย้อนหลังเชื่อถือไม่ได้ และคนที่จ่ายไปแล้วกลายเป็นค้างจ่าย
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole } from '../helpers/db';
import { buildSnapshot } from '@/domain/sessions/snapshot';
import { fromJson as cancellationFromJson } from '@/domain/policies/cancellation';
import { flatRateFromJson, roundingFromJson } from '@/domain/policies/pricing';
import { zonedTimeToUtc } from '@/domain/time/timezone';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`s-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วนพร้อมแผนราคา + ระดับฝีมือ */
async function gangWithPricing(amountPerPerson = '200.00', timezone = 'Asia/Bangkok') {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(`update public.gangs set promptpay_id = '0812345678', timezone = $2 where id = $1`, [
    gang.id,
    timezone,
  ]);

  const {
    rows: [plan],
  } = await pool.query<{ id: string }>(
    `insert into public.gang_pricing_plans (gang_id, name, type, params, rounding_policy)
     values ($1, 'เหมาจ่ายต่อหัว', 'flat_rate', jsonb_build_object('amount_per_person', $2::text),
             '{"mode": "ceil_baht", "surplus_to": "gang"}'::jsonb)
     returning id`,
    [gang.id, amountPerPerson],
  );

  await pool.query(
    `insert into public.gang_skill_levels (gang_id, label, rank)
     values ($1, 'มือใหม่', 1), ($1, 'มือกลาง', 2)`,
    [gang.id],
  );

  return { owner, gangId: gang.id, planId: plan.id };
}

/** ประกอบ snapshot แบบเดียวกับที่ `createSession()` ทำ แล้ว insert นัด */
async function createSessionWithSnapshot(gangId: string, ownerId: string, localStart: string) {
  const {
    rows: [gang],
  } = await pool.query<{
    timezone: string;
    promptpay_id: string | null;
    cancellation_policy: unknown;
  }>(`select timezone, promptpay_id, cancellation_policy from public.gangs where id = $1`, [gangId]);

  const {
    rows: [plan],
  } = await pool.query<{
    id: string;
    name: string;
    type: string;
    params: unknown;
    rounding_policy: unknown;
  }>(
    `select id, name, type, params, rounding_policy from public.gang_pricing_plans
      where gang_id = $1 and is_active order by created_at desc limit 1`,
    [gangId],
  );

  const { rows: skills } = await pool.query<{ label: string; rank: number }>(
    `select label, rank from public.gang_skill_levels where gang_id = $1 order by rank`,
    [gangId],
  );

  const snapshot = buildSnapshot({
    pricingPlan: {
      id: plan.id,
      name: plan.name,
      type: plan.type as 'flat_rate',
      flatRate: flatRateFromJson(plan.params),
    },
    roundingPolicy: roundingFromJson(plan.rounding_policy),
    promptpayId: gang.promptpay_id,
    cancellationPolicy: cancellationFromJson(gang.cancellation_policy),
    skillLevels: skills,
  });

  const startsAt = zonedTimeToUtc(localStart, gang.timezone);
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

  const {
    rows: [session],
  } = await pool.query<{ id: string }>(
    `insert into public.sessions
       (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
     values ($1, 'ซ้อม', $2, $3, 8, 'draft', $4::jsonb, $5)
     returning id`,
    [gangId, startsAt.toISOString(), endsAt.toISOString(), JSON.stringify(snapshot), ownerId],
  );

  return { sessionId: session.id, snapshot, startsAt, timezone: gang.timezone };
}

describe('WO-2.4 DoD — snapshot แช่แข็งราคา', () => {
  it('🔴 ขึ้นราคาหลังสร้างนัด → นัดเก่ายังถือราคาเดิม', async () => {
    const { gangId, owner, planId } = await gangWithPricing('200.00');
    const { sessionId } = await createSessionWithSnapshot(gangId, owner, '2026-08-20T19:00');

    // ก๊วนขึ้นราคาเป็น 350
    await pool.query(
      `update public.gang_pricing_plans
          set params = '{"amount_per_person": "350.00"}'::jsonb
        where id = $1`,
      [planId],
    );

    const {
      rows: [row],
    } = await pool.query<{ snapshot: { pricing_plan: { params: Record<string, string> } } }>(
      `select snapshot from public.sessions where id = $1`,
      [sessionId],
    );

    expect(row.snapshot.pricing_plan.params.amount_per_person).toBe('200.00');

    // นัดที่สร้าง**หลัง**ขึ้นราคา ต้องได้ราคาใหม่
    const next = await createSessionWithSnapshot(gangId, owner, '2026-09-20T19:00');
    expect(next.snapshot.pricing_plan.params.amount_per_person).toBe('350.00');
  });

  it('🔴 แก้ cancellation policy ของก๊วน → นัดเก่ายังถือ policy เดิม', async () => {
    const { gangId, owner } = await gangWithPricing();
    const { sessionId } = await createSessionWithSnapshot(gangId, owner, '2026-08-20T19:00');

    await pool.query(
      `update public.gangs
          set cancellation_policy = '{"cutoff_hours": 48, "allow_cancel_after_cutoff": false, "penalty_type": "none"}'::jsonb
        where id = $1`,
      [gangId],
    );

    const {
      rows: [row],
    } = await pool.query<{ snapshot: { cancellation_policy: Record<string, unknown> } }>(
      `select snapshot from public.sessions where id = $1`,
      [sessionId],
    );

    expect(row.snapshot.cancellation_policy.cutoff_hours).toBe(12);
    expect(row.snapshot.cancellation_policy.penalty_type).toBe('full_share');
  });

  it('เปลี่ยน PromptPay ของก๊วน → นัดเก่ายังถือเลขเดิม', async () => {
    const { gangId, owner } = await gangWithPricing();
    const { sessionId } = await createSessionWithSnapshot(gangId, owner, '2026-08-20T19:00');

    await pool.query(`update public.gangs set promptpay_id = '0999999999' where id = $1`, [gangId]);

    const {
      rows: [row],
    } = await pool.query<{ snapshot: { promptpay_id: string } }>(
      `select snapshot from public.sessions where id = $1`,
      [sessionId],
    );
    expect(row.snapshot.promptpay_id).toBe('0812345678');
  });

  it('snapshot มีคีย์ครบตาม baseline §Snapshot rule', async () => {
    const { gangId, owner } = await gangWithPricing();
    const { sessionId } = await createSessionWithSnapshot(gangId, owner, '2026-08-20T19:00');

    const {
      rows: [row],
    } = await pool.query<{ snapshot: Record<string, unknown> }>(
      `select snapshot from public.sessions where id = $1`,
      [sessionId],
    );

    for (const key of [
      'snapshot_version',
      'pricing_plan',
      'rounding_policy',
      'promptpay_id',
      'cancellation_policy',
      'skill_levels',
    ]) {
      expect(row.snapshot, `ขาดคีย์ ${key}`).toHaveProperty(key);
    }
    expect(row.snapshot.snapshot_version).toBe(1);
  });
});

describe('WO-2.4 DoD — นัดใหม่เป็น draft เสมอ แล้วเปิดผ่าน transition_session', () => {
  it('นัดที่สร้างมีสถานะ draft', async () => {
    const { gangId, owner } = await gangWithPricing();
    const { sessionId } = await createSessionWithSnapshot(gangId, owner, '2026-08-20T19:00');

    const {
      rows: [row],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      sessionId,
    ]);
    expect(row.status).toBe('draft');
  });

  it('🔴 แอดมิน UPDATE status ตรงๆ ไม่ได้ ต้องผ่าน transition_session()', async () => {
    const { gangId, owner } = await gangWithPricing();
    const { sessionId } = await createSessionWithSnapshot(gangId, owner, '2026-08-20T19:00');

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`update public.sessions set status = 'open' where id = $1`, [sessionId]),
      ).rejects.toThrow(/DIRECT_STATUS_UPDATE_FORBIDDEN/);
    });

    // เส้นทางที่ถูกต้อง
    await pool.query(`select public.transition_session($1, 'open', $2)`, [sessionId, owner]);

    const {
      rows: [row],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      sessionId,
    ]);
    expect(row.status).toBe('open');
  });
});

describe('WO-2.4 — เวลาถูกเก็บตาม timezone ของก๊วน', () => {
  it('ก๊วนไทยกับก๊วน UTC กรอกเวลาเดียวกัน ได้ instant ต่างกัน 7 ชั่วโมง', async () => {
    const th = await gangWithPricing('200.00', 'Asia/Bangkok');
    const utc = await gangWithPricing('200.00', 'UTC');

    const a = await createSessionWithSnapshot(th.gangId, th.owner, '2026-08-20T19:00');
    const b = await createSessionWithSnapshot(utc.gangId, utc.owner, '2026-08-20T19:00');

    const readStart = async (id: string) => {
      const {
        rows: [row],
      } = await pool.query<{ starts_at: Date }>(
        `select starts_at from public.sessions where id = $1`,
        [id],
      );
      return row.starts_at;
    };

    const startTh = await readStart(a.sessionId);
    const startUtc = await readStart(b.sessionId);

    expect(startTh.toISOString()).toBe('2026-08-20T12:00:00.000Z');
    expect(startUtc.toISOString()).toBe('2026-08-20T19:00:00.000Z');
    expect(startUtc.getTime() - startTh.getTime()).toBe(7 * 60 * 60 * 1000);
  });
});
