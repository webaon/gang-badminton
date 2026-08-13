/**
 * Cancellation policy — schema ตรึงไว้ใน **ADR-002**
 *
 * 🔴 ค่านี้ถูก snapshot ลง `sessions.snapshot.cancellation_policy` ตอนสร้างนัด
 *    และ **billing อ่านจาก snapshot เท่านั้น** ⇒ นัดที่สร้างไปแล้วจะอ่านด้วย schema
 *    ณ ตอนนั้นตลอดไป การเปลี่ยนรูปร่างของ object นี้จึงมีต้นทุนถาวร
 *    เปลี่ยนเมื่อไหร่ต้องขึ้น `snapshot_version` ใหม่ + เขียน ADR
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework (CLAUDE.md §3)
 */

export const PENALTY_TYPES = ['full_share', 'fixed', 'percent', 'none'] as const;
export type PenaltyType = (typeof PENALTY_TYPES)[number];

export type CancellationPolicy = {
  /** ยกเลิกก่อนเวลานี้ (ชั่วโมงก่อนเริ่มนัด) = ไม่คิดเงิน */
  cutoffHours: number;
  /** false = ห้ามยกเลิกหลัง cutoff เลย (DB จะ raise `CANCEL_CUTOFF_PASSED`) */
  allowCancelAfterCutoff: boolean;
  penaltyType: PenaltyType;
  /**
   * ใช้เฉพาะ `fixed` (จำนวนเงิน) กับ `percent` (0-100)
   * เก็บเป็น string เสมอ — ห้ามใช้ number กับเงิน (CLAUDE.md §2.6)
   */
  penaltyValue?: string;
  /**
   * **[ADR-004]** สัดส่วนที่เก็บเมื่อ**ยกเลิกกลางคัน** (`in_play → cancelled`) — 0 ถึง 1
   *
   * เป็นแค่ **ค่าตั้งต้น** — แอดมินแก้ได้ตอนกดยกเลิกจริง
   * (ตอนไฟดับ/ฝนรั่วคือช่วงที่วุ่นที่สุด การมีค่าเริ่มต้นให้ลดโอกาสกรอกผิด
   *  แต่สถานการณ์จริงต่างกันทุกครั้ง จึงต้องแก้ได้)
   *
   * ⚠️ เป็นสัดส่วน ไม่ใช่เงิน จึงเป็น number ได้ — ตัวเงินที่คำนวณออกมา
   *    ยังถูกปัดเป็นจำนวนเต็มสตางค์เสมอ (ดู session-billing.ts)
   */
  midwayCancelRatio: number;
};

/**
 * ค่าเริ่มต้นของก๊วนใหม่ — ตรงกับที่ ADR-002 เลือก
 *
 * `full_share`: ยกเลิกหลัง cutoff หรือไม่มา = จ่ายเท่าคนที่มาเล่น
 * เหตุผลที่เป็น default: ก๊วนจ่ายค่าคอร์ทไปแล้วโดยไม่ขึ้นกับจำนวนคนที่มาจริง
 */
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  cutoffHours: 12,
  allowCancelAfterCutoff: true,
  penaltyType: 'full_share',
  // [ADR-004] ก๊วนจ่ายค่าคอร์ทไปแล้วบางส่วนตอนที่เล่นไปได้ครึ่งทาง — เก็บครึ่งเป็นจุดตั้งต้น
  midwayCancelRatio: 0.5,
};

/** ค่าที่ใช้เมื่อ snapshot เก่าไม่มีคีย์นี้ (ADR-004 — additive ไม่ขึ้น version) */
export const DEFAULT_MIDWAY_CANCEL_RATIO = 0.5;

/** รูปแบบที่เก็บใน jsonb — snake_case ตามคอลัมน์อื่นในฐานข้อมูล */
export type CancellationPolicyJson = {
  cutoff_hours: number;
  allow_cancel_after_cutoff: boolean;
  penalty_type: PenaltyType;
  penalty_value?: string;
  midway_cancel_ratio: number;
};

export function toJson(policy: CancellationPolicy): CancellationPolicyJson {
  return {
    cutoff_hours: policy.cutoffHours,
    allow_cancel_after_cutoff: policy.allowCancelAfterCutoff,
    penalty_type: policy.penaltyType,
    midway_cancel_ratio: policy.midwayCancelRatio,
    ...(policy.penaltyValue !== undefined ? { penalty_value: policy.penaltyValue } : {}),
  };
}

/**
 * อ่าน policy จาก jsonb ที่มาจาก DB หรือ snapshot
 *
 * ⚠️ ยอมรับ object ที่ไม่ครบคีย์ เพราะ **snapshot เก่าอาจไม่มี `penalty_type`**
 *    (ADR-002: นัดที่ snapshot ไม่มีคีย์นี้ให้ตีความเป็น `none`)
 *    ⇒ ห้ามโยน error ตรงนี้ ไม่งั้นนัดเก่าจะเปิดดูไม่ได้เลย
 */
