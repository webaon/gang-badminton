import { ERROR_MESSAGES_TH } from '@/lib/i18n/error-messages';
import { isErrorCode, type ErrorCode } from '@/shared/errors';

/**
 * ข้อความ error ที่ผู้ใช้เห็น — **ทางเดียว** ที่ `error.message` จาก server ถูกแตะ (CLAUDE.md §4) [WO-6.1b]
 *
 * กติกา (ตกลงกับ planner):
 *   1. ทุก code → ข้อความตายตัวจาก `ERROR_MESSAGES_TH` **แม้ server ส่งข้อความไทยมาก็ไม่ใช้**
 *   2. ข้อยกเว้นมีแค่ `SERVER_MESSAGE_CODES` (รายการคงที่ด้านล่าง): server เขียนข้อความไทยเฉพาะเรื่องไว้เอง
 *      เช่น "เวลาจบต้องหลังเวลาเริ่ม" — ถ้าแปลงเป็นข้อความเดียวผู้ใช้จะไม่รู้ว่าผิดตรงไหน
 *   3. แม้เป็นข้อยกเว้น ข้อความต้อง (ก) มีตัวอักษรไทย — ด่านกัน error อังกฤษของ Supabase/Postgres หลุด
 *      (ข) ไม่ใช่ตัว code เอง (`fail()` ใส่ code เป็น message ถ้าไม่ระบุ) (ค) ไม่เกิน `MAX_SERVER_MESSAGE` ตัวอักษร
 *      ไม่เข้าเงื่อนไข ⇒ fallback เป็นข้อความตายตัวของ code
 *   4. `INTERNAL_ERROR` ไม่ render message จาก server เด็ดขาด (อาจเป็น SQL/ชื่อตาราง)
 *   5. ผลลัพธ์เป็น string ธรรมดา — ผู้เรียก render เป็น text (React escape ให้) ห้าม dangerouslySetInnerHTML
 *
 * ❌ ห้ามอ่าน `.message` ของ error ที่อื่นใน `app/` / `features/` — `tests/design/error-text.test.ts` เป็น grep gate
 */
export const SERVER_MESSAGE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'VALIDATION_ERROR',
  'CONFIRMATION_REQUIRED',
]);

export const MAX_SERVER_MESSAGE = 200;

const HAS_THAI = /[\u0E00-\u0E7F]/;

/** รูปร่างที่รับ — หลวมโดยตั้งใจ: ผลจาก server action มี `{ code, message }` แต่บางจุดประกาศ type แค่ `{ message }` */
export type ErrorLike = { code?: string; message?: string } | null | undefined;

export function errorText(error: ErrorLike): string {
  const code: ErrorCode = error && isErrorCode(error.code) ? error.code : 'INTERNAL_ERROR';
  const fallback = ERROR_MESSAGES_TH[code];

  if (!SERVER_MESSAGE_CODES.has(code)) return fallback;

  const raw = typeof error?.message === 'string' ? error.message.trim() : '';
  if (raw === '' || raw === code || !HAS_THAI.test(raw)) return fallback;

  return raw.length > MAX_SERVER_MESSAGE ? `${raw.slice(0, MAX_SERVER_MESSAGE)}…` : raw;
}

/**
 * เวอร์ชันสำหรับ client component: ได้ข้อความเหมือน `errorText()` + ถ้า `UNAUTHENTICATED`
 * (เซสชันหมดอายุกลางคัน) พาไป `/session-expired?next=<หน้าเดิม>` — hi-fi K g2
 *
 * `next` ผ่าน `safeNext()` ซ้ำอีกชั้นที่หน้าปลายทาง · ทำงานเฉพาะในเบราว์เซอร์ (`window`)
 */
export function actionError(error: ErrorLike): string {
  if (error?.code === 'UNAUTHENTICATED' && typeof window !== 'undefined') {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/session-expired?next=${encodeURIComponent(here)}`);
  }
  return errorText(error);
}
