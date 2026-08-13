import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  billingMonthOf,
  calculateMonthlyFees,
  type BillingMonth,
  type MonthlyMember,
} from '@/domain/billing/membership';
import { monthlyFromJson } from '@/domain/policies/pricing';
import { utcToZonedWallClock } from '@/domain/time/timezone';

/**
 * MembershipBilling — ตัวเชื่อมระหว่าง `domain/billing/membership` กับฐานข้อมูล
 * **[WO-2.5-C]**
 *
 * ใช้ร่วมกันสองทาง: cron รายเดือน (`server/cron`) และปุ่ม "ออกบิลรอบนี้" ของแอดมิน
 * (`server/actions/membership.ts`) ⇒ ทั้งสองทางเดินสูตรเดียวกันเสมอ
 *
 * 🔴 ADR-001: คิดใน TypeScript → commit ผ่าน `commit_monthly_fees()` จุดเดียว
 *    ❌ ห้าม insert `session_charges` ประเภท `monthly_fee` ที่อื่น
 */

export type MonthlyBillingOutcome = {
  gangId: string;
  billingMonth: BillingMonth;
  created: number;
  skipped: number;
  total: string;
};

type MonthlyPlanRow = {
  gang_id: string;
  params: unknown;
  created_at: string;
  gangs: { timezone: string } | null;
};

/** แผน `monthly` ที่ active ล่าสุดของแต่ละก๊วน */
async function activeMonthlyPlans(gangId?: string): Promise<MonthlyPlanRow[]> {
  const query = supabaseAdmin()
    .from('gang_pricing_plans')
    .select('gang_id, params, created_at, gangs(timezone)')
    .eq('type', 'monthly')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  const { data, error } = gangId ? await query.eq('gang_id', gangId) : await query;
  if (error) throw error;

  // ก๊วนหนึ่งอาจมีแผน monthly เก่าค้างอยู่ — ใช้ใบล่าสุดใบเดียว
  const latest = new Map<string, MonthlyPlanRow>();
  for (const row of (data ?? []) as unknown as MonthlyPlanRow[]) {
    if (!latest.has(row.gang_id)) latest.set(row.gang_id, row);
  }

  return [...latest.values()];
}

/**
 * เดือนที่ต้องออกบิล ณ ตอนนี้ ตามนาฬิกาของก๊วน
 *
 * ⚠️ ต้องใช้ timezone ของก๊วน ไม่ใช่ UTC — ก๊วนไทยตอน 1 ก.ย. 00:10 ยังเป็น
 *    31 ส.ค. 17:10Z ⇒ ถ้าดูจาก UTC จะออกบิลเดือน ส.ค. ซ้ำแทนที่จะเป็น ก.ย.
 */
function currentBillingMonth(timezone: string | null, now: Date): BillingMonth {
  return billingMonthOf(utcToZonedWallClock(now, timezone ?? 'Asia/Bangkok'));
}

/** ออกบิลของก๊วนหนึ่งในเดือนหนึ่ง — idempotent (DB เป็นคนกัน) */
export async function billGangForMonth(opts: {
  gangId: string;
  billingMonth: BillingMonth;
  monthlyFee: string;
  actorId?: string | null;
  correlationId: string;
}): Promise<MonthlyBillingOutcome> {
  const admin = supabaseAdmin();

  const { data: members, error: membersError } = await admin
    .from('gang_members')
    .select('id, monthly_member_since, monthly_member_until')
    .eq('gang_id', opts.gangId)
    .eq('is_monthly_member', true)
    .is('deleted_at', null);

  if (membersError) throw membersError;

  const rows: MonthlyMember[] = (members ?? []).map((m) => ({
    gangMemberId: m.id,
    // คอลัมน์เป็น `date` ⇒ driver คืนเป็น string 'YYYY-MM-DD' อยู่แล้ว
    monthlyMemberSince: m.monthly_member_since ?? null,
    monthlyMemberUntil: m.monthly_member_until ?? null,
  }));

  const result = calculateMonthlyFees({
    billingMonth: opts.billingMonth,
    monthlyFee: opts.monthlyFee,
    members: rows,
  });

  if (result.charges.length === 0) {
    return {
      gangId: opts.gangId,
      billingMonth: opts.billingMonth,
      created: 0,
      skipped: 0,
      total: result.total,
    };
  }

  const { data, error } = await admin.rpc('commit_monthly_fees', {
    p_gang_id: opts.gangId,
    p_billing_month: opts.billingMonth,
    p_charges: result.charges.map((c) => ({
      gang_member_id: c.gangMemberId,
      amount: c.amount,
      breakdown: c.breakdown,
    })),
    p_actor_id: opts.actorId ?? null,
    p_correlation_id: opts.correlationId,
  });

  if (error) throw error;

  const committed = (Array.isArray(data) ? data[0] : data) as
    | { created: number; skipped: number }
    | undefined;

  return {
    gangId: opts.gangId,
    billingMonth: opts.billingMonth,
    created: committed?.created ?? 0,
    skipped: committed?.skipped ?? 0,
    total: result.total,
  };
}

/** ออกบิลให้ก๊วนเดียว — ใช้จากปุ่มของแอดมิน */
export async function billOneGang(opts: {
  gangId: string;
  billingMonth?: BillingMonth;
  actorId: string;
  correlationId: string;
  now?: Date;
}): Promise<MonthlyBillingOutcome | null> {
  const [plan] = await activeMonthlyPlans(opts.gangId);
  if (!plan) return null;

  return billGangForMonth({
    gangId: opts.gangId,
    billingMonth:
      opts.billingMonth ?? currentBillingMonth(plan.gangs?.timezone ?? null, opts.now ?? new Date()),
    monthlyFee: monthlyFromJson(plan.params).monthlyFee,
    actorId: opts.actorId,
    correlationId: opts.correlationId,
  });
}

/**
 * ออกบิลให้ทุกก๊วนที่ตั้งค่าสมาชิกรายเดือนไว้ — งานของ cron
 *
 * ⚠️ ก๊วนหนึ่งพังต้องไม่ทำให้ก๊วนที่เหลือไม่ได้ออกบิล ⇒ จับ error ต่อก๊วน
 *    แต่ **ห้ามกลืนเงียบ** (CLAUDE.md §5) — log พร้อม correlation id และรายงานจำนวนที่พลาด
 */
export async function billAllGangs(
  correlationId: string,
  now: Date = new Date(),
): Promise<{ gangs: number; created: number; skipped: number; failed: number }> {
  const plans = await activeMonthlyPlans();

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const plan of plans) {
    try {
      const outcome = await billGangForMonth({
        gangId: plan.gang_id,
        billingMonth: currentBillingMonth(plan.gangs?.timezone ?? null, now),
        monthlyFee: monthlyFromJson(plan.params).monthlyFee,
        actorId: null,
        correlationId,
      });

      created += outcome.created;
      skipped += outcome.skipped;
    } catch (error) {
      failed += 1;
      console.error('[membership] ออกบิลรายเดือนไม่สำเร็จ', {
        correlationId,
        gangId: plan.gang_id,
        message: (error as { message?: string }).message,
      });
    }
  }

  return { gangs: plans.length, created, skipped, failed };
}
