/**
 * WO-5.D DoD — รัด policy อ่านที่ค้างมาตั้งแต่ Phase 3
 *
 *   · 🔴 สมาชิกทั่วไปอ่าน payload ของ event เรื่องเงิน **จาก API ตรงไม่ได้**
 *     (เดิมกรองแค่ใน `buildTimeline()` = กรองแค่หน้าจอ)
 *   · 🔴 กติกาใน SQL ต้องตรงกับ `adminOnly` ของ `domain/reports/timeline.ts` เป๊ะ
 *   · คนที่ถูกคืนเงิน **เห็นรายการของตัวเอง** ได้ แต่ของคนอื่นไม่ได้
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, visibleCount } from '../helpers/db';
import { describeEvent } from '@/domain/reports/timeline';

afterAll(async () => {
  await pool.end();
});

/**
 * event type ที่ฝั่ง domain ถือว่า `adminOnly`
 *
 * ⚠️ ดึงจาก `describeEvent()` ของจริง ไม่ใช่พิมพ์ลิสต์ซ้ำ — จุดประสงค์ของเทสต์นี้คือ
 *    จับตอนที่ **สองฝั่งเบี่ยงจากกัน** ถ้าพิมพ์ลิสต์เองก็เบี่ยงพร้อมกันได้
 */
const ADMIN_ONLY_EVENTS = [
  'payment.created',
  'payment.transitioned',
  'payment.adjusted',
  'session.charges_committed',
  'membership.fees_generated',
].filter((type) => describeEvent({ id: 'x', eventType: type, createdAt: '', actorName: null, payload: {} }).adminOnly);

const MEMBER_VISIBLE_EVENTS = ['session.transitioned', 'registration.created', 'waitlist.promoted'];

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`evt-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithMember() {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนอีเวนต์-${crypto.randomUUID()}`,
  ]);

  const member = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gang.id, member],
  );

  return { owner, member, gangId: gang.id };
}

async function logEvent(gangId: string, eventType: string, actor: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into public.event_logs (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
     values ($1, $2, 'gang', $1, $3, jsonb_build_object('amount', '1234.00'))
     returning id`,
    [gangId, eventType, actor],
  );
  return row.id;
}

describe('WO-5.D DoD — event_logs', () => {
  it('🔴 สมาชิกทั่วไปอ่าน event เรื่องเงินจาก API ตรงไม่ได้ (ทุก type ที่ domain ว่า adminOnly)', async () => {
    const ctx = await gangWithMember();
    expect(ADMIN_ONLY_EVENTS.length).toBeGreaterThan(0);

    for (const eventType of ADMIN_ONLY_EVENTS) {
      const id = await logEvent(ctx.gangId, eventType, ctx.owner);
      const sql = 'select 1 from public.event_logs where id = $1';

      expect(await visibleCount(ctx.member, sql, [id]), eventType).toBe(0);
      expect(await visibleCount(ctx.owner, sql, [id]), eventType).toBe(1);
    }
  });

  it('event ปกติของนัด สมาชิกยังเห็นได้เหมือนเดิม (ไทม์ไลน์ต้องไม่ว่างเปล่า)', async () => {
    const ctx = await gangWithMember();

    for (const eventType of MEMBER_VISIBLE_EVENTS) {
      const id = await logEvent(ctx.gangId, eventType, ctx.owner);
      expect(
        await visibleCount(ctx.member, 'select 1 from public.event_logs where id = $1', [id]),
        eventType,
      ).toBe(1);
    }
  });

  it('🔴 audit.* เป็นข้อมูลภายในเสมอ — สมาชิกไม่เห็น', async () => {
    const ctx = await gangWithMember();
    const id = await logEvent(ctx.gangId, 'audit.gang_updated', ctx.owner);

    expect(await visibleCount(ctx.member, 'select 1 from public.event_logs where id = $1', [id])).toBe(0);
  });

  it('คนนอกก๊วนไม่เห็นอะไรเลย', async () => {
    const ctx = await gangWithMember();
    const outsider = await newUser();
    const id = await logEvent(ctx.gangId, 'session.transitioned', ctx.owner);

    expect(await visibleCount(outsider, 'select 1 from public.event_logs where id = $1', [id])).toBe(0);
  });

  it('🔴 กติกาใน SQL กับ `adminOnly` ของ domain ตรงกันทุกตัว', async () => {
    for (const eventType of [...ADMIN_ONLY_EVENTS, ...MEMBER_VISIBLE_EVENTS]) {
      const {
        rows: [row],
      } = await pool.query<{ admin_only: boolean }>(
        `select public.event_type_is_admin_only($1) as admin_only`,
        [eventType],
      );

      const fromDomain = describeEvent({
        id: 'x',
        eventType,
        createdAt: '',
        actorName: null,
        payload: {},
      }).adminOnly;

      expect(row.admin_only, eventType).toBe(fromDomain);
    }
  });
});

describe('WO-5.D DoD — payment_adjustments', () => {
  /** สร้างหนี้ของสมาชิกคนหนึ่งพร้อมรายการคืนเงิน */
  async function chargeWithAdjustment() {
    const ctx = await gangWithMember();

    const {
      rows: [session],
    } = await pool.query<{ id: string }>(
      `insert into public.sessions
         (gang_id, title, starts_at, ends_at, max_players, status, snapshot, created_by)
       values ($1, 'นัดคืนเงิน', now() + interval '1 hour', now() + interval '3 hours',
               4, 'draft', '{"snapshot_version":1}'::jsonb, $2)
       returning id`,
      [ctx.gangId, ctx.owner],
    );

    await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, ctx.owner]);

    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      ctx.member,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, ctx.owner]);

    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'open', 'billing', $3)`,
      [
        session.id,
        JSON.stringify([
          { registration_id: reg.id, amount: '200.00', breakdown: { rounding_surplus: '0.00' } },
        ]),
        ctx.owner,
      ],
    );

    const {
      rows: [charge],
    } = await pool.query<{ id: string }>(
      `select id from public.session_charges where session_id = $1 limit 1`,
      [session.id],
    );

    const {
      rows: [adjustment],
    } = await pool.query<{ id: string }>(
      `insert into public.payment_adjustments (session_charge_id, type, amount, reason, created_by)
       values ($1, 'refund', '-50.00', 'คืนบางส่วน', $2) returning id`,
      [charge.id, ctx.owner],
    );

    return { ...ctx, adjustmentId: adjustment.id };
  }

  it('🔴 เจ้าของหนี้เห็นรายการคืนเงินของตัวเองได้ (เดิมแอดมินเท่านั้น)', async () => {
    const ctx = await chargeWithAdjustment();
    const sql = 'select 1 from public.payment_adjustments where id = $1';

    expect(await visibleCount(ctx.member, sql, [ctx.adjustmentId])).toBe(1);
    expect(await visibleCount(ctx.owner, sql, [ctx.adjustmentId])).toBe(1);
  });

  it('🔴 สมาชิกคนอื่นในก๊วนเดียวกันไม่เห็น', async () => {
    const ctx = await chargeWithAdjustment();

    const other = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [ctx.gangId, other],
    );

    expect(
      await visibleCount(other, 'select 1 from public.payment_adjustments where id = $1', [
        ctx.adjustmentId,
      ]),
    ).toBe(0);
  });
});
