/**
 * [WO-B2.2] leave_gang() DB error → user-facing `reason` (pure mapping, no DB/next/react/supabase)
 *
 * 🔴 ปัญหาที่แก้: `shared/api.ts`'s ApiFailure มีแค่ `{code, message}`. `leave_gang()` (และ
 * `cancel_registration()` ที่มันเรียกต่อ) raise หลายจุดที่ "code" เดียวกันแปลเป็นสองความหมายต่างกันได้
 * (VALIDATION_ERROR ทั้ง "ลืมส่ง field" และ "เจ้าของคนสุดท้ายออกไม่ได้") ⇒ UI บอกสาเหตุจริงไม่ได้
 *
 * ตารางที่ reviewer อนุมัติ (WO-B2.2, อิงจาก migration ที่ active จริงตอนนี้):
 *
 *   SQL message                        | detail (PG, ไม่ส่งออกดิบ)      | reason
 *   ------------------------------------|---------------------------------|------------------------------
 *   VALIDATION_ERROR (leave_gang:142)   | {reason:'ต้องระบุก๊วนและผู้ใช้'} | MISSING_REQUIRED_FIELDS (dev-guard)
 *   NOT_FOUND         (leave_gang:148)  | {entity:'gang', id}             | GANG_NOT_FOUND
 *   NOT_GANG_MEMBER   (leave_gang:169)  | {gang_id}                       | NOT_A_MEMBER
 *   VALIDATION_ERROR (leave_gang:184)   | {field:'role', reason:'...'}    | OWNER_MUST_TRANSFER
 *   REGISTRATION_NOT_FOUND (cancel_registration:277/303) | race only      | RETRY
 *   NOT_FOUND entity='session' (cancel_registration:290) | race only      | RETRY
 *   INVALID_REGISTRATION_TRANSITION (cancel_registration:313) | race only | RETRY
 *   CANCEL_CUTOFF_PASSED (cancel_registration:358)        | {cutoff_at, starts_at} (จริง ไม่ใช่ race) | HAS_LATE_CANCEL_REGISTRATION
 *
 * แถวข้างบนอ้างอิง supabase/migrations/20260818000049_leave_gang_credit.sql (active) — เวอร์ชันก่อนหน้า
 * (20260818000040_leave_gang_transfer_ownership.sql:47/53/74/89) มี 4 raise ตรงข้อความ/detail เหมือนกัน
 * เป๊ะ แค่เลขบรรทัดต่าง (ถูก create-or-replace ทับไปแล้ว ไม่รันจริงอีก — คงไว้เผื่ออ่านประวัติ/rollback)
 *
 * [planner, WO-B2.2] #9 (CANCEL_CUTOFF_PASSED → ออกจากก๊วนไม่ได้เพราะมีนัดเลย cutoff) เป็นพฤติกรรม
 * ที่มีอยู่แล้ว **ห้ามเปลี่ยนในใบนี้** — ใบนี้ทำแค่ map ให้ reason ถูก ไม่แก้ business logic
 *
 * reasonMeta: whitelist เข้มมาก — มีแค่ `HAS_LATE_CANCEL_REGISTRATION` ที่ได้ `{startsAt, cutoffAt}`
 * (timestamptz string ของ Postgres เอง) **ห้ามส่ง registration_id หรือ PG detail ดิบไปให้ client เด็ดขาด**
 */

export type LeaveGangFailureReason =
  | 'OWNER_MUST_TRANSFER'
  | 'HAS_LATE_CANCEL_REGISTRATION'
  | 'NOT_A_MEMBER'
  | 'GANG_NOT_FOUND'
  | 'RETRY'
  | 'MISSING_REQUIRED_FIELDS';

export type LeaveGangReasonMeta = { startsAt: string; cutoffAt: string };

export type LeaveGangErrorMapping =
  | { reason: LeaveGangFailureReason; reasonMeta?: LeaveGangReasonMeta }
  | { reason?: undefined; reasonMeta?: undefined };

/** input ที่ `.details` ตรงกับ Postgrest ของจริง (ดู node_modules/@supabase/postgrest-js/src/PostgrestError.ts) —
 *  string เสมอ (JSON-encoded) ไม่ใช่ object สำเร็จรูป ต้อง parse เอง */
export type LeaveGangErrorLike = { message: string; details?: string | null };

/** parse `.details` แบบ fail-closed — JSON พังหรือไม่ใช่ object ⇒ คืน `null` ไม่โยนต่อ */
function parseDetail(details: string | null | undefined): Record<string, unknown> | null {
  if (!details) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Error ที่ `leave_gang()` RPC (หรือ `cancel_registration()` ที่มันเรียกต่อ) โยนมา → `{reason, reasonMeta}`
 *
 * 🔴 pure function ล้วน — ไม่แตะ DB/network เลย รับแค่ `{message, details}` ที่เหมือน PostgrestError จริง
 *
 * message ที่ไม่รู้จัก (ไม่ตรงตารางข้างบนเลย) ⇒ คืน `{}` (ไม่มี reason) — caller ยัง fallback เป็น
 * `code` เดิมได้ตามปกติ (ดู `shared/errors.ts`'s `toErrorCode()`) ไม่ throw ไม่ guess
 */
export function mapLeaveGangError(err: LeaveGangErrorLike): LeaveGangErrorMapping {
  const detail = parseDetail(err.details);

  switch (err.message) {
    case 'VALIDATION_ERROR':
      // leave_gang:184 เท่านั้นที่มี field==='role' — ทุกกรณีอื่นของ VALIDATION_ERROR (leave_gang:142
      // หรือ detail พังพาร์สไม่ได้) เป็น dev-guard ทั่วไป ไม่ใช่เคสที่ user เจอได้จากหน้า UI ปกติ
      return detail?.field === 'role' ? { reason: 'OWNER_MUST_TRANSFER' } : { reason: 'MISSING_REQUIRED_FIELDS' };

    case 'NOT_FOUND':
      // leave_gang:148 เองมี entity==='gang'; NOT_FOUND อื่น (เช่น cancel_registration:290 entity==='session')
      // เป็น race ระหว่าง lock เท่านั้น — ทั้งสองเคสไม่เจาะจงพอให้ reason ต่างจาก RETRY ทั่วไป
      return detail?.entity === 'gang' ? { reason: 'GANG_NOT_FOUND' } : { reason: 'RETRY' };

    case 'NOT_GANG_MEMBER':
      return { reason: 'NOT_A_MEMBER' };

    case 'REGISTRATION_NOT_FOUND':
    case 'INVALID_REGISTRATION_TRANSITION':
      // race ระหว่าง leave_gang คิว registration ไว้ กับ cancel_registration ไปล็อกจริง — ลองใหม่เฉยๆพอ
      return { reason: 'RETRY' };

    case 'CANCEL_CUTOFF_PASSED': {
      // [planner] ไม่แก้ behavior ข้อนี้ในใบนี้ — mapping ให้ reason/meta ถูกเท่านั้น
      const startsAt = detail?.starts_at;
      const cutoffAt = detail?.cutoff_at;
      if (isNonEmptyString(startsAt) && isNonEmptyString(cutoffAt)) {
        return { reason: 'HAS_LATE_CANCEL_REGISTRATION', reasonMeta: { startsAt, cutoffAt } };
      }
      // detail พังพาร์สไม่ได้ (ไม่ควรเกิดกับ migration ปัจจุบัน) — ยังให้ reason แต่ไม่มี meta มั่วๆ
      return { reason: 'HAS_LATE_CANCEL_REGISTRATION' };
    }

    default:
      return {};
  }
}
