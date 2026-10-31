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
 * ⚠️ `credit` / `correction` ลดหนี้แต่ **ไม่ใช่เงินสด** ⇒ กระทบ `charged`/`outstanding`
 *       ไม่กระทบ `collected` (นิยามเดียวกับ `total_paid` ใน rollup ของ WO-3.A)
 *
 * 🔴 [WO-B5b · ADR-010 · Q4] เครดิตสมาชิก — รายงานต้องตรงกับบัญชีธนาคาร (ไม่นับเงินซ้ำ ไม่ตกหล่น):
 *      · allocation ที่จ่ายด้วย **เครดิต** (`source = 'credit'`) ไม่ใช่เงินสดเข้า — เงินสดนับไปแล้วตอนโอนเกิน
 *        ⇒ `collected` = allocation(source transfer) + refund · ส่ง `creditAllocated` เพื่อหักส่วนนี้
 *      · โอนเกินเข้าเครดิต (`credit_ledger.type = overpayment`) นับ **ตอนเงินเข้า** เป็นบรรทัดของตัวเอง `overpaymentIn`
 *      · จ่ายคืนเครดิตเป็นเงินสด (`cash_payout`) = บรรทัด "เงินคืนสมาชิก" `memberPayouts` หักออกจาก `netCash`
 *      · `admin_topup` (ให้เครดิต) กับ `charge_return` (ย้ายยอดเข้าเครดิต) **ไม่ใช่เงินสด** ⇒ ไม่ส่งเข้ารายงานนี้
 *      ทุกฟิลด์ใหม่ optional — ไม่ส่ง = พฤติกรรมเดิมทุกอย่าง
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
  /**
   * [B5b] ส่วนของ `allocated` ที่จ่ายด้วยเครดิต (`payment_allocations.source = 'credit'`, สลิป verified)
   * ไม่ใช่เงินสดเข้า — ไม่ส่ง = ถือว่าไม่มีการจ่ายด้วยเครดิต
   */
  creditAllocated?: string[];
};

export type FinanceInput = {
  charges: readonly ReportCharge[];
  /** `gang_incomes.amount` — รายรับอื่นที่ไม่ได้มาจากการเรียกเก็บ (สปอนเซอร์ ขายลูก ฯลฯ) */
  otherIncomes: readonly string[];
  /** `gang_expenses.amount` */
  expenses: readonly string[];
  /** [B5b] `credit_ledger` type overpayment (บวก) — โอนเกินที่เงินเข้าบัญชีแล้วเป็นเครดิตสมาชิก */
  overpayments?: readonly string[];
  /** [B5b] `credit_ledger` type cash_payout (ค่าติดลบตามที่เก็บ หรือบวกก็ได้ — รับค่าสัมบูรณ์) เงินสดที่คืนสมาชิกจริง */
  memberPayouts?: readonly string[];
};

export type FinanceReport = {
  /** ออกบิลไปทั้งหมด */
  charged: string;
  /** เงินสดที่เข้ามาจริงจากการจ่ายหนี้ (หัก refund · ไม่นับส่วนที่จ่ายด้วยเครดิต) */
  collected: string;
  /** [B5b] โอนเกินเข้าเครดิต — เงินสดเข้าจริงแต่ยังไม่ใช่รายรับ (ก๊วนติดสมาชิกอยู่) */
  overpaymentIn: string;
  /** [B5b] เงินคืนสมาชิก (จ่ายคืนเครดิตเป็นเงินสด) — เงินสดออก */
  memberPayouts: string;
  /** ยังตามเก็บอยู่ — นับเฉพาะยอดที่เป็นบวก */
  outstanding: string;
  /** ก๊วนเป็นหนี้ผู้เล่นอยู่ (จ่ายเกิน/รอคืน) — ค่าติดลบ */
  credit: string;
  /** เศษจากการปัดที่เข้าก๊วน — บรรทัดที่ทำให้ reconcile ได้ */
  roundingSurplus: string;
  otherIncome: string;
  expense: string;
  /**
   * กำไรแบบ **เงินสด** = เก็บได้จริง + โอนเกินเข้า + รายรับอื่น − รายจ่าย − เงินคืนสมาชิก
   *
   * ⚠️ จงใจไม่ใช้ `charged` เป็นฐาน — เงินที่ยังไม่เข้าไม่ใช่กำไร
   *    ถ้าอยากได้มุม accrual ให้ดู `charged` คู่กับ `outstanding` ที่รายงานไว้แล้ว
   * ⚠️ `netCash` รวมเงินโอนเกินที่ก๊วนยังติดสมาชิกอยู่ (เครดิตคงเหลือ) — ตรงกับยอดในบัญชีธนาคาร
   *    ไม่ใช่กำไรที่เอาไปใช้ได้ทั้งหมด
   */
  netCash: string;
};

export function calculateFinanceReport(input: FinanceInput): FinanceReport {
  const lines = input.charges.map((c) => ledgerLineOf(c));

  const charged = sumSatang(lines.map((l) => toSatang(l.charge)));

  const allocated = sumSatang(lines.map((l) => toSatang(l.allocated)));
  const creditPaid = sumSatang(input.charges.flatMap((c) => c.creditAllocated ?? []).map(toSatang));
  const refunded = sumSatang(input.charges.flatMap((c) => c.refunds).map(toSatang));

  const outstanding = lines
    .map((l) => toSatang(l.outstanding))
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);

  const credit = lines
    .map((l) => toSatang(l.outstanding))
    .filter((v) => v < 0)
    .reduce((a, b) => a + b, 0);

  // refunds เป็นค่าติดลบอยู่แล้ว ⇒ บวกเข้าไปคือการหักออก · ส่วนที่จ่ายด้วยเครดิตไม่ใช่เงินสดเข้า ⇒ หักออก
  const collected = allocated - creditPaid + refunded;

  const overpaymentIn = sumSatang((input.overpayments ?? []).map(toSatang));
  const memberPayouts = sumSatang((input.memberPayouts ?? []).map((v) => Math.abs(toSatang(v))));

  const otherIncome = sumSatang(input.otherIncomes.map(toSatang));
  const expense = sumSatang(input.expenses.map(toSatang));

  return {
    charged: fromSatang(charged),
    collected: fromSatang(collected),
    overpaymentIn: fromSatang(overpaymentIn),
    memberPayouts: fromSatang(memberPayouts),
    outstanding: fromSatang(outstanding),
    credit: fromSatang(credit),
    roundingSurplus: fromSatang(sumSatang(input.charges.map((c) => toSatang(c.roundingSurplus)))),
    otherIncome: fromSatang(otherIncome),
    expense: fromSatang(expense),
    netCash: fromSatang(collected + overpaymentIn + otherIncome - expense - memberPayouts),
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
