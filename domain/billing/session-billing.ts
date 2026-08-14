/**
 * SessionBilling — คิดยอดต่อคนตอนปิดรอบ
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ADR-001: คำนวณที่นี่ (pure TypeScript) แล้ว **commit ผ่าน
 *    `close_session_with_charges()` ที่เดียว**
 *    ❌ ห้ามย้าย logic นี้ลง SQL · ❌ ห้าม insert `session_charges` ที่อื่น
 *
 * 🔴 baseline §Snapshot rule: อ่านราคา/policy จาก **snapshot ของนัดนั้น** เท่านั้น
 *    ห้ามอ่านค่าปัจจุบันจาก `gangs` / `gang_pricing_plans`
 *    ⇒ ฟังก์ชันนี้รับ snapshot เข้ามาเป็น argument และไม่มีทางไปอ่าน DB เองได้
 *
 * MVP-0 รองรับ `flat_rate` โมเดลเดียว (ADR-002)
 */
import { fromSatang, sumSatang, toSatang, type Satang } from './money';
import { assertSplitInvariant, distributeExactShares, splitEvenly } from './rounding';
import type { CancellationPolicy, PenaltyType } from '../policies/cancellation';
import { isImplemented as isPenaltyImplemented } from '../policies/cancellation';
import {
  DEFAULT_ROUNDING_POLICY,
  isImplemented as isPricingImplemented,
  type CourtPlusShuttleParams,
  type PricingType,
  type RoundingMode,
  type RoundingPolicy,
} from '../policies/pricing';

/** สถานะของการลงชื่อ ณ ตอนปิดรอบ */
export type ParticipantStatus = 'checked_in' | 'confirmed' | 'no_show' | 'cancelled' | 'waitlist';

export type Participant = {
  registrationId: string;
  status: ParticipantStatus;
  /** เวลาที่กดยกเลิก — ใช้เทียบกับ cutoff เพื่อรู้ว่ายกเลิกช้าหรือไม่ */
  cancelledAt: Date | null;
  /**
   * สมาชิกรายเดือนหรือไม่
   *
   * ⚠️ ค่านี้อ่านจาก `gang_members` **ตอนปิดรอบ** ไม่ได้อยู่ใน snapshot
   *    เพราะเป็นคุณสมบัติของคน ไม่ใช่ของราคา (คนสมัครรายเดือนกลางเดือนได้)
   *    — บันทึกเป็นข้อสังเกตใน BACKLOG
   */
  isMonthlyMember: boolean;
};

export type BillingSnapshot = {
  pricingType: string;
  /** `flat_rate` → ราคาต่อคน เป็น string เสมอ */
  amountPerPerson: string;
  cancellationPolicy: CancellationPolicy;
  /**
   * **[WO-2.5-B]** ค่าสนาม/ค่าลูก — ต้องมีเมื่อ `pricingType === 'court_plus_shuttle'`
   * เป็น optional เพื่อให้ snapshot ของ `flat_rate` ไม่ต้องแบกคีย์ที่ไม่ใช้
   */
  courtPlusShuttle?: CourtPlusShuttleParams;
  /** ไม่ส่ง = `ceil_baht` ตาม default ของ baseline */
  roundingPolicy?: RoundingPolicy;
  /** ค่าลูกของสมาชิกรายเดือน — ไม่ส่ง = คิดตามจริง (default ของ schema) */
  monthlyMemberPaysShuttle?: boolean;
};