export function fromJson(raw: unknown): CancellationPolicy {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const cutoffHours = Number(obj.cutoff_hours);
  const penaltyType = PENALTY_TYPES.includes(obj.penalty_type as PenaltyType)
    ? (obj.penalty_type as PenaltyType)
    : 'none';

  const penaltyValue = typeof obj.penalty_value === 'string' ? obj.penalty_value : undefined;

  // [ADR-004] snapshot เก่าไม่มีคีย์นี้ ⇒ ใช้ค่า fallback
  // นี่คือเหตุผลที่เพิ่มคีย์ได้โดยไม่ต้องขึ้น snapshot_version
  const rawRatio = Number(obj.midway_cancel_ratio);
  const midwayCancelRatio =
    Number.isFinite(rawRatio) && rawRatio >= 0 && rawRatio <= 1
      ? rawRatio
      : DEFAULT_MIDWAY_CANCEL_RATIO;

  return {
    cutoffHours: Number.isFinite(cutoffHours) && cutoffHours >= 0 ? cutoffHours : 0,
    allowCancelAfterCutoff: obj.allow_cancel_after_cutoff !== false,
    penaltyType,
    midwayCancelRatio,
    ...(penaltyValue !== undefined ? { penaltyValue } : {}),
  };
}

export type ValidationIssue = { field: string; message: string };

/**
 * ตรวจ policy ที่ผู้ใช้กรอก — ใช้ตอน "เขียน" ไม่ใช่ตอน "อ่าน"
 *
 * ต่างจาก `fromJson()` ที่ผ่อนปรนเพื่อให้ข้อมูลเก่าอ่านได้
 * ตอนบันทึกใหม่ต้องเข้มเพราะเรากำลังสร้างบันทึกแช่แข็งชุดใหม่
 */
export function validate(policy: CancellationPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Number.isFinite(policy.cutoffHours) || policy.cutoffHours < 0) {
    issues.push({ field: 'cutoffHours', message: 'ชั่วโมง cutoff ต้องเป็นตัวเลขไม่ติดลบ' });
  }
  if (policy.cutoffHours > 24 * 14) {
    issues.push({ field: 'cutoffHours', message: 'ชั่วโมง cutoff ยาวเกินไป (เกิน 14 วัน)' });
  }

  if (
    !Number.isFinite(policy.midwayCancelRatio) ||
    policy.midwayCancelRatio < 0 ||
    policy.midwayCancelRatio > 1
  ) {
    issues.push({
      field: 'midwayCancelRatio',
      message: 'สัดส่วนที่เก็บเมื่อยกเลิกกลางคันต้องอยู่ระหว่าง 0 ถึง 1',
    });
  }

  if (!PENALTY_TYPES.includes(policy.penaltyType)) {
    issues.push({ field: 'penaltyType', message: 'ประเภท penalty ไม่ถูกต้อง' });
    return issues;
  }

  if (policy.penaltyType === 'fixed' || policy.penaltyType === 'percent') {
    const value = Number(policy.penaltyValue);

    if (policy.penaltyValue === undefined || policy.penaltyValue.trim() === '') {
      issues.push({ field: 'penaltyValue', message: 'ต้องระบุจำนวนเมื่อเลือกแบบนี้' });
    } else if (!Number.isFinite(value) || value < 0) {
      issues.push({ field: 'penaltyValue', message: 'จำนวนต้องเป็นตัวเลขไม่ติดลบ' });
    } else if (policy.penaltyType === 'percent' && value > 100) {
      issues.push({ field: 'penaltyValue', message: 'เปอร์เซ็นต์ต้องไม่เกิน 100' });
    }
  }

  return issues;
}

/**
 * 🔴 MVP-0 รองรับเฉพาะ `full_share` และ `none` (ADR-002)
 *
 * `fixed` / `percent` ประกาศไว้ใน schema แล้วแต่ยังไม่ implement ⇒ billing ต้องเรียก
 * ตัวนี้แล้ว **raise ถ้าเจอค่าที่ยังไม่รองรับ ห้ามคิดเป็น 0 เงียบๆ**
 * (คิดเป็น 0 เงียบๆ = ก๊วนตั้ง penalty ไว้แล้วระบบไม่เก็บ โดยไม่มีใครรู้)
 */
export const IMPLEMENTED_PENALTY_TYPES: readonly PenaltyType[] = ['full_share', 'none'];

export function isImplemented(penaltyType: PenaltyType): boolean {
  return IMPLEMENTED_PENALTY_TYPES.includes(penaltyType);
}
