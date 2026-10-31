import type { ErrorCode } from '@/shared/errors';

/**
 * ErrorCode → ข้อความไทยที่ผู้ใช้เห็น — **แหล่งเดียว** (CLAUDE.md §4: frontend แปลจาก code ห้าม hardcode ข้อความตามไฟล์) [WO-6.1b]
 *
 * `Record<ErrorCode, string>` ⇒ เพิ่ม code ใน `shared/errors.ts` แล้วลืมใส่ข้อความ = build ไม่ผ่าน
 * `tests/i18n/error-messages.test.ts` เทียบกับตารางใน `docs/errors.md` อีกชั้น
 *
 * หลักเขียน: บอก "เกิดอะไร" + "ทำอะไรต่อได้" · ไม่โทษผู้ใช้ · ไม่เปิดเผยรายละเอียดภายใน
 * (เช่น `INTERNAL_ERROR` ห้ามใส่ข้อความ DB ดิบ · `CHECKIN_TOKEN_INVALID` ไม่แยกสามกรณีโดยตั้งใจ — WO-2.5-F)
 */
export const ERROR_MESSAGES_TH: Record<ErrorCode, string> = {
  // Registration / Session
  SESSION_FULL: 'นัดนี้เต็มแล้ว',
  SESSION_NOT_OPEN: 'นัดนี้ยังไม่เปิดรับสมัครหรือปิดรับแล้ว',
  ALREADY_REGISTERED: 'คุณลงชื่อหรือเป็นสมาชิกอยู่แล้ว',
  REGISTRATION_NOT_FOUND: 'ไม่พบรายการลงชื่อนี้ อาจถูกยกเลิกไปแล้ว',
  CANCEL_CUTOFF_PASSED: 'เลยเวลาที่ยกเลิกได้แล้ว',
  INVALID_REGISTRATION_TRANSITION: 'สถานะการลงชื่อเปลี่ยนไปแล้ว รีเฟรชหน้าแล้วลองอีกครั้ง',
  NOT_FOUND: 'ไม่พบข้อมูลที่ต้องการ อาจถูกลบไปแล้ว',

  // State machine
  INVALID_TRANSITION: 'สถานะเปลี่ยนไปแล้ว รีเฟรชหน้าแล้วลองอีกครั้ง',
  DIRECT_STATUS_UPDATE_FORBIDDEN: 'ระบบขัดข้อง ทีมงานรับทราบแล้ว กรุณาลองใหม่ภายหลัง',

  // Payment / Billing
  PAYMENT_ALREADY_VERIFIED: 'รายการชำระนี้ยืนยันแล้ว แก้ไขไม่ได้ ให้แอดมินปรับยอดแทน',
  PAYMENT_NOT_FOUND: 'ไม่พบรายการชำระเงิน',
  ALLOCATION_EXCEEDS_PAYMENT: 'ยอดที่จัดสรรเกินจำนวนเงินที่ชำระ',
  CHARGE_NOT_FOUND: 'ไม่พบรายการค่าใช้จ่ายที่อ้างถึง',
  INSUFFICIENT_CREDIT: 'เครดิตคงเหลือไม่พอสำหรับรายการนี้',
  CHARGES_ALREADY_COMMITTED: 'นัดนี้สรุปยอดไปแล้ว',
  MONTHLY_FEE_ALREADY_GENERATED: 'ออกบิลรายเดือนของเดือนนี้ไปแล้ว',

  // Guest / Invite token
  INVITE_TOKEN_INVALID: 'ลิงก์เชิญไม่ถูกต้อง ขอลิงก์ใหม่จากคนที่ชวนคุณ',
  INVITE_TOKEN_EXPIRED: 'ลิงก์เชิญหมดอายุแล้ว ขอลิงก์ใหม่จากคนที่ชวนคุณ',
  INVITE_TOKEN_EXHAUSTED: 'ลิงก์เชิญถูกใช้ครบจำนวนแล้ว ขอลิงก์ใหม่จากคนที่ชวนคุณ',
  GUEST_ACCESS_DENIED: 'เปิดดูรายการนี้ไม่ได้ ใช้ลิงก์ที่ได้ตอนลงชื่อ',
  CHECKIN_TOKEN_INVALID: 'QR เช็คอินใช้ไม่ได้ อาจไม่ถูกต้อง หมดอายุ หรือเป็นของนัดอื่น',

  // Permission / Tenancy / Feature flag
  UNAUTHENTICATED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  FORBIDDEN: 'คุณไม่มีสิทธิ์ทำรายการนี้',
  NOT_GANG_MEMBER: 'คุณไม่ได้เป็นสมาชิกก๊วนนี้',
  FEATURE_DISABLED: 'ก๊วนนี้ปิดฟีเจอร์นี้อยู่',

  // Infrastructure
  RATE_LIMITED: 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่',
  CRON_UNAUTHORIZED: 'คำขอนี้ไม่ผ่านการตรวจสอบสิทธิ์',
  WEBHOOK_SIGNATURE_INVALID: 'คำขอนี้ไม่ผ่านการตรวจสอบลายเซ็น',
  VALIDATION_ERROR: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง',
  CONFIRMATION_REQUIRED: 'ต้องยืนยันก่อนทำรายการนี้',
  INTERNAL_ERROR: 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง',
};