export type BillingInput = {
  snapshot: BillingSnapshot;
  participants: readonly Participant[];
  /** เวลาเริ่มนัด — ใช้คำนวณ cutoff */
  startsAt: Date;
  /**
   * สัดส่วนที่เก็บเมื่อ **ยกเลิกกลางคัน** (`in_play → cancelled`) — 0 ถึง 1
   *
   * **[ADR-004]** ไม่ส่งมา = ใช้ค่าตั้งต้นของก๊วนจาก
   * `snapshot.cancellationPolicy.midwayCancelRatio`
   * ส่งมา = แอดมินแก้ตอนกดยกเลิก (สถานการณ์จริงต่างกันทุกครั้ง)
   *
   * ⚠️ ส่งมาเฉพาะตอนยกเลิกกลางคันเท่านั้น — ปิดรอบปกติต้องไม่ส่ง
   *    ไม่งั้นยอดจะถูกหั่นโดยไม่มีใครตั้งใจ
   */
  midwayCancelRatio?: number;
  /**
   * จำนวนลูกที่ใช้ทั้งนัด — ผลรวมของ `games.shuttles_used` **[WO-2.5-B]**
   *
   * 🔴 ต้องส่งเมื่อ `pricingType === 'court_plus_shuttle'` ไม่งั้น throw
   *    ❌ ห้าม default เป็น 0 เงียบๆ — ก๊วนจะเก็บแต่ค่าสนาม แล้วขาดทุนค่าลูกทั้งนัด
   *    โดยไม่มีอะไรฟ้อง
   *
   * ⚠️ ตัวเลขนี้ **ไม่ได้อยู่ใน snapshot** เพราะเป็นสิ่งที่เกิดระหว่างนัด ไม่ใช่ราคา
   *    (WO-2.5-A ทำให้แก้ได้ก่อนปิดรอบ — นี่คือเหตุผลที่ใบนั้นต้องมาก่อนใบนี้)
   */
  shuttlesUsedTotal?: string;
};

export type Charge = {
  registrationId: string;
  /** string พร้อมเขียนลง `numeric(12,2)` */
  amount: string;
  breakdown: Record<string, string | number | boolean>;
};

export type BillingResult = {
  charges: Charge[];
  /** ยอดรวมที่เก็บได้ */
  totalCollected: string;
  /**
   * ส่วนต่าง `เก็บได้ − ต้นทุนจริง`
   *
   * - `flat_rate` ไม่มีการหาร ⇒ 0 เสมอ
   * - `court_plus_shuttle` = เศษจากการปัดตาม policy (ติดลบได้ถ้าโหมด `absorb`
   *   หรือถ้าค่าสนามไม่มีใครหารเพราะทุกคนเป็นสมาชิกรายเดือน)
   */
  roundingSurplus: string;
};

/** คนที่ยกเลิกช้ากว่ากำหนด */
function isLateCancel(
  participant: Participant,
  startsAt: Date,
  policy: CancellationPolicy,
): boolean {
  if (participant.status !== 'cancelled' || participant.cancelledAt === null) return false;

  const cutoff = new Date(startsAt.getTime() - policy.cutoffHours * 60 * 60 * 1000);
  return participant.cancelledAt.getTime() > cutoff.getTime();
}

/**
 * คนนี้ต้องจ่ายไหม และเพราะอะไร
 *
 * `full_share` (ADR-002): ยกเลิกหลัง cutoff หรือไม่มา = จ่ายเท่าคนที่มาเล่น
 */
function chargeReason(
  participant: Participant,
  startsAt: Date,
  policy: CancellationPolicy,
): { pays: boolean; reason: string } {
  switch (participant.status) {
    case 'checked_in':
      // มาเล่นจริง — จ่ายเต็มไม่ว่าจะได้ลงเกมกี่เกม (flat_rate คิดต่อหัว ไม่ใช่ต่อเกม)
      return { pays: true, reason: 'attended' };

    case 'confirmed':
      // ได้ที่แล้วแต่ไม่เคยเช็คอินจนปิดรอบ — ถือว่ากันที่ไว้แล้วไม่มา
      return { pays: policy.penaltyType === 'full_share', reason: 'no_check_in' };

    case 'no_show':
      return { pays: policy.penaltyType === 'full_share', reason: 'no_show' };

    case 'cancelled':
      return isLateCancel(participant, startsAt, policy)
        ? { pays: policy.penaltyType === 'full_share', reason: 'late_cancel' }
        : { pays: false, reason: 'cancelled_in_time' };

    case 'waitlist':
      // ไม่เคยได้ที่ ⇒ ไม่มีอะไรให้จ่าย
      return { pays: false, reason: 'waitlist' };
  }
}

type Payer = { participant: Participant; reason: string };

/**
 * ผลการหารต้นทุนก้อนหนึ่ง (ค่าสนาม หรือ ค่าลูก)
 *
 * `shares` = "ส่วนที่ควรจ่ายจริง" ของแต่ละคน (บวกกันได้ต้นทุนเป๊ะ)
 * ใช้คู่กับ `perPerson` เพื่อรู้ว่าใครจ่ายเกินจากการปัดไปกี่สตางค์
 */
