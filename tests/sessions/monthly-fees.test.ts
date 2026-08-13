/**
 * WO-2.5-C DoD — `commit_monthly_fees()` ระดับฐานข้อมูล
 *
 *   · 🔴 **idempotent ต่อสมาชิก+เดือน** — รันซ้ำไม่สร้างซ้ำ (baseline §Verification)
 *   · charge เป็น `type = 'monthly_fee'` ที่ **ไม่ผูก session** (ADR-001)
 *   · กันข้ามก๊วน — เรียกเก็บคนที่ไม่ได้อยู่ในก๊วนนี้ไม่ได้
 *   · `anon` / `authenticated` เรียกฟังก์ชันนี้ไม่ได้
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, asRole } from '../helpers/db';
import { calculateMonthlyFees } from '@/domain/billing/membership';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`mf-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วน + สมาชิกรายเดือน n คน */
async function gangWithMonthlyMembers(n: number, since: string | null = null) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วน-${crypto.randomUUID()}`,
  ]);

  await pool.query(
    `insert into public.gang_pricing_plans (gang_id, name, type, params)
     values ($1, 'ค่าสมาชิกรายเดือน', 'monthly', '{"monthly_fee": "1200.00"}'::jsonb)`,
    [gang.id],
  );

  const memberIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await newUser();
    const {
      rows: [m],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_members
         (gang_id, user_id, role, is_monthly_member, monthly_member_since)
       values ($1, $2, 'member', true, $3)
       returning id`,
      [gang.id, u, since],
    );
    memberIds.push(m.id);
  }

  return { owner, gangId: gang.id, memberIds };
}

/** เดินเส้นเดียวกับ `billGangForMonth()`: คิดใน TS แล้ว commit ผ่าน DB function */
async function commit(
  gangId: string,
  memberIds: string[],
  billingMonth: string,
  actor: string | null = null,
) {
  const result = calculateMonthlyFees({
    billingMonth,
    monthlyFee: '1200.00',
    members: memberIds.map((id) => ({
      gangMemberId: id,
      monthlyMemberSince: null,
      monthlyMemberUntil: null,
    })),
  });

  const {
    rows: [row],
  } = await pool.query<{ created: number; skipped: number }>(
    `select * from public.commit_monthly_fees($1, $2::date, $3::jsonb, $4)`,
    [
      gangId,
      billingMonth,
      JSON.stringify(
        result.charges.map((c) => ({
          gang_member_id: c.gangMemberId,
          amount: c.amount,
          breakdown: c.breakdown,
        })),
      ),
      actor,
    ],
  );

  return row;
}

