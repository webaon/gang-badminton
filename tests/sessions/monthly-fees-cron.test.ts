/**
 * WO-2.5-C DoD — งาน cron รายเดือนเดินได้จริง
 *
 * เรียก **code path เดียวกับที่ route handler เรียก** (`billAllGangs`)
 * ไม่ใช่จำลอง SQL เอง ⇒ ถ้าใครแก้การเลือกแผน/เลือกเดือน เทสต์นี้จับได้
 *
 * 🔴 ที่ต้องพิสูจน์เป็นพิเศษ: เลือก "เดือนนี้" จาก **นาฬิกาของก๊วน** ไม่ใช่ UTC
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

// ต้องตั้งก่อน import โมดูลที่สร้าง supabase client (มัน cache client ไว้)
process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { billAllGangs, billOneGang } = await import('@/server/membership/billing');

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`mfc-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithPlan(opts: {
  timezone?: string;
  monthlyFee?: string;
  members?: number;
  since?: string | null;
  withMonthlyPlan?: boolean;
}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(`update public.gangs set timezone = $2 where id = $1`, [
    gang.id,
    opts.timezone ?? 'Asia/Bangkok',
  ]);

  if (opts.withMonthlyPlan ?? true) {
    await pool.query(
      `insert into public.gang_pricing_plans (gang_id, name, type, params)
       values ($1, 'ค่าสมาชิกรายเดือน', 'monthly', jsonb_build_object('monthly_fee', $2::text))`,
      [gang.id, opts.monthlyFee ?? '1200.00'],
    );
  }

  const memberIds: string[] = [];
  for (let i = 0; i < (opts.members ?? 0); i++) {
    const u = await newUser();
    const {
      rows: [m],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_members
         (gang_id, user_id, role, is_monthly_member, monthly_member_since)
       values ($1, $2, 'member', true, $3)
       returning id`,
      [gang.id, u, opts.since ?? null],
    );
    memberIds.push(m.id);
  }

  return { owner, gangId: gang.id, memberIds };
}

async function chargedMonths(gangId: string): Promise<string[]> {
  const { rows } = await pool.query<{ billing_month: string }>(
    `select distinct billing_month::text from public.session_charges
      where gang_id = $1 and type = 'monthly_fee' order by 1`,
    [gangId],
  );
  return rows.map((r) => r.billing_month);
}

describe('WO-2.5-C — billOneGang', () => {
  it('ออกบิลให้ทุกคนที่เป็นสมาชิกรายเดือนของก๊วนนั้น', async () => {
    const { gangId, owner } = await gangWithPlan({ members: 3 });

    const outcome = await billOneGang({
      gangId,
      billingMonth: '2026-09-01',
      actorId: owner,
      correlationId: crypto.randomUUID(),
    });

    expect(outcome).toMatchObject({ created: 3, skipped: 0, total: '3600.00' });
  });

  it('ก๊วนที่ยังไม่ตั้งค่าสมาชิกรายเดือน → คืน null (ไม่ใช่ error)', async () => {
    const { gangId, owner } = await gangWithPlan({ members: 2, withMonthlyPlan: false });

    const outcome = await billOneGang({
      gangId,
      billingMonth: '2026-09-01',
      actorId: owner,
      correlationId: crypto.randomUUID(),
    });

    expect(outcome).toBeNull();
  });

  it('🔴 ไม่แตะสมาชิกที่ไม่ได้ติ๊กรายเดือน', async () => {
    const { gangId, owner } = await gangWithPlan({ members: 1 });

    const plain = await newUser();
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gangId, plain],
    );

    const outcome = await billOneGang({
      gangId,
      billingMonth: '2026-09-01',
      actorId: owner,
      correlationId: crypto.randomUUID(),
    });

    expect(outcome?.created).toBe(1);
  });
});

describe('WO-2.5-C DoD — cron ออกบิลของเดือนตามนาฬิกาก๊วน', () => {
  it('🔴 ก๊วนไทยตอน 31 ส.ค. 17:10Z (= 1 ก.ย. 00:10 ไทย) → ออกบิลเดือน ก.ย.', async () => {
    const th = await gangWithPlan({ timezone: 'Asia/Bangkok', members: 1 });
    const utc = await gangWithPlan({ timezone: 'UTC', members: 1 });

    await billAllGangs(crypto.randomUUID(), new Date('2026-08-31T17:10:00Z'));

    expect(await chargedMonths(th.gangId)).toEqual(['2026-09-01']);
    // ก๊วน UTC ยังเป็น 31 ส.ค. ⇒ รอบเดือน ส.ค.
    expect(await chargedMonths(utc.gangId)).toEqual(['2026-08-01']);
  });

  it('รันซ้ำในเดือนเดิม → ไม่มีใบเพิ่ม', async () => {
    const { gangId } = await gangWithPlan({ members: 2 });
    const now = new Date('2026-09-05T03:00:00Z');

    const first = await billAllGangs(crypto.randomUUID(), now);
    expect(first.created).toBeGreaterThanOrEqual(2);

    const before = await pool.query<{ count: string }>(
      `select count(*)::text from public.session_charges where gang_id = $1`,
      [gangId],
    );

    await billAllGangs(crypto.randomUUID(), now);

    const after = await pool.query<{ count: string }>(
      `select count(*)::text from public.session_charges where gang_id = $1`,
      [gangId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('ก๊วนหนึ่งพังต้องไม่ทำให้ก๊วนอื่นไม่ได้ออกบิล', async () => {
    const broken = await gangWithPlan({ members: 1 });
    const healthy = await gangWithPlan({ members: 1 });

    // ค่าสมาชิกที่ผิดรูปแบบ ⇒ toSatang() โยนตอนคิดเงินของก๊วนนี้
    await pool.query(
      `update public.gang_pricing_plans set params = '{"monthly_fee": "ไม่ใช่ตัวเลข"}'::jsonb
        where gang_id = $1 and type = 'monthly'`,
      [broken.gangId],
    );

    const result = await billAllGangs(crypto.randomUUID(), new Date('2026-11-03T03:00:00Z'));

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await chargedMonths(healthy.gangId)).toContain('2026-11-01');
    expect(await chargedMonths(broken.gangId)).not.toContain('2026-11-01');
  });
});
