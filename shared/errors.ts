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
  'INSUFFICIENT_CREDIT',
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

/**
 * [WO-B2.2] error ที่รู้ code ของตัวเอง — `toErrorCode()` ให้ความไว้วางใจพิเศษกับ error ชนิดนี้เท่านั้น
 * (ดู `instanceof AppError` ด้านล่าง — ไม่ใช่แค่ duck-type เช็ค `.code` เฉยๆ)
 *
 * 🔴 อยู่ที่นี่ (ไม่ใช่ `shared/action.ts`) เพราะ `toErrorCode()` ต้อง `instanceof` มันได้โดยไม่เกิด
 * circular import (action.ts import toErrorCode จากไฟล์นี้อยู่แล้ว) — `shared/action.ts` ยัง
 * `export { AppError }` ต่อให้ 30+ ไฟล์ที่ import จาก `@/shared/action` อยู่แล้วไม่ต้องแก้ทุกจุด
 *
 * `reason`/`reasonMeta` เป็น field เสริมแบบ additive (optional, default undefined) — ใช้ตอนที่ action
 * เดียวต้องการแยกเหตุผลย่อยภายใต้ ErrorCode เดียวกัน (เช่น leaveGang) ไม่ตั้งสองตัวนี้ = พฤติกรรมเดิมเป๊ะ
 * ห้ามใส่ PG detail ดิบหรือ id ภายใน — reasonMeta ต้องเป็นค่าที่ผ่าน whitelist ของ caller เองแล้วเท่านั้น
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly reason?: string;
  readonly reasonMeta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    options?: { cause?: unknown; reason?: string; reasonMeta?: Record<string, unknown> },
  ) {
    super(message ?? code, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.reason = options?.reason;
    this.reasonMeta = options?.reasonMeta;
  }
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
  INSUFFICIENT_CREDIT: 409,
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
 *
 * [WO-B2.2] `reason`/`reasonMeta` เป็นฟิลด์เสริมแบบ additive — มีค่าเฉพาะเมื่อ error ที่โยนมาเป็น
 * `AppError` ที่ตั้ง `.reason`/`.reasonMeta` ไว้ตอนสร้าง (ดู `shared/action.ts`) เคสอื่นทั้งหมด (error
 * ดิบจาก Postgrest, Error ธรรมดา, ฯลฯ) ได้ `undefined` เหมือนเดิมทุกประการ — ไม่กระทบ action อื่นเลย
 */
export function toErrorCode(err: unknown): {
  code: ErrorCode;
  message: string;
  cause: unknown;
  reason?: string;
  reasonMeta?: Record<string, unknown>;
} {
  const raw =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);

  // AppError (ประกาศไว้ด้านบนในไฟล์นี้เอง) ถือ code ของตัวเองใน `.code` — ต้องหยิบก่อนเทียบ message
  // ไม่งั้น `new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อนัด')` (message ≠ code) ตกเป็น INTERNAL_ERROR ทุกครั้ง
  //
  // [WO-B2.2 · QA plumbing-isolation fix] `reason`/`reasonMeta` หยิบออกมาได้ต่อเมื่อ `err instanceof
  // AppError` เท่านั้น — ไม่ใช่แค่ duck-type เช็ค `'code' in err` เฉยๆ เหมือนตอนแรก (ซึ่ง object ธรรมดา
  // ที่บังเอิญมี `.code` ตรงกับ ErrorCode ตัวใดตัวหนึ่ง + มี `.reason`/`.reasonMeta` ของตัวเองติดมาด้วย
  // (เช่น error จาก library อื่น หรือ error ที่ไม่ได้ผ่าน `new AppError()`) จะหลุด reason ออกไปได้ทันที
  // โดยไม่ผ่าน whitelist ของ mapper ใดๆเลย — ตรวจพบจริงจาก QA's static review ด้วย counterexample object
  // ที่ปลอม `.code`+`.reason`+`.reasonMeta` ขึ้นมาตรงๆ) ส่วน `.code` เฉยๆ (ไม่มี reason) ยังหยิบได้แม้
  // ไม่ใช่ AppError จริง เพื่อความเข้ากันได้เดิม (ของ error ที่ไม่ใช่ AppError แต่บังเอิญมี .code ที่ตรง)
  //
  // [planner, WO-B2.2 · F1] ใช้ `Object.hasOwn()` ไม่ใช่แค่ `typeof err.reason === 'string'` เฉยๆ —
  // `in`/property-access ธรรมดาอ่านทะลุ prototype chain ได้ ถ้าใครเผลอ (หรือโค้ดอื่นตั้งใจ) เซ็ต
  // `AppError.prototype.reason = '...'` ไว้ (prototype pollution) ทุก instance ของ AppError ที่ไม่ได้
  // ตั้ง `.reason` ของตัวเองจะอ่านได้ค่าที่ inherit มาแทนทันที — `hasOwn` บังคับว่าต้องเป็น own property
  // ของ instance นั้นจริงๆเท่านั้น (ตรงกับที่ `new AppError()`'s constructor ตั้งไว้ด้วย `this.reason=`)
  //
  // ⚠️ reason/reasonMeta ที่คืนจากฟังก์ชันนี้ **ยังไม่ผ่าน allowlist ของ action เฉพาะเจาะจงเลย** — นั่นคือ
  // งานของ `runAction()`'s `opts.reasons`/`opts.reasonMetaKeys` (ดู `shared/action.ts`) ที่นี่แค่ตรวจว่า
  // ค่าที่ได้มา "เป็น reason ที่ AppError instance ตัวนั้นประกาศไว้จริง" เท่านั้น ไม่รู้จักว่า action
  // ไหนอนุญาต reason ไหนได้บ้าง
  if (typeof err === 'object' && err !== null && 'code' in err && isErrorCode((err as { code: unknown }).code)) {
    const isTrustedAppError = err instanceof AppError;
    const reason = isTrustedAppError && Object.hasOwn(err, 'reason') && typeof err.reason === 'string' ? err.reason : undefined;
    const reasonMeta =
      isTrustedAppError &&
      Object.hasOwn(err, 'reasonMeta') &&
      typeof err.reasonMeta === 'object' &&
      err.reasonMeta !== null
        ? err.reasonMeta
        : undefined;
    return { code: (err as { code: ErrorCode }).code, message: raw, cause: err, reason, reasonMeta };
  }

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
