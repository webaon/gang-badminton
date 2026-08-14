/**
 * Ledger — ยอดสุทธิต่อหนี้หนึ่งก้อน **[WO-2.5-D]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 baseline §การตัดสินใจสะสม (blocker):
 *
 *     ยอดสุทธิต่อคน = charge − allocations + adjustments   ← คำนวณสดเสมอ
 *     **Allocated / Adjusted / Refunded ไม่ใช่ state ของ payment**
 *
 * ⇒ ❌ ห้ามอ่านยอดค้างจาก `payments.status`
 *    สลิปหนึ่งใบครอบหนี้ได้หลายคน (จ่ายแทนเพื่อน) ⇒ status ของสลิปตอบไม่ได้ว่า
 *    "คนนี้ยังค้างเท่าไหร่" และ refund ไม่ได้เปลี่ยน status ของอะไรเลย
 *
 * ⚠️ เครื่องหมายของ adjustment (ตาม comment ใน migration 0004):
 *      บวก = เพิ่มหนี้ (correction ขึ้น) · ลบ = ลดหนี้ (refund, credit)
 *
 * pure TypeScript — ไม่มี float แตะเงินเลย (CLAUDE.md §2.6)
 */
import { fromSatang, sumSatang, toSatang, type Satang } from './money';

export type LedgerEntry = {
  chargeId: string;
  /** ยอดหนี้ตั้งต้นจาก `session_charges.amount` */
  amount: string;
  /** ยอดที่ถูกจัดสรรมาชำระแล้ว — นับเฉพาะสลิปที่ **verified** แล้วเท่านั้น */
  allocated: string[];
  /** รายการปรับยอด (`payment_adjustments.amount`) — บวกเพิ่มหนี้ ลบลดหนี้ */
  adjustments: string[];
};

export type LedgerLine = {
  chargeId: string;
  charge: string;
  allocated: string;
  adjusted: string;
  /** หนี้ที่ยังค้าง — **ติดลบได้** แปลว่าจ่ายเกิน/ได้เครดิตคืน */
  outstanding: string;
};

/**
 * ยอดสุทธิของหนี้ก้อนเดียว
 *
 * ⚠️ **ไม่ clamp ที่ 0** — จ่ายเกินแล้วได้ยอดติดลบคือข้อมูลจริงที่แอดมินต้องเห็น
 *    ถ้าปัดขึ้นเป็น 0 เงินส่วนเกินจะหายไปจากรายงานโดยไม่มีใครรู้
 */
export function ledgerLineOf(entry: LedgerEntry): LedgerLine {
  const charge = toSatang(entry.amount);
  const allocated = sumSatang(entry.allocated.map(toSatang));
  const adjusted = sumSatang(entry.adjustments.map(toSatang));

  return {
    chargeId: entry.chargeId,
    charge: fromSatang(charge),
    allocated: fromSatang(allocated),
    adjusted: fromSatang(adjusted),
    outstanding: fromSatang(charge - allocated + adjusted),
  };
}

export type LedgerSummary = {
  lines: LedgerLine[];
  /** ผลรวมหนี้ตั้งต้น */
  charged: string;
  /** ผลรวมที่จ่ายมาแล้ว */
  allocated: string;
  /** ผลรวมรายการปรับยอด */
  adjusted: string;
  /** ผลรวมที่ยังค้าง — นับเฉพาะยอดที่ยัง**เป็นบวก** (ดูคอมเมนต์ด้านล่าง) */
  outstanding: string;
  /** ผลรวมของยอดที่ติดลบ = เงินที่ต้องคืน/เครดิตค้างอยู่ */
  credit: string;
};

/**
 * สรุปทั้งชุด
 *
 * 🔴 `outstanding` กับ `credit` แยกกัน **ไม่หักกลบ**
 *    ถ้าหักกลบ ก๊วนที่มีคนค้าง 500 และอีกคนจ่ายเกิน 500 จะเห็นเป็น "เก็บครบแล้ว"
 *    ทั้งที่ยังต้องตามเก็บคนหนึ่งและต้องคืนเงินอีกคนหนึ่ง
 */
export function summarize(entries: readonly LedgerEntry[]): LedgerSummary {
  const lines = entries.map(ledgerLineOf);

  const outstanding = lines
    .map((l) => toSatang(l.outstanding))
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);

  const credit = lines
    .map((l) => toSatang(l.outstanding))
    .filter((v) => v < 0)
    .reduce((a, b) => a + b, 0);

  return {
    lines,
    charged: fromSatang(sumSatang(lines.map((l) => toSatang(l.charge)))),
    allocated: fromSatang(sumSatang(lines.map((l) => toSatang(l.allocated)))),
    adjusted: fromSatang(sumSatang(lines.map((l) => toSatang(l.adjusted)))),
    outstanding: fromSatang(outstanding),
    credit: fromSatang(credit),
  };
}

export type AdjustmentType = 'refund' | 'correction' | 'credit';

/**
 * ตรวจว่ารายการปรับยอดสมเหตุสมผลก่อนเขียนลง ledger
 *
 * 🔴 `refund` / `credit` ต้องเป็นค่า**ลบ**เสมอ — เป็น "ลดหนี้"
 *    ถ้าเผลอส่งค่าบวก หนี้จะเพิ่มขึ้นทั้งที่ตั้งใจจะคืนเงิน (เสียหายเงียบที่สุดในไฟล์นี้)
 *
 * 🔴 คืนเงินเกินกว่าที่เก็บมาจริงไม่ได้ — `refund` ถูกจำกัดด้วยยอดที่ allocate มาแล้ว
 */
export function validateAdjustment(input: {
  type: AdjustmentType;
  amount: string;
  reason: string;
  /** ยอดที่จ่ายมาแล้วของ charge นี้ (สลิปที่ verified) */
  allocated: string;
  /** รายการปรับยอดที่มีอยู่เดิม */
  existingAdjustments: readonly string[];
}): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];

  if (input.reason.trim() === '') {
    // ไม่มีเหตุผล = เดือนหน้าไม่มีใครรู้ว่าทำไมยอดไม่ตรง
    issues.push({ field: 'reason', message: 'ต้องระบุเหตุผล' });
  }

  let amount: Satang;
  try {
    amount = toSatang(input.amount);
  } catch {
    issues.push({ field: 'amount', message: 'จำนวนเงินไม่ถูกต้อง' });
    return issues;
  }

  if (amount === 0) {
    issues.push({ field: 'amount', message: 'จำนวนเงินต้องไม่เป็น 0' });
    return issues;
  }

  if ((input.type === 'refund' || input.type === 'credit') && amount > 0) {
    issues.push({
      field: 'amount',
      message: 'การคืนเงิน/ให้เครดิตต้องเป็นยอดติดลบ (ลดหนี้)',
    });
  }

  if (input.type === 'refund') {
    const refundedAlready = sumSatang(
      input.existingAdjustments.map(toSatang).filter((v) => v < 0).map((v) => -v),
    );
    const allocated = toSatang(input.allocated);

    if (allocated + amount - refundedAlready < 0) {
      issues.push({
        field: 'amount',
        message: `คืนเงินได้ไม่เกินยอดที่จ่ายมาแล้ว (${fromSatang(allocated - refundedAlready)} บาท)`,
      });
    }
  }

  return issues;
}
