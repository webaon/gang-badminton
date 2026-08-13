/**
 * MembershipBilling — ค่าสมาชิกรายเดือน **[WO-2.5-C]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ADR-001: คิดที่นี่ (pure TypeScript) แล้ว commit ผ่าน **ฟังก์ชันของ
 *    MembershipBilling เอง** (`commit_monthly_fees()`) — ไม่ใช่
 *    `close_session_with_charges()` เพราะ `monthly_fee` ไม่มี session ให้ transition
 *
 * 🔴 กติกาที่ตกลงกับเจ้าของงาน 13 ส.ค. 2026 (baseline ไม่ได้ระบุ):
 *    · **เข้ากลางเดือน = เก็บเต็มเดือน** ไม่มี pro-rate
 *    · ออกบิล **ต้นเดือนสำหรับเดือนนั้น** (จ่ายล่วงหน้า) ⇒ ตลอดเดือนค่าสนามเป็น 0
 *
 * ⚠️ วันที่ในโมดูลนี้เป็น **string `YYYY-MM-DD`** ไม่ใช่ `Date`
 *    `billing_month` / `monthly_member_since` / `monthly_member_until` เป็น
 *    คอลัมน์ `date` (ไม่มีเวลา ไม่มีโซน) — ถ้าแปลงเป็น `Date` เมื่อไหร่
 *    "1 ก.ย." จะกลายเป็น "31 ส.ค. 17:00Z" แล้วเทียบเดือนผิดทันที
 *    ⇒ เทียบเป็น string ตรงๆ (ISO date เรียงตามตัวอักษร = เรียงตามเวลาพอดี)
 */
import { fromSatang, toSatang } from './money';

/** `YYYY-MM-DD` — วันแรกของเดือนที่ออกบิล */
export type BillingMonth = string;

export type MonthlyMember = {
  gangMemberId: string;
  /** วันที่เริ่มเป็นสมาชิกรายเดือน — null = ไม่เคยระบุ (ถือว่าเป็นมาตลอด) */
  monthlyMemberSince: string | null;
  /** วันสุดท้ายที่ยังเป็นสมาชิก — null = ยังไม่สิ้นสุด */
  monthlyMemberUntil: string | null;
};

export type MonthlyFeeCharge = {
  gangMemberId: string;
  amount: string;
  breakdown: Record<string, string | number | boolean>;
};

export type MonthlyFeeResult = {
  charges: MonthlyFeeCharge[];
  total: string;
};

const MONTH_RE = /^\d{4}-\d{2}-01$/;

/** ตรวจว่าเป็นวันแรกของเดือนจริง — กันเรียกด้วย '2026-09-15' แล้วได้ช่วงเพี้ยน */
export function assertBillingMonth(value: string): asserts value is BillingMonth {
  if (!MONTH_RE.test(value)) {
    throw new Error(`billing_month ต้องเป็นวันแรกของเดือนในรูปแบบ YYYY-MM-01: ${value}`);
  }
}

/** วันสุดท้ายของเดือนนั้น เป็น string `YYYY-MM-DD` */
export function lastDayOfMonth(billingMonth: BillingMonth): string {
  assertBillingMonth(billingMonth);

  const year = Number(billingMonth.slice(0, 4));
  const month = Number(billingMonth.slice(5, 7));

  // วันที่ 0 ของเดือนถัดไป = วันสุดท้ายของเดือนนี้ (UTC ล้วน ไม่มีโซนมาเกี่ยว)
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${billingMonth.slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

/**
 * เดือนที่ควรออกบิล ณ เวลานี้ ตามนาฬิกาของก๊วน
 *
 * ⚠️ ต้องใช้ timezone ของก๊วน — ก๊วนไทยเวลา 1 ก.ย. 00:10 ตรงกับ 31 ส.ค. 17:10Z
 *    ถ้าดูจาก UTC จะออกบิลเดือน ส.ค. ซ้ำแทนที่จะเป็น ก.ย.
 *
 * @param wallClock ผลจาก `utcToZonedWallClock()` รูปแบบ `YYYY-MM-DDTHH:mm`
 */
export function billingMonthOf(wallClock: string): BillingMonth {
  return `${wallClock.slice(0, 7)}-01`;
}

/**
 * สมาชิกคนนี้ต้องจ่ายค่าเดือนนี้ไหม
 *
 * 🔴 **เก็บเต็มเดือน** — เข้าวันที่ 1 หรือวันที่ 28 ก็จ่ายเท่ากัน (กติกาที่ตกลง)
 *    เงื่อนไขจึงเป็นแค่ "ช่วงการเป็นสมาชิก **ทับกับ** เดือนนี้หรือไม่"
 */
export function isBillableInMonth(member: MonthlyMember, billingMonth: BillingMonth): boolean {
  assertBillingMonth(billingMonth);
  const monthEnd = lastDayOfMonth(billingMonth);

  // เริ่มเป็นสมาชิกหลังเดือนนี้จบแล้ว ⇒ ยังไม่ถึงคิวของเขา
  if (member.monthlyMemberSince !== null && member.monthlyMemberSince > monthEnd) return false;

  // หมดสมาชิกก่อนเดือนนี้เริ่ม ⇒ ไม่ต้องเก็บย้อนหลัง
  if (member.monthlyMemberUntil !== null && member.monthlyMemberUntil < billingMonth) return false;

  return true;
}

/**
 * คิดค่าสมาชิกรายเดือนของทั้งก๊วนในเดือนหนึ่ง
 *
 * ⚠️ ฟังก์ชันนี้ไม่รู้ว่าใครถูกออกบิลไปแล้ว — **idempotency เป็นหน้าที่ของ
 *    `commit_monthly_fees()`** ที่มี partial unique index `(gang_member_id, billing_month)`
 *    กันไว้ระดับฐานข้อมูล (baseline §Verification)
 *    ⇒ เรียกซ้ำกี่รอบก็ได้ผลลัพธ์เดิม และ commit ซ้ำไม่สร้างแถวเพิ่ม
 */
export function calculateMonthlyFees(input: {
  billingMonth: BillingMonth;
  /** ค่าสมาชิกรายเดือนจากแผนราคา type `monthly` */
  monthlyFee: string;
  members: readonly MonthlyMember[];
}): MonthlyFeeResult {
  assertBillingMonth(input.billingMonth);

  // เงินเป็นจำนวนเต็มสตางค์เสมอ (CLAUDE.md §2.6) — ผ่าน helper เดียวกับ session billing
  const fee = toSatang(input.monthlyFee);

  const charges: MonthlyFeeCharge[] = [];

  for (const member of input.members) {
    if (!isBillableInMonth(member, input.billingMonth)) continue;

    charges.push({
      gangMemberId: member.gangMemberId,
      amount: input.monthlyFee,
      breakdown: {
        monthly_fee: input.monthlyFee,
        billing_month: input.billingMonth,
        // เก็บเต็มเดือนเสมอ — บันทึกไว้ให้ชัดว่าไม่ได้ลืม pro-rate แต่เป็นกติกา
        proration: 'full_month',
        ...(member.monthlyMemberSince ? { member_since: member.monthlyMemberSince } : {}),
        ...(member.monthlyMemberUntil ? { member_until: member.monthlyMemberUntil } : {}),
      },
    });
  }

  return {
    charges,
    total: fromSatang(fee * charges.length),
  };
}
