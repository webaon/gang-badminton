/**
 * Helper สำหรับ server actions — คู่กับ `respond()` ใน `shared/api.ts` ที่ใช้กับ route handler
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ปัญหาที่ helper ชุดนี้มีไว้แก้ (ข้อจำกัดจาก Phase 1 ข้อ 2)
 *
 * RLS ของ Postgres **ไม่ raise error** — มันกรองแถวออกเฉยๆ
 * ⇒ `UPDATE ... WHERE id = $1` ที่ผู้ใช้ไม่มีสิทธิ์จะ **สำเร็จ** และคืน 0 แถว
 *
 * ถ้า server action ไม่เช็คจำนวนแถว จะตอบผู้ใช้ว่า "บันทึกแล้ว" ทั้งที่ไม่มีอะไรเปลี่ยน
 * ซึ่งเป็นบั๊กที่หายากมากเพราะไม่มี error ให้เห็นที่ไหนเลย
 *
 * ⇒ ทุก mutation ต้องผ่าน `assertAffected()` เสมอ
 */
import { ok, fail, type ApiResponse } from './api';
import { toErrorCode, type ErrorCode } from './errors';

/** error ที่รู้ code ของตัวเอง — `toErrorCode()` จะหยิบ code ไปใช้ตรงๆ */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = 'AppError';
    this.code = code;
  }
}

/**
 * อ่าน redirect error ของ Next จาก `digest` (รูปแบบ `NEXT_REDIRECT;<type>;<url>;<status>;`)
 * — ไม่ import จาก `next/dist/...` เพื่อให้ `shared/` ไม่ผูกกับ internals ของ framework
 * (logic เดียวกับ `isRedirectError`/`getURLFromRedirectError` ของ Next: url อาจมี `;` จึงรวมส่วนกลางกลับ)
 */
export function parseRedirectError(err: unknown): { destination: string } | null {
  if (typeof err !== 'object' || err === null || !('digest' in err)) return null;
  const digest = (err as { digest: unknown }).digest;
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT;')) return null;

  const parts = digest.split(';');
  if (parts.length < 5 || (parts[1] !== 'replace' && parts[1] !== 'push')) return null;
  return { destination: parts.slice(2, -2).join(';') };
}

/** notFound()/forbidden()/unauthorized() → digest `NEXT_HTTP_ERROR_FALLBACK;<status>` (และ `NEXT_NOT_FOUND` ในเวอร์ชันเก่า) */
function isNextControlFlowError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('digest' in err)) return false;
  const digest = (err as { digest: unknown }).digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;') || digest === 'NEXT_NOT_FOUND');
}

/** ปลายทางคือหน้า /sign-in เท่านั้น (อาจมี ?next=… ต่อท้าย) — `/sign-in-x` หรือ URL ภายนอกไม่ใช่ */
function isSignInPath(destination: string): boolean {
  return /^\/sign-in(?:[?#]|$)/.test(destination);
}

/**
 * ห่อ server action ให้ตอบตาม contract เสมอ + log error ที่ไม่รู้จัก
 *
 * ต่างจาก `respond()` ตรงที่คืน object ธรรมดา ไม่ใช่ `Response`
 * เพราะ server action ถูกเรียกจาก React ไม่ใช่ผ่าน HTTP โดยตรง
 */
export async function runAction<T>(
  correlationId: string,
  run: () => Promise<T>,
): Promise<ApiResponse<T>> {
  try {
    return ok(await run());
  } catch (err) {
    // 🔴 redirect() ของ Next เป็น exception ชนิดพิเศษ — ห้ามกลืนเป็น INTERNAL_ERROR [WO-6.1b]
    //    `requireUser()` เรียก redirect('/sign-in') เมื่อเซสชันหมดอายุกลางคัน:
    //      · ไป /sign-in  → ตอบ UNAUTHENTICATED ตาม contract ให้ client พาไป /session-expired
    //      · redirect อื่น → rethrow ตามเดิม (Next ต้องเห็นเพื่อทำ redirect จริง)
    const redirect = parseRedirectError(err);
    if (redirect) {
      if (isSignInPath(redirect.destination)) {
        console.warn('[action] handled error', { correlationId, code: 'UNAUTHENTICATED', message: 'session หมดอายุ' });
        return fail('UNAUTHENTICATED', 'UNAUTHENTICATED');
      }
      throw err;
    }
    // notFound() / forbidden() / unauthorized() ของ Next ก็เป็น control-flow exception เหมือนกัน — rethrow ไม่กลืน
    if (isNextControlFlowError(err)) throw err;

    const { code, message, cause } = toErrorCode(err);

    if (code === 'INTERNAL_ERROR') {
      // 🔴 ห้าม swallow — ต้องเห็นต้นฉบับเต็มพร้อม correlation id (CLAUDE.md §5)
      console.error('[action] unhandled error', { correlationId, message, cause });
    } else {
      console.warn('[action] handled error', { correlationId, code, message });
    }

    return fail(code, message);
  }
}

/**
 * 🔴 บังคับว่ามีแถวถูกแตะจริง
 *
 * ใช้กับผลของ mutation ที่ต่อท้ายด้วย `.select()` เสมอ
 * (supabase-js ไม่คืนจำนวนแถวที่ update ถ้าไม่ได้ขอ `select` กลับมา
 *  ⇒ **mutation ที่ไม่ `.select()` จะตรวจอะไรไม่ได้เลย** ห้ามเขียนแบบนั้น)
 *
 * @param rows  แถวที่ได้กลับมาจาก `.select()`
 * @param code  code ที่จะโยนเมื่อไม่มีแถว — default `FORBIDDEN`
 *              เพราะสาเหตุที่พบบ่อยที่สุดคือ RLS ปฏิเสธ ไม่ใช่ข้อมูลหาย
 *              ถ้าเคสนั้นแยกได้ชัดว่าเป็น "ไม่พบ" ให้ส่ง `NOT_FOUND` มาเอง
 */
export function assertAffected<T>(
  rows: readonly T[] | null | undefined,
  code: ErrorCode = 'FORBIDDEN',
  detail?: string,
): T[] {
  if (!rows || rows.length === 0) {
    throw new AppError(
      code,
      detail ?? 'ไม่มีแถวไหนถูกแก้ — น่าจะถูก RLS ปฏิเสธหรือไม่พบข้อมูล',
    );
  }
  return [...rows];
}

/** เวอร์ชันแถวเดียว — คืนแถวแรกและยืนยันว่ามีจริง */
export function assertOne<T>(
  rows: readonly T[] | null | undefined,
  code: ErrorCode = 'FORBIDDEN',
  detail?: string,
): T {
  return assertAffected(rows, code, detail)[0];
}

/** ยืนยันว่าอ่านเจอ — ใช้กับ query ที่คาดว่าต้องมีข้อมูล */
export function assertFound<T>(row: T | null | undefined, detail?: string): T {
  if (row === null || row === undefined) {
    throw new AppError('NOT_FOUND', detail);
  }
  return row;
}

/**
 * แปลงผลของ supabase-js เป็นแถว แล้วโยนถ้ามี error
 * รวมสองขั้นที่ลืมกันบ่อย: เช็ค `error` แล้วค่อยเช็คจำนวนแถว
 */
export function unwrap<T>(result: {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}): T[] {
  if (result.error) {
    const { code, message } = toErrorCode(result.error);
    throw new AppError(code, message, { cause: result.error });
  }
  return result.data ?? [];
}
