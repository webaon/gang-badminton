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
import type { CancellationPolicy, PenaltyType } from '../policies/cancellation';
import { isImplemented as isPenaltyImplemented } from '../policies/cancellation';

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
  /** เศษที่เข้ารายรับก๊วน — `flat_rate` ไม่มีการหารจึงเป็น 0 เสมอ */
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

/**
 * คิดยอดต่อคน
 *
 * @throws ถ้า snapshot ใช้ pricing/penalty ที่ MVP-0 ยังไม่รองรับ
 *         — **ห้ามคิดเป็น 0 เงียบๆ** (ADR-002) เพราะก๊วนตั้งค่าไว้แล้วระบบไม่เก็บ
 *           โดยไม่มีใครรู้ คือความเสียหายที่มองไม่เห็น
 */
export function calculateSessionCharges(input: BillingInput): BillingResult {
  const { snapshot, participants, startsAt } = input;

  if (snapshot.pricingType !== 'flat_rate') {
    throw new Error(
      `ยังคิดเงินโมเดล "${snapshot.pricingType}" ไม่ได้ — MVP-0 รองรับ flat_rate เท่านั้น (ADR-002)`,
    );
  }

  const penaltyType: PenaltyType = snapshot.cancellationPolicy.penaltyType;
  if (!isPenaltyImplemented(penaltyType)) {
    throw new Error(
      `ยังคิด penalty แบบ "${penaltyType}" ไม่ได้ — MVP-0 รองรับ full_share กับ none เท่านั้น (ADR-002)`,
    );
  }

  // ปิดรอบปกติ = เก็บเต็ม · ยกเลิกกลางคัน = ใช้ค่าที่ส่งมา ไม่งั้นใช้ค่าตั้งต้นของก๊วน [ADR-004]
  const ratio = input.midwayCancelRatio ?? 1;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`สัดส่วนการเก็บเงินต้องอยู่ระหว่าง 0 ถึง 1: ${ratio}`);
  }

  const fullShare = toSatang(snapshot.amountPerPerson);

  const charges: Charge[] = [];

  for (const participant of participants) {
    const { pays, reason } = chargeReason(participant, startsAt, snapshot.cancellationPolicy);
    if (!pays) continue;

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