type CostSplit = {
  perPerson: Satang;
  shares: Satang[];
  surplus: Satang;
  total: Satang;
};

/**
 * หารต้นทุนก้อนหนึ่งให้กลุ่มผู้จ่าย
 *
 * 🔴 กรณี **ไม่มีใครต้องจ่ายก้อนนี้เลย** (เช่นทุกคนเป็นสมาชิกรายเดือน ⇒ ไม่มีใครหารค่าสนาม)
 *    ต้นทุนไม่ได้หายไปไหน — ก๊วนรับเอง ⇒ `surplus` ติดลบเท่าต้นทุนก้อนนั้น
 *    ❌ ห้ามคืน 0 เฉยๆ เพราะรายงานจะดูเหมือนนัดนั้นไม่มีค่าสนาม
 */
function splitCost(total: Satang, people: number, mode: RoundingMode): CostSplit {
  if (people === 0) {
    return { perPerson: 0, shares: [], surplus: -total, total };
  }

  const split = splitEvenly(total, people, mode);
  assertSplitInvariant(split);

  return {
    perPerson: split.perPerson,
    shares: distributeExactShares(total, people),
    surplus: split.surplus,
    total,
  };
}

/**
 * คิดยอดต่อคน
 *
 * @throws ถ้า snapshot ใช้ pricing/penalty ที่ยังไม่รองรับ
 *         — **ห้ามคิดเป็น 0 เงียบๆ** (ADR-002) เพราะก๊วนตั้งค่าไว้แล้วระบบไม่เก็บ
 *           โดยไม่มีใครรู้ คือความเสียหายที่มองไม่เห็น
 */
export function calculateSessionCharges(input: BillingInput): BillingResult {
  const { snapshot, participants, startsAt } = input;

  if (!isPricingImplemented(snapshot.pricingType as PricingType)) {
    throw new Error(
      `ยังคิดเงินโมเดล "${snapshot.pricingType}" ไม่ได้ — รองรับ ${IMPLEMENTED_LABEL} เท่านั้น`,
    );
  }

  const penaltyType: PenaltyType = snapshot.cancellationPolicy.penaltyType;
  if (!isPenaltyImplemented(penaltyType)) {
    throw new Error(
      `ยังคิด penalty แบบ "${penaltyType}" ไม่ได้ — รองรับ full_share กับ none เท่านั้น (ADR-002)`,
    );
  }

  // ปิดรอบปกติ = เก็บเต็ม · ยกเลิกกลางคัน = ใช้ค่าที่ส่งมา ไม่งั้นใช้ค่าตั้งต้นของก๊วน [ADR-004]
  const ratio = input.midwayCancelRatio ?? 1;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`สัดส่วนการเก็บเงินต้องอยู่ระหว่าง 0 ถึง 1: ${ratio}`);
  }

  const payers: Payer[] = [];
  for (const participant of participants) {
    const { pays, reason } = chargeReason(participant, startsAt, snapshot.cancellationPolicy);
    if (pays) payers.push({ participant, reason });
  }

  return snapshot.pricingType === 'court_plus_shuttle'
    ? courtPlusShuttleCharges(input, payers, ratio)
    : flatRateCharges(input, payers, ratio);
}

const IMPLEMENTED_LABEL = 'flat_rate กับ court_plus_shuttle';

/**
 * `flat_rate` — ทุกคนจ่ายเท่ากันต่อหัว ไม่มีการหาร ⇒ ไม่มีเศษ (ADR-002)
 *
 * 🔴 ห้ามแก้พฤติกรรมของฟังก์ชันนี้เมื่อเพิ่มโมเดลใหม่
 *    นัดเก่าที่ snapshot เป็น `flat_rate` ต้องคิดได้ยอดเดิมทุกบาทตลอดไป
 */
