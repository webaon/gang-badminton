/**
 * WO-3.B DoD — รายงานอ่านข้อมูลจริงถูกต้อง
 *
 *   · 🔴 นัดที่ `cancelled` แต่มี charges **เข้ารายงาน** (ไม่อิง session status)
 *   · รายรับนับจาก ledger — สลิปที่ยังไม่ verified ไม่นับเป็นเงินสด
 *   · รายรับอื่น/รายจ่ายที่บันทึกเอง มีผลกับรายงานทันที · ลบแล้วหายทันที
 *   · RLS: สมาชิกทั่วไปแตะ `gang_expenses` / `gang_incomes` ไม่ได้เลย
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole, visibleCount } from '../helpers/db';
import { calculateFinanceReport, type ReportCharge } from '@/domain/reports/finance';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`fn-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithPlayers(n: number) {
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
     values ($1, 'นัดรายงาน', now() - interval '2 hours', now() - interval '1 hour', $2,
             '{"snapshot_version":1}'::jsonb, $3)
     returning id`,
    [gang.id, n + 2, owner],
  );
  await pool.query(`select public.transition_session($1, 'open', $2)`, [session.id, owner]);

  const players: { userId: string; registrationId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const userId = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, userId],
    );
    const {
      rows: [reg],
    } = await pool.query<{ id: string }>(`select id from public.register_to_session($1, $2)`, [
      session.id,
      userId,
    ]);
    await pool.query(`select public.check_in_registration($1, $2)`, [reg.id, owner]);
    players.push({ userId, registrationId: reg.id });
  }

  await pool.query(`select public.transition_session($1, 'in_play', $2)`, [session.id, owner]);

  return { owner, gangId: gang.id, sessionId: session.id, players };
}

/** อ่านข้อมูลแบบเดียวกับหน้ารายงาน แล้วคิดด้วย domain ตัวเดียวกัน */
async function reportOf(gangId: string) {
  const { rows: charges } = await pool.query<{
    id: string;
    amount: string;
    breakdown: { rounding_surplus?: string };
    allocated: string[] | null;
    adjustments: string[] | null;
    refunds: string[] | null;
  }>(
    `select c.id, c.amount, c.breakdown,
            (select array_agg(a.amount::text)
               from public.payment_allocations a
               join public.payments p on p.id = a.payment_id
              where a.session_charge_id = c.id and p.status = 'verified'
                and p.deleted_at is null) as allocated,
            (select array_agg(j.amount::text) from public.payment_adjustments j
              where j.session_charge_id = c.id) as adjustments,
            (select array_agg(j.amount::text) from public.payment_adjustments j
              where j.session_charge_id = c.id and j.type = 'refund') as refunds
       from public.session_charges c
      where c.gang_id = $1`,
    [gangId],
  );

  const { rows: incomes } = await pool.query<{ amount: string }>(
    `select amount from public.gang_incomes where gang_id = $1`,
    [gangId],
  );
  const { rows: expenses } = await pool.query<{ amount: string }>(
    `select amount from public.gang_expenses where gang_id = $1`,
    [gangId],
  );

  const entries: ReportCharge[] = charges.map((c) => ({
    chargeId: c.id,
    amount: c.amount,
    allocated: c.allocated ?? [],
    adjustments: c.adjustments ?? [],
    refunds: c.refunds ?? [],
    roundingSurplus: c.breakdown?.rounding_surplus ?? '0.00',
  }));

  return calculateFinanceReport({
    charges: entries,
    otherIncomes: incomes.map((i) => i.amount),
    expenses: expenses.map((e) => e.amount),
  });
}

