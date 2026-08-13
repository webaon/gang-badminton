/**
 * Pricing plan — MVP-0 รองรับ `flat_rate` โมเดลเดียว (**ADR-002**)
 *
 * `court_plus_shuttle` และ `monthly` มีอยู่ใน CHECK constraint ของตารางแล้ว
 * (migration 0003) แต่ **ยังไม่ implement** — เป็นงาน Phase 2.5
 *
 * ⚠️ ค่าเงินทุกตัวเป็น **string** ไม่ใช่ number
 *    JS number เป็น IEEE-754 ⇒ 0.1 + 0.2 !== 0.3 และคอลัมน์ในฐานข้อมูลเป็น
 *    `numeric` อยู่แล้ว การแปลงไปกลับผ่าน float คือที่ที่เงินหาย (CLAUDE.md §2.6)
 */

export const PRICING_TYPES = ['flat_rate', 'court_plus_shuttle', 'monthly'] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

/** โมเดลที่ MVP-0 ทำจริง — ตัวอื่นอยู่ใน Phase 2.5 */
export const IMPLEMENTED_PRICING_TYPES: readonly PricingType[] = ['flat_rate'];

export function isImplemented(type: PricingType): boolean {
  return IMPLEMENTED_PRICING_TYPES.includes(type);
}

/** พารามิเตอร์ของ `flat_rate` — ทุกคนจ่ายเท่ากันต่อหัว */
export type FlatRateParams = {
  amountPerPerson: string;
};

export const ROUNDING_MODES = ['ceil_baht', 'ceil_satang', 'absorb'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export type RoundingPolicy = {
  mode: RoundingMode;
  /** เศษที่เกินจากการปัดเข้าใคร — MVP-0 มีแค่ `gang` */
  surplusTo: 'gang';
};

export const DEFAULT_ROUNDING_POLICY: RoundingPolicy = {
  mode: 'ceil_baht',
  surplusTo: 'gang',
};

export type ValidationIssue = { field: string; message: string };

/** ตัวเลขเงินที่ยอมรับ: ไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง */
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

export function validateFlatRate(params: FlatRateParams): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const raw = params.amountPerPerson?.trim() ?? '';

  if (raw === '') {
    issues.push({ field: 'amountPerPerson', message: 'ต้องระบุราคาต่อคน' });
    return issues;
  }
  if (!MONEY_RE.test(raw)) {
    issues.push({
      field: 'amountPerPerson',
      message: 'ราคาต้องเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง',
    });
    return issues;
  }
  if (Number(raw) === 0) {
    // ไม่ใช่ error ทางเทคนิค แต่แทบจะแน่นอนว่ากรอกผิด — กันไว้ดีกว่าให้ก๊วนเก็บเงินไม่ได้ทั้งนัด
    issues.push({ field: 'amountPerPerson', message: 'ราคาต่อคนต้องมากกว่า 0' });
  }
  if (Number(raw) > 100000) {
    issues.push({ field: 'amountPerPerson', message: 'ราคาต่อคนสูงผิดปกติ' });
  }

  return issues;
}

/** รูปแบบที่เก็บใน `gang_pricing_plans.params` (jsonb) */
export function flatRateToJson(params: FlatRateParams): { amount_per_person: string } {
  return { amount_per_person: params.amountPerPerson.trim() };
}

export function flatRateFromJson(raw: unknown): FlatRateParams {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    amountPerPerson: typeof obj.amount_per_person === 'string' ? obj.amount_per_person : '0',
  };
}

export function roundingToJson(policy: RoundingPolicy): { mode: RoundingMode; surplus_to: string } {
  return { mode: policy.mode, surplus_to: policy.surplusTo };
}

export function roundingFromJson(raw: unknown): RoundingPolicy {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const mode = ROUNDING_MODES.includes(obj.mode as RoundingMode)
    ? (obj.mode as RoundingMode)
    : DEFAULT_ROUNDING_POLICY.mode;

  return { mode, surplusTo: 'gang' };
}