function flatRateCharges(input: BillingInput, payers: Payer[], ratio: number): BillingResult {
  const fullShare = toSatang(input.snapshot.amountPerPerson);
  const charges: Charge[] = [];

  for (const { participant, reason } of payers) {
    // สมาชิกรายเดือน: ค่าสนามเป็น 0 เสมอ (baseline §การตัดสินใจสะสม)
    // `flat_rate` ไม่ได้แยกค่าลูกออกมา ⇒ ไม่มีอะไรเหลือให้เก็บ
    const base = participant.isMonthlyMember ? 0 : fullShare;

    // ปัดลงเป็นสตางค์เต็ม — ratio เป็นทศนิยมได้ แต่เงินต้องเป็นจำนวนเต็มสตางค์
    const amount = Math.floor(base * ratio);

    charges.push({
      registrationId: participant.registrationId,
      amount: fromSatang(amount),
      breakdown: {
        flat_rate: fromSatang(base),
        reason,
        is_monthly_member: participant.isMonthlyMember,
        ...(ratio !== 1 ? { midway_cancel_ratio: ratio } : {}),
        // flat_rate ไม่มีการหาร ⇒ ไม่มีเศษ (ดูคอมเมนต์ใน rounding.ts)
        rounding_surplus: '0.00',
      },
    });
  }

  const totalCollected = sumSatang(charges.map((c) => toSatang(c.amount)));

  return {
    charges,
    totalCollected: fromSatang(totalCollected),
    roundingSurplus: fromSatang(0),
  };
}

/**
 * `court_plus_shuttle` — **[WO-2.5-B]** หารค่าสนาม + ค่าลูกตามที่ใช้จริง
 *
 * ต้นทุนจริง = ค่าสนามทั้งนัด + (ราคาต่อลูก × จำนวนลูกที่ใช้)
 *
 * แยกสองก้อนเพราะกลุ่มผู้จ่ายไม่เหมือนกัน (baseline §การตัดสินใจสะสม):
 *   · ค่าสนาม — สมาชิกรายเดือน **ไม่จ่าย** เสมอ (จ่ายไปแล้วในค่ารายเดือน)
 *   · ค่าลูก  — จ่ายหรือไม่ ขึ้นกับ `monthly_member_pays_shuttle` ของแผนราคา
 *
 * 🔴 หารสองก้อนแยกกันแล้วค่อยรวม ≠ หารยอดรวมก้อนเดียว
 *    ถ้ารวมก่อนหาร สมาชิกรายเดือนจะได้ส่วนลดค่าลูกไปด้วยโดยไม่มีใครตั้งใจ
 */
function courtPlusShuttleCharges(
  input: BillingInput,
  payers: Payer[],
  ratio: number,
): BillingResult {
  const { snapshot } = input;
  const params = snapshot.courtPlusShuttle;

  if (!params) {
    throw new Error('snapshot เป็น court_plus_shuttle แต่ไม่มีค่าสนาม/ราคาลูก — คิดเงินไม่ได้');
  }
  if (input.shuttlesUsedTotal === undefined || input.shuttlesUsedTotal === null) {
    // ❌ ห้าม default เป็น 0 — ก๊วนจะขาดค่าลูกทั้งนัดโดยไม่มีอะไรฟ้อง
    throw new Error('court_plus_shuttle ต้องรู้จำนวนลูกที่ใช้ทั้งนัดก่อนจึงคิดเงินได้');
  }

  const mode: RoundingMode = (snapshot.roundingPolicy ?? DEFAULT_ROUNDING_POLICY).mode;
  const monthlyPaysShuttle = snapshot.monthlyMemberPaysShuttle ?? true;

  const courtCost = toSatang(params.courtFeeTotal);
  // `toSatang` = เลข ×100 ⇒ ที่นี่คือ "จำนวนลูก ×100" (ลูกแบ่งครึ่งได้ ⇒ ทศนิยมถูกต้อง)
  // คูณกันในโลกจำนวนเต็มแล้วหาร 100 ครั้งเดียว ⇒ ไม่มี float เข้ามาเกี่ยว (CLAUDE.md §2.6)
  const shuttleUnits = toSatang(input.shuttlesUsedTotal);
  const shuttleCost = Math.round((toSatang(params.shuttlePrice) * shuttleUnits) / 100);

  const courtPayers = payers.filter((p) => !p.participant.isMonthlyMember);
  const shuttlePayers = monthlyPaysShuttle ? payers : courtPayers;

  const courtSplit = splitCost(courtCost, courtPayers.length, mode);
  const shuttleSplit = splitCost(shuttleCost, shuttlePayers.length, mode);

  const courtIndex = new Map(courtPayers.map((p, i) => [p.participant.registrationId, i]));
  const shuttleIndex = new Map(shuttlePayers.map((p, i) => [p.participant.registrationId, i]));

  const charges: Charge[] = payers.map(({ participant, reason }) => {
    const ci = courtIndex.get(participant.registrationId);
    const si = shuttleIndex.get(participant.registrationId);

    const courtPart = ci === undefined ? 0 : courtSplit.perPerson;
    const shuttlePart = si === undefined ? 0 : shuttleSplit.perPerson;

    // ส่วนที่ "ควรจ่ายจริง" ก่อนปัด — ใช้คำนวณเศษรายคนให้ reconcile ได้
    const exactShare =
      (ci === undefined ? 0 : courtSplit.shares[ci]) +
      (si === undefined ? 0 : shuttleSplit.shares[si]);

    const amount = Math.floor((courtPart + shuttlePart) * ratio);

    return {
      registrationId: participant.registrationId,
      amount: fromSatang(amount),
      breakdown: {
        court_fee: fromSatang(Math.floor(courtPart * ratio)),
        shuttle_fee: fromSatang(Math.floor(shuttlePart * ratio)),
        shuttles_used_total: input.shuttlesUsedTotal ?? '0',
        rounding_mode: mode,
        // เศษของ**คนนี้**: จ่ายจริง − ส่วนที่ควรจ่าย ⇒ บวกกันทุกคนได้ surplus ของนัด
        // (เมื่อ ratio = 1 — ถ้ายกเลิกกลางคัน ส่วนต่างที่ก๊วนดูดซับอยู่ที่ระดับนัด)
        rounding_surplus: fromSatang(amount - Math.floor(exactShare * ratio)),
        reason,
        is_monthly_member: participant.isMonthlyMember,
        ...(ratio !== 1 ? { midway_cancel_ratio: ratio } : {}),
      },
    };
  });

  const totalCollected = sumSatang(charges.map((c) => toSatang(c.amount)));

  return {
    charges,
    totalCollected: fromSatang(totalCollected),
    // นิยามเดียว: เก็บได้ − ต้นทุนจริง (ไม่ได้เอา surplus ของสองก้อนมาบวกแล้วหวังว่าตรง)
    roundingSurplus: fromSatang(totalCollected - (courtCost + shuttleCost)),
  };
}

