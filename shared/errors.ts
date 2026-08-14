/**
 * ErrorCode — สะท้อน `docs/errors.md` แบบหนึ่งต่อหนึ่ง
 *
 * 🔴 CLAUDE.md §4: "error.code ต้องมาจาก docs/errors.md เท่านั้น"
 *    เพิ่ม code ใหม่ = แก้ `docs/errors.md` ก่อน แล้วค่อยเพิ่มที่นี่
 *    ห้ามเพิ่มที่นี่ฝ่ายเดียว ไม่งั้น catalog กับโค้ดจะเริ่มเบี่ยงจากกัน
 *
 * ห้าม hardcode ข้อความ error ตามไฟล์ — frontend แปลภาษาจาก code เอง
 * ข้อความที่ติดมากับ response มีไว้ให้ developer อ่านใน log ไม่ใช่ให้ผู้ใช้อ่าน
 */
export const ERROR_CODES = [
  // Registration / Session
  'SESSION_FULL',
  'SESSION_NOT_OPEN',
  'ALREADY_REGISTERED',
  'REGISTRATION_NOT_FOUND',
  'CANCEL_CUTOFF_PASSED',
  'INVALID_REGISTRATION_TRANSITION',
  'NOT_FOUND',
  // State machine
  'INVALID_TRANSITION',
  'DIRECT_STATUS_UPDATE_FORBIDDEN',
  // Payment / Billing
  'PAYMENT_ALREADY_VERIFIED',
  'PAYMENT_NOT_FOUND',
  'ALLOCATION_EXCEEDS_PAYMENT',
  'CHARGE_NOT_FOUND',
  'CHARGES_ALREADY_COMMITTED',
  'MONTHLY_FEE_ALREADY_GENERATED',
  // Guest / Invite token
  'INVITE_TOKEN_INVALID',
  'INVITE_TOKEN_EXPIRED',
  'INVITE_TOKEN_EXHAUSTED',
  'GUEST_ACCESS_DENIED',
  'CHECKIN_TOKEN_INVALID',
  // Permission / Tenancy / Feature flag
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_GANG_MEMBER',
  'FEATURE_DISABLED',
  // Infrastructure
  'RATE_LIMITED',
  'CRON_UNAUTHORIZED',
  'WEBHOOK_SIGNATURE_INVALID',
  'VALIDATION_ERROR',
  'CONFIRMATION_REQUIRED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

/** HTTP status ต่อ code — ตรงกับคอลัมน์ HTTP ใน `docs/errors.md` */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  SESSION_FULL: 409,
  SESSION_NOT_OPEN: 409,
  ALREADY_REGISTERED: 409,
  REGISTRATION_NOT_FOUND: 404,
  CANCEL_CUTOFF_PASSED: 409,
  INVALID_REGISTRATION_TRANSITION: 409,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  DIRECT_STATUS_UPDATE_FORBIDDEN: 500,
  PAYMENT_ALREADY_VERIFIED: 409,
  PAYMENT_NOT_FOUND: 404,
  ALLOCATION_EXCEEDS_PAYMENT: 409,
  CHARGE_NOT_FOUND: 404,
  CHARGES_ALREADY_COMMITTED: 409,
  MONTHLY_FEE_ALREADY_GENERATED: 409,
  INVITE_TOKEN_INVALID: 401,
  INVITE_TOKEN_EXPIRED: 401,
  INVITE_TOKEN_EXHAUSTED: 409,
  GUEST_ACCESS_DENIED: 403,
  CHECKIN_TOKEN_INVALID: 403,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_GANG_MEMBER: 403,
  FEATURE_DISABLED: 403,
  RATE_LIMITED: 429,
  CRON_UNAUTHORIZED: 401,
  WEBHOOK_SIGNATURE_INVALID: 401,
  VALIDATION_ERROR: 400,
  CONFIRMATION_REQUIRED: 409,
  INTERNAL_ERROR: 500,
};

/**
 * แปลง error ที่โยนมาจาก Postgres/PostgREST เป็น ErrorCode
 *
 * DB functions raise แบบ `ERRCODE = 'P0001'` + `MESSAGE = '<CODE>'` (ดู docs/errors.md)
 * ⇒ ตัว message คือ code ตรงๆ
 *
 * 🔴 ถ้าเทียบไม่ตรงตัวไหนเลย = `INTERNAL_ERROR` และ **ต้อง log ต้นฉบับเต็ม**
 *    ห้าม swallow (CLAUDE.md §5) — ผู้เรียกมีหน้าที่ log `cause` ที่คืนไปด้วย
 */
export function toErrorCode(err: unknown): { code: ErrorCode; message: string; cause: unknown } {
  const raw =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);

  if (isErrorCode(raw)) {
    return { code: raw, message: raw, cause: err };
  }

  // 42501 = insufficient_privilege — client แตะของที่ไม่ได้ grant / RLS ปฏิเสธ
  // เป็นบั๊กของเราเสมอ (ดู docs/errors.md §ผลการยืนยันจาก WO-1.4)
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '42501') {
    return { code: 'FORBIDDEN', message: raw, cause: err };
  }

  return { code: 'INTERNAL_ERROR', message: raw, cause: err };
}
