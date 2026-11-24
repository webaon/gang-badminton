/**
 * แยกยอดต่อคนเป็น ค่าคอร์ท / ค่าลูก / ค่าปรับ / ปัดเศษ — **[WO-B12]** (หน้าปิดรอบ h28)
 *
 * 🔴 นี่คือ "การแสดงผล" ของผลที่ `calculateSessionCharges()` คิดไว้แล้ว — **ไม่ใช่สูตรเงินใหม่**
 *    · ยอดต่อคน (`amount`) มาจาก `BillingResult` ตรงๆ ไม่ถูกคำนวณซ้ำ
 *    · `rounding_surplus`, `reason`, `is_monthly_member`, `midway_cancel_ratio` อ่านจาก `breakdown` ที่เอนจินเขียนไว้
 *    · "ส่วนที่ควรจ่ายจริง" แยกค่าคอร์ท/ค่าลูก ใช้ `distributeExactShares()` ตัวเดียวกับที่เอนจินใช้
 *      และ**ตรวจกลับกับผลของเอนจินทุกแถว** — ถ้าไม่ตรง throw (ดีกว่าหน้าจอโกหกเรื่องเงิน)
 *
 * ต่อแถว: `court + shuttle + penalty + rounding = amount` เสมอ (หน่วยสตางค์ ไม่มี float)
 *
 * กติกาการจัดหมวด:
 *   · `reason = 'attended'`  → ส่วนที่ควรจ่ายแยกเป็น court / shuttle
 *   · เหตุผลอื่นที่ถูกเก็บ (no_check_in / no_show / late_cancel = ค่าปรับแบบ full_share ADR-002)
 *     → ส่วนที่ควรจ่ายทั้งก้อนเข้าช่อง `penalty` (court/shuttle = 0) ไม่นับซ้ำ
 *   · `rounding` = จ่ายจริง − ส่วนที่ควรจ่าย (`breakdown.rounding_surplus` ของเอนจิน)
 *   · `flat_rate` ไม่แยกค่าลูก: ราคาต่อหัวทั้งก้อนอยู่ช่อง `court` · rounding = 0
 */
import { distributeExactShares } from './rounding';
import { fromSatang, sumSatang, toSatang, type Satang } from './money';
import {
  courtPlusShuttleCost,
  type BillingResult,
  type BillingSnapshot,
} from './session-billing';

/** เหตุผลที่ถูกเก็บเงินตามปกติ (ไม่ใช่ค่าปรับ) */
const NON_PENALTY_REASONS = new Set(['attended']);

export type ChargeParts = {
  /** ทุกช่องเป็น string `numeric(12,2)` — บวกกันได้ `amount` */
  court: string;
  shuttle: string;
  penalty: string;
  rounding: string;
  amount: string;
};

export type ChargeBreakdownResult = {
  /** key = registrationId — เฉพาะคนที่ถูกเก็บ (คนที่ไม่ถูกเก็บไม่มีแถว) */
  parts: Map<string, ChargeParts>;
  /** ผลรวมแต่ละช่องของทุกแถว: court + shuttle + penalty + rounding = totalCollected */
  courtCostTotal: string;
  shuttleCostTotal: string;
  penaltyTotal: string;
  /** ผลรวมเศษรายคน */
  roundingTotal: string;
  /**
   * ต้นทุนที่ไม่มีใครหาร (เช่นทุกคนเป็นสมาชิกรายเดือน ⇒ ไม่มีใครหารค่าสนาม ก๊วนรับเอง) — ปกติ `0.00`
   * เชื่อมกับ `roundingSurplus` ของนัด: `roundingSurplus = roundingTotal − absorbedCostTotal` (เมื่อปิดรอบเต็ม)
   */
  absorbedCostTotal: string;
};

function ratioOf(breakdown: Record<string, string | number | boolean>): number {
  const raw = breakdown.midway_cancel_ratio;
  return raw === undefined ? 1 : Number(raw);
}