describe('WO-2.5-C DoD — idempotent ต่อสมาชิก+เดือน', () => {
  it('🔴 รันซ้ำไม่สร้างใบซ้ำ — ครั้งที่สอง created = 0', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(3);

    const first = await commit(gangId, memberIds, '2026-09-01', owner);
    expect(first).toEqual({ created: 3, skipped: 0 });

    const second = await commit(gangId, memberIds, '2026-09-01', owner);
    expect(second).toEqual({ created: 0, skipped: 3 });

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from public.session_charges
        where gang_id = $1 and type = 'monthly_fee'`,
      [gangId],
    );
    expect(Number(rows[0].count)).toBe(3);
  });

  it('เดือนถัดไปออกใบใหม่ได้ (idempotency ผูกกับเดือน ไม่ใช่สมาชิกอย่างเดียว)', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(2);

    await commit(gangId, memberIds, '2026-09-01', owner);
    const october = await commit(gangId, memberIds, '2026-10-01', owner);

    expect(october.created).toBe(2);

    const { rows } = await pool.query<{ billing_month: string; count: string }>(
      `select billing_month::text, count(*)::text from public.session_charges
        where gang_id = $1 and type = 'monthly_fee'
        group by billing_month order by billing_month`,
      [gangId],
    );
    expect(rows.map((r) => [r.billing_month, Number(r.count)])).toEqual([
      ['2026-09-01', 2],
      ['2026-10-01', 2],
    ]);
  });

  it('🔴 สมาชิกที่เพิ่งสมัครกลางเดือน ได้ใบเพิ่มโดยไม่กระทบใบเดิม', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(2);
    await commit(gangId, memberIds, '2026-09-01', owner);

    // สมัครหลัง cron รันไปแล้ว
    const late = await newUser();
    const {
      rows: [lateMember],
    } = await pool.query<{ id: string }>(
      `insert into public.gang_members
         (gang_id, user_id, role, is_monthly_member, monthly_member_since)
       values ($1, $2, 'member', true, '2026-09-20')
       returning id`,
      [gangId, late],
    );

    const again = await commit(gangId, [...memberIds, lateMember.id], '2026-09-01', owner);
    expect(again).toEqual({ created: 1, skipped: 2 });
  });

  it('🔴 index กันซ้ำที่ระดับฐานข้อมูลจริง — INSERT ตรงก็ยังชน', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(1);
    await commit(gangId, memberIds, '2026-09-01', owner);

    await expect(
      pool.query(
        `insert into public.session_charges
           (gang_id, type, gang_member_id, billing_month, amount)
         values ($1, 'monthly_fee', $2, '2026-09-01', '1200.00')`,
        [gangId, memberIds[0]],
      ),
    ).rejects.toThrow(/session_charges_monthly_member_month_key/);
  });
});

describe('WO-2.5-C DoD — รูปร่างของ charge (ADR-001)', () => {
  it('type = monthly_fee · ไม่ผูก session · มี billing_month', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(1);
    await commit(gangId, memberIds, '2026-09-01', owner);

    const {
      rows: [charge],
    } = await pool.query<{
      type: string;
      session_id: string | null;
      registration_id: string | null;
      billing_month: string;
      amount: string;
      breakdown: { proration: string };
    }>(
      `select type, session_id, registration_id, billing_month::text, amount, breakdown
         from public.session_charges where gang_id = $1`,
      [gangId],
    );

    expect(charge.type).toBe('monthly_fee');
    expect(charge.session_id).toBeNull();
    expect(charge.registration_id).toBeNull();
    expect(charge.billing_month).toBe('2026-09-01');
    expect(charge.amount).toBe('1200.00');
    expect(charge.breakdown.proration).toBe('full_month');
  });

  it('บันทึก event เฉพาะรอบที่สร้างของใหม่จริง', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(2);

    await commit(gangId, memberIds, '2026-09-01', owner);
    await commit(gangId, memberIds, '2026-09-01', owner); // รอบนี้ไม่มีอะไรใหม่

    const { rows } = await pool.query<{ payload: { created: number } }>(
      `select payload from public.event_logs
        where gang_id = $1 and event_type = 'membership.fees_generated'`,
      [gangId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].payload.created).toBe(2);
  });
});

describe('WO-2.5-C DoD — ขอบเขตความปลอดภัย', () => {
  it('🔴 เรียกเก็บสมาชิกของก๊วนอื่นไม่ได้', async () => {
    const a = await gangWithMonthlyMembers(1);
    const b = await gangWithMonthlyMembers(1);

    await expect(commit(a.gangId, b.memberIds, '2026-09-01', a.owner)).rejects.toThrow(
      /VALIDATION_ERROR/,
    );

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from public.session_charges where type = 'monthly_fee'
        and gang_member_id = $1`,
      [b.memberIds[0]],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it('เดือนที่ไม่ใช่วันแรก → VALIDATION_ERROR', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(1);

    await expect(
      pool.query(`select * from public.commit_monthly_fees($1, $2::date, $3::jsonb, $4)`, [
        gangId,
        '2026-09-15',
        JSON.stringify([{ gang_member_id: memberIds[0], amount: '1200.00', breakdown: {} }]),
        owner,
      ]),
    ).rejects.toThrow(/VALIDATION_ERROR/);
  });

  it('🔴 ผู้ใช้ที่ล็อกอินอยู่เรียกฟังก์ชันนี้ตรงๆ ไม่ได้ (service_role เท่านั้น)', async () => {
    const { gangId, memberIds, owner } = await gangWithMonthlyMembers(1);

    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select * from public.commit_monthly_fees($1, '2026-09-01'::date, $2::jsonb, $3)`, [
          gangId,
          JSON.stringify([{ gang_member_id: memberIds[0], amount: '1200.00', breakdown: {} }]),
          owner,
        ]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
