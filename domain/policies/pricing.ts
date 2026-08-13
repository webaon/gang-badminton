/**
 * Pricing plan
 *
 * `flat_rate` (**ADR-002**, MVP-0) + `court_plus_shuttle` (**WO-2.5-B**)
 * `monthly` มีอยู่ใน CHECK constraint ของตารางแล้ว (migration 0003)
 * แต่ **ยังไม่ implement** — เป็นงาน WO-2.5-C (MembershipBilling)
 *
 * ⚠️ ค่าเงินทุกตัวเป็น **string** ไม่ใช่ number
 *    JS number เป็น IEEE-754 ⇒ 0.1 + 0.2 !== 0.3 และคอลัมน์ในฐานข้อมูลเป็น
 *    `numeric` อยู่แล้ว การแปลงไปกลับผ่าน float คือที่ที่เงินหาย (CLAUDE.md §2.6)
 */

export const PRICING_TYPES = ['flat_rate', 'court_plus_shuttle', 'monthly'] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

/**
 * โมเดลที่ทำจริงแล้ว
 *
 * 🔴 เปิดชื่อไหนที่นี่ = `domain/billing` ต้องคิดเงินโมเดลนั้นได้จริง
 *    ห้ามเปิดล่วงหน้า — ก๊วนจะตั้งราคาไว้ทั้งเดือนแล้วเพิ่งรู้ตอนปิดรอบว่าคิดให้ไม่ได้
 */
export const IMPLEMENTED_PRICING_TYPES: readonly PricingType[] = [
  'flat_rate',
  'court_plus_shuttle',
];

export function isImplemented(type: PricingType): boolean {
  return IMPLEMENTED_PRICING_TYPES.includes(type);
}

/** พารามิเตอร์ของ `flat_rate` — ทุกคนจ่ายเท่ากันต่อหัว */
export type FlatRateParams = {
  amountPerPerson: string;
};

/**
 * พารามิเตอร์ของ `court_plus_shuttle` — หารค่าสนาม + ค่าลูกตามที่ใช้จริง
 *
 * `courtFeeTotal` = ค่าสนามทั้งนัด (ไม่ใช่ต่อคน) — หารกันตอนปิดรอบ
 * `shuttlePrice`  = ราคาต่อลูก คูณกับจำนวนลูกที่บันทึกใน `games.shuttles_used`
 *
 * ⚠️ จำนวนลูกไม่ได้อยู่ใน snapshot — เป็นสิ่งที่เกิดขึ้น**ระหว่าง**นัด
 *    snapshot แช่แข็งแค่ "ราคา" ส่วน "ปริมาณ" อ่านจาก `games` ตอนปิดรอบ
 */
export type CourtPlusShuttleParams = {
  courtFeeTotal: string;
  shuttlePrice: string;
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

/** ตรวจค่าเงินหนึ่งช่อง — ใช้ร่วมกันทุกโมเดล */
function validateMoneyField(
  raw: string | undefined,
  field: string,
  label: string,
  opts: { allowZero?: boolean; max?: number } = {},
): ValidationIssue[] {
  const value = raw?.trim() ?? '';
  const max = opts.max ?? 100000;

  if (value === '') return [{ field, message: `ต้องระบุ${label}` }];
  if (!MONEY_RE.test(value)) {
    return [{ field, message: `${label}ต้องเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง` }];
  }
  if (!opts.allowZero && Number(value) === 0) {
    return [{ field, message: `${label}ต้องมากกว่า 0` }];
  }
  if (Number(value) > max) return [{ field, message: `${label}สูงผิดปกติ` }];

  return [];
}

export function validateCourtPlusShuttle(params: CourtPlusShuttleParams): ValidationIssue[] {
  return [
    // ค่าสนาม 0 เป็นไปได้จริง (สนามของก๊วนเอง / มีสปอนเซอร์) ⇒ ไม่บล็อก
    ...validateMoneyField(params.courtFeeTotal, 'courtFeeTotal', 'ค่าสนามทั้งนัด', {
      allowZero: true,
      max: 1000000,
    }),
    ...validateMoneyField(params.shuttlePrice, 'shuttlePrice', 'ราคาลูกละ', { max: 10000 }),
  ];
}

/** รูปแบบที่เก็บใน `gang_pricing_plans.params` (jsonb) */
export function flatRateToJson(params: FlatRateParams): { amount_per_person: string } {
  return { amount_per_person: params.amountPerPerson.trim() };
}

export function courtPlusShuttleToJson(params: CourtPlusShuttleParams): {
  court_fee_total: string;
  shuttle_price: string;
} {
  return {
    court_fee_total: params.courtFeeTotal.trim(),
    shuttle_price: params.shuttlePrice.trim(),
  };
}

export function courtPlusShuttleFromJson(raw: unknown): CourtPlusShuttleParams {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    courtFeeTotal: typeof obj.court_fee_total === 'string' ? obj.court_fee_total : '0',
    shuttlePrice: typeof obj.shuttle_price === 'string' ? obj.shuttle_price : '0',
  };
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