export function breakdownCharges(input: {
  result: BillingResult;
  snapshot: BillingSnapshot;
  shuttlesUsedTotal?: string;
}): ChargeBreakdownResult {
  const { result, snapshot } = input;
  const charges = result.charges;

  const isCps = snapshot.pricingType === 'court_plus_shuttle';

  // ---- ส่วนที่ควรจ่ายจริงของแต่ละคน (ก่อน ratio) แยกค่าคอร์ท / ค่าลูก ----
  const courtExact = new Map<string, Satang>();
  const shuttleExact = new Map<string, Satang>();
  let absorbed = 0;

  if (isCps) {
    const params = snapshot.courtPlusShuttle;
    if (!params || input.shuttlesUsedTotal === undefined) {
      throw new Error('court_plus_shuttle ต้องมีค่าสนาม/ราคาลูกและจำนวนลูก — แยกยอดไม่ได้');
    }
    const courtCost = toSatang(params.courtFeeTotal);
    const shuttleCost = courtPlusShuttleCost(params, input.shuttlesUsedTotal) - courtCost;

    const monthlyPaysShuttle = snapshot.monthlyMemberPaysShuttle ?? true;
    const isMonthly = (i: number) => charges[i].breakdown.is_monthly_member === true;

    // charges ถูกสร้างตามลำดับ payers ⇒ ลำดับเดียวกับที่เอนจินแจกเศษ
    const courtIdx = charges.map((_, i) => i).filter((i) => !isMonthly(i));
    const shuttleIdx = monthlyPaysShuttle ? charges.map((_, i) => i) : courtIdx;

    const courtShares = courtIdx.length > 0 ? distributeExactShares(courtCost, courtIdx.length) : [];
    const shuttleShares =
      shuttleIdx.length > 0 ? distributeExactShares(shuttleCost, shuttleIdx.length) : [];

    courtIdx.forEach((ci, k) => courtExact.set(charges[ci].registrationId, courtShares[k]));
    shuttleIdx.forEach((si, k) => shuttleExact.set(charges[si].registrationId, shuttleShares[k]));

    absorbed =
      (courtIdx.length > 0 ? 0 : courtCost) + (shuttleIdx.length > 0 ? 0 : shuttleCost);
  }

  const parts = new Map<string, ChargeParts>();
  const sums = { court: 0, shuttle: 0, penalty: 0, rounding: 0 };

  for (const charge of charges) {
    const amount = toSatang(charge.amount);
    const ratio = ratioOf(charge.breakdown);
    const rounding = toSatang(String(charge.breakdown.rounding_surplus ?? '0.00'));

    let courtPart: Satang;
    let shuttlePart: Satang;

    if (isCps) {
      const c = courtExact.get(charge.registrationId) ?? 0;
      const s = shuttleExact.get(charge.registrationId) ?? 0;
      const base = Math.floor((c + s) * ratio);

      // 🔴 ตรวจกลับกับเอนจิน: จ่ายจริง − เศษ = ส่วนที่ควรจ่าย (หลัง ratio)
      if (base !== amount - rounding) {
        throw new Error(
          `แยกยอดไม่ตรงกับผลคิดเงิน (registration ${charge.registrationId}): ` +
            `ส่วนที่ควรจ่าย ${base} ≠ ${amount - rounding} — ห้ามแสดงตัวเลขนี้`,
        );
      }
      courtPart = Math.floor(c * ratio);
      shuttlePart = base - courtPart;
    } else {
      // flat_rate: ไม่มีการหาร ⇒ ไม่มีเศษ · ราคาต่อหัวทั้งก้อนเป็นช่อง court
      courtPart = amount - rounding;
      shuttlePart = 0;
    }

    const isPenalty = !NON_PENALTY_REASONS.has(String(charge.breakdown.reason));
    const penalty = isPenalty ? courtPart + shuttlePart : 0;
    const court = isPenalty ? 0 : courtPart;
    const shuttle = isPenalty ? 0 : shuttlePart;

    if (court + shuttle + penalty + rounding !== amount) {
      throw new Error(`แยกยอดแล้วรวมไม่เท่ายอดเดิม (registration ${charge.registrationId})`);
    }

    parts.set(charge.registrationId, {
      court: fromSatang(court),
      shuttle: fromSatang(shuttle),
      penalty: fromSatang(penalty),
      rounding: fromSatang(rounding),
      amount: charge.amount,
    });
    sums.court += court;
    sums.shuttle += shuttle;
    sums.penalty += penalty;
    sums.rounding += rounding;
  }

  return {
    parts,
    courtCostTotal: fromSatang(sums.court),
    shuttleCostTotal: fromSatang(sums.shuttle),
    penaltyTotal: fromSatang(sums.penalty),
    roundingTotal: fromSatang(sums.rounding),
    absorbedCostTotal: fromSatang(absorbed),
  };
}

/** ใช้ในเทสต์/ตรวจ: ผลรวมสี่ช่อง = ยอดเก็บรวม */
export function sumOfCategories(r: ChargeBreakdownResult): string {
  return fromSatang(
    sumSatang([r.courtCostTotal, r.shuttleCostTotal, r.penaltyTotal, r.roundingTotal].map(toSatang)),
  );
}