describe('WO-3.B DoD — รายรับจาก charges/ledger', () => {
  it('🔴 นัดที่ยกเลิกกลางคันแต่มี charges เข้ารายงาน (ไม่อิง sessions.status)', async () => {
    const ctx = await gangWithPlayers(2);

    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'cancelled', $3)`,
      [
        ctx.sessionId,
        JSON.stringify(
          ctx.players.map((p) => ({
            registration_id: p.registrationId,
            amount: '100.00',
            breakdown: { flat_rate: '200.00', midway_cancel_ratio: 0.5 },
          })),
        ),
        ctx.owner,
      ],
    );

    const {
      rows: [session],
    } = await pool.query<{ status: string }>(`select status from public.sessions where id = $1`, [
      ctx.sessionId,
    ]);
    expect(session.status).toBe('cancelled');

    const report = await reportOf(ctx.gangId);
    expect(report.charged).toBe('200.00');
    expect(report.outstanding).toBe('200.00');
  });

  it('สลิปที่ยังไม่ verified ไม่นับเป็นเงินสด · verify แล้วนับ', async () => {
    const ctx = await gangWithPlayers(1);
    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
      [
        ctx.sessionId,
        JSON.stringify([
          {
            registration_id: ctx.players[0].registrationId,
            amount: '200.00',
            breakdown: { flat_rate: '200.00' },
          },
        ]),
        ctx.owner,
      ],
    );

    const {
      rows: [charge],
    } = await pool.query<{ id: string }>(
      `select id from public.session_charges where session_id = $1`,
      [ctx.sessionId],
    );

    const {
      rows: [payment],
    } = await pool.query<{ id: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [ctx.gangId, ctx.players[0].userId, [charge.id], ctx.players[0].userId],
    );

    expect((await reportOf(ctx.gangId)).collected).toBe('0.00');

    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      ctx.players[0].userId,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [
      payment.id,
      ctx.owner,
    ]);

    const report = await reportOf(ctx.gangId);
    expect(report.collected).toBe('200.00');
    expect(report.outstanding).toBe('0.00');
  });

  it('🔴 refund ลด "เก็บได้จริง" แต่ credit ไม่ลด', async () => {
    const ctx = await gangWithPlayers(2);
    await pool.query(
      `select public.close_session_with_charges($1, $2::jsonb, 'in_play', 'billing', $3)`,
      [
        ctx.sessionId,
        JSON.stringify(
          ctx.players.map((p) => ({
            registration_id: p.registrationId,
            amount: '200.00',
            breakdown: { flat_rate: '200.00' },
          })),
        ),
        ctx.owner,
      ],
    );

    const { rows: charges } = await pool.query<{ id: string }>(
      `select id from public.session_charges where session_id = $1 order by id`,
      [ctx.sessionId],
    );

    // คนแรกจ่ายแล้วได้คืนบางส่วน · คนที่สองได้เครดิตโดยไม่เคยจ่าย
    const {
      rows: [payment],
    } = await pool.query<{ id: string }>(
      `select * from public.create_payment_for_charges($1, $2, $3::uuid[], $4)`,
      [ctx.gangId, ctx.players[0].userId, [charges[0].id], ctx.players[0].userId],
    );
    await pool.query(`select public.transition_payment($1, 'submitted', $2)`, [
      payment.id,
      ctx.players[0].userId,
    ]);
    await pool.query(`select public.transition_payment($1, 'verified', $2)`, [
      payment.id,
      ctx.owner,
    ]);

    await pool.query(`select public.add_payment_adjustment($1, 'refund', $2, $3, $4, $5)`, [
      charges[0].id,
      '-50.00',
      'มาสาย',
      payment.id,
      ctx.owner,
    ]);
    await pool.query(`select public.add_payment_adjustment($1, 'credit', $2, $3, null, $4)`, [
      charges[1].id,
      '-200.00',
      'ยกให้',
      ctx.owner,
    ]);

    const report = await reportOf(ctx.gangId);
    expect(report.charged).toBe('400.00');
    expect(report.collected).toBe('150.00'); // 200 − 50 (credit ไม่นับ)
    expect(report.outstanding).toBe('0.00');
    expect(report.credit).toBe('-50.00');
  });
});

describe('WO-3.B DoD — รายรับอื่น/รายจ่ายที่บันทึกเอง', () => {
  it('บันทึกแล้วรายงานเปลี่ยนทันที · ลบแล้วหายทันที', async () => {
    const ctx = await gangWithPlayers(1);

    const {
      rows: [expense],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_expenses (gang_id, session_id, category, amount, occurred_on, created_by)
       values ($1, $2, 'ค่าคอร์ท', '800.00', current_date, $3) returning id`,
      [ctx.gangId, ctx.sessionId, ctx.owner],
    );
    await pool.query(
      `insert into public.gang_incomes (gang_id, category, amount, occurred_on, created_by)
       values ($1, 'สปอนเซอร์', '500.00', current_date, $2)`,
      [ctx.gangId, ctx.owner],
    );

    let report = await reportOf(ctx.gangId);
    expect(report.expense).toBe('800.00');
    expect(report.otherIncome).toBe('500.00');
    expect(report.netCash).toBe('-300.00');

    await pool.query(`delete from public.gang_expenses where id = $1`, [expense.id]);

    report = await reportOf(ctx.gangId);
    expect(report.expense).toBe('0.00');
    expect(report.netCash).toBe('500.00');
  });

  it('ค่าใช้จ่ายผูกนัดได้และไม่ผูกก็ได้', async () => {
    const ctx = await gangWithPlayers(1);

    await pool.query(
      `insert into public.gang_expenses (gang_id, session_id, category, amount, occurred_on, created_by)
       values ($1, $2, 'ค่าคอร์ท', '800.00', current_date, $3),
              ($1, null, 'ค่าอุปกรณ์ประจำปี', '1200.00', current_date, $3)`,
      [ctx.gangId, ctx.sessionId, ctx.owner],
    );

    expect((await reportOf(ctx.gangId)).expense).toBe('2000.00');
  });
});

describe('WO-3.B DoD — สิทธิ์ (ข้อมูลการเงินของก๊วน)', () => {
  it('🔴 สมาชิกทั่วไปอ่าน gang_expenses / gang_incomes ไม่ได้ · แอดมินได้', async () => {
    const ctx = await gangWithPlayers(1);

    await pool.query(
      `insert into public.gang_expenses (gang_id, category, amount, occurred_on, created_by)
       values ($1, 'ค่าคอร์ท', '800.00', current_date, $2)`,
      [ctx.gangId, ctx.owner],
    );

    const sql = 'select 1 from public.gang_expenses where gang_id = $1';
    expect(await visibleCount(ctx.owner, sql, [ctx.gangId])).toBe(1);
    expect(await visibleCount(ctx.players[0].userId, sql, [ctx.gangId])).toBe(0);
  });

  it('🔴 สมาชิกทั่วไปเขียนรายจ่ายเองไม่ได้', async () => {
    const ctx = await gangWithPlayers(1);

    await asRole('authenticated', ctx.players[0].userId, async (c) => {
      await expect(
        c.query(
          `insert into public.gang_expenses (gang_id, category, amount, occurred_on)
           values ($1, 'ยัดเอง', '1.00', current_date)`,
          [ctx.gangId],
        ),
      ).rejects.toThrow(/row-level security|violates/i);
    });
  });
});
