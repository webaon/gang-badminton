/**
 * รายงานรายรับ-รายจ่าย-กำไรของก๊วน — **[WO-3.B]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 baseline §โมดูล ข้อ 7: "รายรับ-จ่าย-กำไร (จาก snapshot + surplus reconcile ได้)"
 *    และ [v3.3]: **"รายงานนับรายรับจาก `session_charges`/ledger เสมอ ไม่อิง session status"**
 *    ⇒ นัดที่ยกเลิกกลางคันแต่มี charges ก็เข้ารายงานปกติ
 *
 * 🔴 แยกสองมุมของ "รายรับ" ให้ชัด — ปนกันเมื่อไหร่คือรายงานโกหก
 *
 *      เรียกเก็บแล้ว (charged)  = หนี้ที่ออกบิลไปทั้งหมด
 *      เก็บได้จริง  (collected) = เงินสดที่เข้ามาจริง = allocation ของสลิปที่ `verified`
 *                                 **หัก refund** (เงินที่คืนออกไปแล้ว)
 *
 *    ⚠️ `credit` / `correction` ลดหนี้แต่ **ไม่ใช่เงินสด** ⇒ กระทบ `charged`/`outstanding`
 *       ไม่กระทบ `collected` (นิยามเดียวกับ `total_paid` ใน rollup ของ WO-3.A)
 *
 * pure TypeScript — ไม่มี float แตะเงิน (CLAUDE.md §2.6)
 */
import { fromSatang, sumSatang, toSatang } from '../billing/money';
import { ledgerLineOf, type LedgerEntry } from '../billing/ledger';

export type ReportCharge = LedgerEntry & {
  /** รายการ refund ของหนี้ก้อนนี้ (ค่าติดลบ) — แยกจาก adjustments เพราะเป็นเงินสดที่คืนออกไป */
  refunds: string[];
  /** `breakdown.rounding_surplus` ของ charge นั้น (WO-2.5-B) */
  roundingSurplus: string;
};

export type FinanceInput = {
  charges: readonly ReportCharge[];
  /** `gang_incomes.amount` — รายรับอื่นที่ไม่ได้มาจากการเรียกเก็บ (สปอนเซอร์ ขายลูก ฯลฯ) */
  otherIncomes: readonly string[];
  /** `gang_expenses.amount` */
  expenses: readonly string[];
};

export type FinanceReport = {
  /** ออกบิลไปทั้งหมด */
  charged: string;
  /** เงินสดที่เข้ามาจริง (หัก refund แล้ว) */
  collected: string;
  /** ยังตามเก็บอยู่ — นับเฉพาะยอดที่เป็นบวก */
  outstanding: string;
  /** ก๊วนเป็นหนี้ผู้เล่นอยู่ (จ่ายเกิน/รอคืน) — ค่าติดลบ */
  credit: string;
  /** เศษจากการปัดที่เข้าก๊วน — บรรทัดที่ทำให้ reconcile ได้ */
  roundingSurplus: string;
  otherIncome: string;
  expense: string;
  /**
   * กำไรแบบ **เงินสด** = เก็บได้จริง + รายรับอื่น − รายจ่าย
   *
   * ⚠️ จงใจไม่ใช้ `charged` เป็นฐาน — เงินที่ยังไม่เข้าไม่ใช่กำไร
   *    ถ้าอยากได้มุม accrual ให้ดู `charged` คู่กับ `outstanding` ที่รายงานไว้แล้ว
   */
  netCash: string;
};

export function calculateFinanceReport(input: FinanceInput): FinanceReport {
  const lines = input.charges.map((c) => ledgerLineOf(c));

  const charged = sumSatang(lines.map((l) => toSatang(l.charge)));

  const allocated = sumSatang(lines.map((l) => toSatang(l.allocated)));
  const refunded = sumSatang(input.charges.flatMap((c) => c.refunds).map(toSatang));

  const outstanding = lines
    .map((l) => toSatang(l.outstanding))
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);

  const credit = lines
    .map((l) => toSatang(l.outstanding))
    .filter((v) => v < 0)
    .reduce((a, b) => a + b, 0);

  // refunds เป็นค่าติดลบอยู่แล้ว ⇒ บวกเข้าไปคือการหักออก
  const collected = allocated + refunded;

  const otherIncome = sumSatang(input.otherIncomes.map(toSatang));
  const expense = sumSatang(input.expenses.map(toSatang));

  return {
    charged: fromSatang(charged),
    collected: fromSatang(collected),
    outstanding: fromSatang(outstanding),
    credit: fromSatang(credit),
    roundingSurplus: fromSatang(sumSatang(input.charges.map((c) => toSatang(c.roundingSurplus)))),
    otherIncome: fromSatang(otherIncome),
    expense: fromSatang(expense),
    netCash: fromSatang(collected + otherIncome - expense),
  };
}

/**
 * ตรวจ invariant ของรายงาน — baseline §Verification เรียกข้อนี้ว่า blocker
 *
 *     sum(charges) − ต้นทุนจริง = rounding surplus ตาม policy
 *
 * ⇒ "ต้นทุนจริง" ของช่วงเวลาหนึ่งคือ `charged − roundingSurplus`
 *   ฟังก์ชันนี้จึงตรวจว่าตัวเลขบนรายงานสอดคล้องกันเอง ก่อนเอาไปแสดง
 *
 * @throws ถ้าไม่ตรง — ดังตั้งแต่ตอนคำนวณ ดีกว่าให้แอดมินไปเจอเลขเพี้ยนเองในอีกสามเดือน
 */
export function assertReportReconciles(report: FinanceReport, actualCost: string): void {
  const expected = toSatang(report.charged) - toSatang(actualCost);

  if (expected !== toSatang(report.roundingSurplus)) {
    throw new Error(
      `รายงาน reconcile ไม่ได้: เรียกเก็บ ${report.charged} − ต้นทุน ${actualCost} ` +
        `≠ เศษ ${report.roundingSurplus}`,
    );
  }
}