/** ต้นทุนจริงของนัดแบบ `court_plus_shuttle` — ใช้ตรวจ invariant */
export function courtPlusShuttleCost(
  params: CourtPlusShuttleParams,
  shuttlesUsedTotal: string,
): Satang {
  return (
    toSatang(params.courtFeeTotal) +
    Math.round((toSatang(params.shuttlePrice) * toSatang(shuttlesUsedTotal)) / 100)
  );
}

/**
 * ปิดรอบทั้งที่ไม่มีใครเช็คอินเลย = ต้องให้คนยืนยันก่อน — **[WO-2.5-A]**
 *
 * 🔴 `penalty_type = 'full_share'` ทำให้คนที่ได้ที่แต่ไม่เคยเช็คอิน ถูกเก็บเต็ม
 *    เท่ากับคนไม่มา ⇒ วันที่แอดมินลืมเปิดคอนโซล ทั้งก๊วนจะถูกเก็บด้วยเหตุผลผิด
 *    และเงินถูก commit ไปแล้วแก้ไม่ได้ (ADR-001)
 *
 * ⚠️ คืน true = "ให้ยืนยัน" ไม่ใช่ "ห้ามปิด" — วันที่ไม่มีใครมาจริงๆ ก็ต้องปิดรอบได้
 */
export function requiresCloseConfirmation(participants: Participant[]): boolean {
  const anyCheckedIn = participants.some((p) => p.status === 'checked_in');
  if (anyCheckedIn) return false;

  // ไม่มีใครได้ที่เลย (นัดร้าง) ก็ไม่มีอะไรให้เตือน
  return participants.some((p) => p.status === 'confirmed');
}

/**
 * ต้นทุนจริงของนัดตามโมเดล `flat_rate`
 *
 * ใช้ตรวจ invariant: `sum(charges) − ต้นทุนจริง = surplus`
 * สำหรับ flat_rate ต้นทุนคือ "ราคาต่อคน × จำนวนคนที่ต้องจ่าย" ⇒ surplus = 0 เสมอ
 */
export function expectedCost(result: BillingResult, amountPerPerson: string): Satang {
  const payers = result.charges.filter((c) => toSatang(c.amount) > 0).length;
  return toSatang(amountPerPerson) * payers;
}
