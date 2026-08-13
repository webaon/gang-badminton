/**
 * นโยบายปัดเศษ — baseline §การตัดสินใจสะสม เรียกข้อนี้ว่า **blocker**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 invariant ที่ต้องจริงเสมอ (baseline §Verification):
 *
 *     sum(ยอดต่อคน) − ต้นทุนจริง = rounding surplus ตาม policy
 *
 * ทุกจำนวนคน ทุก strategy — รวมจำนวนที่หารไม่ลงตัวอย่าง 3, 7, 13 คน
 * เศษที่เกินบันทึกเป็นรายรับก๊วน เพื่อให้รายงาน reconcile ได้
 *
 * ⚠️ โมดูลนี้ทำงานด้วย **จำนวนเต็มสตางค์** ล้วน ไม่มี float เข้ามาเกี่ยวเลย
 *    ⇒ invariant เป็นจริงแบบพิสูจน์ได้ ไม่ใช่ "จริงภายในความคลาดเคลื่อนที่ยอมรับได้"
 *
 * ⚠️ MVP-0 เลือก `flat_rate` (ADR-002) ซึ่ง **ไม่มีการหาร** ⇒ โมดูลนี้ยังไม่ถูกใช้
 *    ในเส้นทางคิดเงินจริง แต่ implement + พิสูจน์ไว้ก่อน เพราะ:
 *      1. DoD ของ WO-2.8 บังคับ invariant test ที่ 3/7/13 คน ซึ่งจะไร้ความหมาย
 *         ถ้าไม่มีกลไกหารให้ทดสอบ
 *      2. `court_plus_shuttle` ใน Phase 2.5 ต้องใช้ทันที
 */
import type { Satang } from './money';

export type RoundingMode = 'ceil_baht' | 'ceil_satang' | 'absorb';

export type SplitResult = {
  /** ยอดที่แต่ละคนต้องจ่าย (เท่ากันทุกคน) */
  perPerson: Satang;
  /**
   * ส่วนต่างระหว่างยอดที่เก็บได้กับต้นทุนจริง
   * - บวก = เก็บเกิน → เข้ารายรับก๊วน
   * - ลบ  = ก๊วนดูดซับเอง (`absorb`)
   */
  surplus: Satang;
  /** ต้นทุนจริงที่ใช้คำนวณ — เก็บไว้ให้ breakdown ตรวจสอบย้อนหลังได้ */
  total: Satang;
  people: number;
};

/**
 * หารต้นทุนให้เท่ากันทุกคนแล้วปัดตาม policy
 *
 * `ceil_baht`   ปัดขึ้นเป็นหน่วยบาท (ค่า default ของ baseline)
 * `ceil_satang` ปัดขึ้นเป็นหน่วยสตางค์
 * `absorb`      ปัดลง — ก๊วนรับส่วนต่างเอง ⇒ `surplus` ติดลบได้
 */
export function splitEvenly(total: Satang, people: number, mode: RoundingMode): SplitResult {
  if (!Number.isInteger(total)) {
    throw new Error(`ต้นทุนต้องเป็นจำนวนเต็มสตางค์: ${total}`);
  }
  if (!Number.isInteger(people) || people < 1) {
    throw new Error(`จำนวนคนต้องเป็นจำนวนเต็มตั้งแต่ 1: ${people}`);
  }

  const exact = total / people;

  const perPerson =
    mode === 'ceil_baht'
      ? Math.ceil(exact / 100) * 100
      : mode === 'ceil_satang'
        ? Math.ceil(exact)
        : Math.floor(exact);

  return {
    perPerson,
    // นี่คือนิยามของ invariant โดยตรง — ไม่ได้คำนวณแยกทางแล้วหวังว่าจะตรงกัน
    surplus: perPerson * people - total,
    total,
    people,
  };
}

/**
 * แบ่งต้นทุนเป็น "ส่วนที่ควรจ่ายจริง" ของแต่ละคน แบบจำนวนเต็มสตางค์ที่**บวกกันได้ต้นทุนเป๊ะ**
 *
 * ใช้วิธี largest remainder: คนแรกๆ รับเศษคนละ 1 สตางค์จนเศษหมด
 * ⇒ `sum(shares) === total` เสมอ ไม่ว่าจะหารลงตัวหรือไม่
 *
 * 🔴 ทำไมต้องมี: `rounding_surplus` ต่อ charge จะมีความหมายก็ต่อเมื่อรู้ว่า
 *    "ส่วนที่ควรจ่ายจริง" ของคนนั้นคือเท่าไหร่ — ไม่งั้นเก็บได้แค่ตัวเลขระดับนัด
 *    แล้ว reconcile รายคนไม่ได้ (คนทักว่า "ทำไมผมจ่าย 251 ทั้งที่หาร 3 ได้ 250.33")
 *
 * ⚠️ ลำดับมีผล — คนที่อยู่ index ต้นๆ รับเศษก่อน แต่ผลรวมเท่ากันเสมอ
 *    เรียก billing ด้วยลำดับ participants ที่คงที่ ⇒ คิดใหม่กี่รอบก็ได้ผลเดิม
 */
export function distributeExactShares(total: Satang, people: number): Satang[] {
  if (!Number.isInteger(total)) {
    throw new Error(`ต้นทุนต้องเป็นจำนวนเต็มสตางค์: ${total}`);
  }
  if (!Number.isInteger(people) || people < 1) {
    throw new Error(`จำนวนคนต้องเป็นจำนวนเต็มตั้งแต่ 1: ${people}`);
  }

  const base = Math.floor(total / people);
  const remainder = total - base * people;

  return Array.from({ length: people }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * ตรวจ invariant ให้ชัดเจนในที่เดียว
 *
 * เรียกจาก billing ก่อนคืนผลลัพธ์ ⇒ ถ้าวันหนึ่งมีคนแก้สูตรจนเพี้ยน
 * ระบบจะดังตั้งแต่ตอนคำนวณ ไม่ใช่ตอนที่รายงานไม่ลงตัวในอีกสามเดือน
 */
export function assertSplitInvariant(result: SplitResult): void {
  const collected = result.perPerson * result.people;

  if (collected - result.total !== result.surplus) {
    throw new Error(
      `invariant ปัดเศษพัง: เก็บได้ ${collected} − ต้นทุน ${result.total} ≠ surplus ${result.surplus}`,
    );
  }
}
