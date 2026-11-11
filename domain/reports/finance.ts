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
  const a = aggregate(input);

  return {
    charged: fromSatang(a.charged),
    collected: fromSatang(a.collected),
    overpaymentIn: fromSatang(a.overpaymentIn),
    memberPayouts: fromSatang(a.memberPayouts),
    outstanding: fromSatang(a.outstanding),
    credit: fromSatang(a.credit),
    roundingSurplus: fromSatang(sumSatang(input.charges.map((c) => toSatang(c.roundingSurplus)))),
    otherIncome: fromSatang(a.otherIncome),
    expense: fromSatang(a.expense),
    netCash: fromSatang(a.collected + a.overpaymentIn + a.otherIncome - a.expense - a.memberPayouts),
  };
}

/** [WO-6.5c] เงินเข้า/เงินออกจากค่าที่ `financeReport()` (server action) คำนวณไว้แล้ว — **ไม่ใช่สูตรใหม่**
 *  ไม่รับ FinanceInput ดิบ เพราะ loader ของ H10 เรียก `financeReport()` action ทีละเดือน (ตามที่ planner
 *  สั่ง "ใช้ financeReport เดือนละ 1 ครั้ง") ซึ่งคืนค่าที่รวมแล้วเท่านั้น — รวมยอดที่นี่ ไม่ใช่ใน loader/UI
 *  ตามคำสั่ง "ห้ามรวมยอดใน loader/UI"
 *
 *  🔴 [planner 31 ต.ค. 2026] นี่คือฟังก์ชันเดียวที่คำนวณ inflow/outflow — ของเดิมที่ชื่อ
 *  `calculateCashFlowSplit(FinanceInput)` ถูกลบไปแล้ว เพราะไม่มีที่ใดเรียกจริง (loader เรียกตัวนี้
 *  ที่เดียว ที่ dashboard.ts) และสูตรเงินห้ามมีสองแหล่ง — ดู `cashFlowPartsOf()` ด้านล่างสำหรับพิสูจน์
 *  identity จาก FinanceInput เดียวกับ `calculateFinanceReport()` (ใช้ aggregate() ตัวเดียวกัน) */
export function splitCashFlow(parts: {
  /** `financeReport()` result.transferIn — เงินสดเข้าจากการจ่ายหนี้ ก่อนหัก refund */
  transferIn: string;
  /** `financeReport()` result.refunds — ค่าสัมบูรณ์ของเงินที่คืนออกไปในช่วงนั้น */
  refunds: string;
  overpaymentIn: string;
  otherIncome: string;
  expense: string;
  memberPayouts: string;
}): { inflow: string; outflow: string } {
  return {
    inflow: fromSatang(
      toSatang(parts.transferIn) + toSatang(parts.overpaymentIn) + toSatang(parts.otherIncome),
    ),
    outflow: fromSatang(
      toSatang(parts.refunds) + toSatang(parts.expense) + toSatang(parts.memberPayouts),
    ),
  };
}

/**
 * [WO-6.5c, planner 31 ต.ค. 2026] จาก `FinanceInput` เดียวกับ `calculateFinanceReport()` ให้ parts
 * ที่ `splitCashFlow()` ต้องการ — ใช้ `aggregate()` ตัวเดียวกันทั้งคู่ (ไม่คำนวณแยกคนละทาง) จึงพิสูจน์
 * identity (inflow − outflow === netCash) ได้จริงในเทสต์ ไม่ใช่แค่สมมติ
 *
 * 🔴 เครื่องหมายของ `refunded`: `aggregate()` เก็บ `refunded` เป็น**ค่าติดลบ** (ผลรวมของ refund lines
 * ที่เป็นลบอยู่แล้ว) ⇒ `transferIn` (เงินเข้าก่อนหัก refund) = `allocated − creditPaid` (ไม่ใช่ `collected`
 * ที่หัก refund ไปแล้ว) และ `refunds` (ขนาดเงินที่คืนออก สำหรับช่อง outflow) = `-refunded` พลิกกลับเป็นบวก
 */
export function cashFlowPartsOf(input: FinanceInput): Parameters<typeof splitCashFlow>[0] {
  const a = aggregate(input);
  return {
    transferIn: fromSatang(a.allocated - a.creditPaid),
    refunds: fromSatang(-a.refunded),
    overpaymentIn: fromSatang(a.overpaymentIn),
    otherIncome: fromSatang(a.otherIncome),
    expense: fromSatang(a.expense),
    memberPayouts: fromSatang(a.memberPayouts),
  };
}

/** รวมส่วนร่วมของ calculateFinanceReport/cashFlowPartsOf ไว้ที่เดียว — กันสองฟังก์ชันคำนวณไม่ตรงกัน */
function aggregate(input: FinanceInput) {
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

  return { charged, allocated, creditPaid, refunded, outstanding, credit, collected, overpaymentIn, memberPayouts, otherIncome, expense };
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
