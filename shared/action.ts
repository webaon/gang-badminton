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
import { AppError, toErrorCode, type ErrorCode } from './errors';

/**
 * [WO-B2.2] `AppError` ย้ายไปอยู่ `shared/errors.ts` จริงแล้ว (ให้ `toErrorCode()` ทำ `instanceof` ได้
 * โดยไม่ circular import) — ไฟล์นี้ re-export ต่อให้ไฟล์เดิม 30+ ไฟล์ที่ `import { AppError } from
 * '@/shared/action'` อยู่แล้วไม่ต้องแก้ import ทุกจุด
 */
export { AppError };

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
 *
 * [WO-B2.2] `R` เป็น generic เสริมแบบ additive (default `never`) — action ที่ไม่ประกาศ R (ของเดิมทุกตัว)
 * ไม่มีทางได้ `reason` ที่มีค่าจริงเลย เฉพาะ action ที่ต้องแยกเหตุผลย่อยใต้ code เดียว (เช่น leaveGang)
 * ที่จะ instantiate `runAction<T, SpecificReasonUnion>(...)` ตรงๆ
 *
 * [planner, WO-B2.2 · F1] ไม่ใช่แค่ `{allowReason:true}` boolean เฉยๆ (เวอร์ชันแรกที่ QA ยังตีว่าไม่พอ) —
 * ต้องส่ง **allowlist จริงของ reason ที่อนุญาต** มาด้วย (`opts.reasons`) แล้วเช็คว่า reason ที่ได้จาก
 * `toErrorCode()` (ซึ่งมาจาก `err instanceof AppError` ที่ตรวจแล้วว่าเป็น own property จริง — ดู
 * `shared/errors.ts`) **อยู่ใน list นั้นจริง** ก่อนส่งต่อ — ไม่งั้น strip ทิ้ง ป้องกันเคสที่ action ส่ง
 * `{allowReason:true}` มาเฉยๆ (ไม่ได้บอกว่า reason ไหนบ้างที่ตัวเองรองรับ) แล้ว error object ที่โยนออกมา
 * จาก `run()` บังเอิญเป็น `AppError` ที่มี `.reason` เป็นค่าอะไรก็ได้ (ไม่ตรงกับที่ action นี้ตั้งใจส่งจริง)
 * หลุดออกไปได้อยู่ดี — allowlist ปิดช่องนี้เพราะต้องตรงกับ**ค่า**ที่ระบุไว้ล่วงหน้า ไม่ใช่แค่ "มีสิทธิ์
 * มี reason บ้าง" `opts.reasonMetaKeys` (ถ้ามี) คือการ pick key ของ `reasonMeta` ซ้ำอีกชั้นตาม whitelist
 * เฉพาะของ reason นั้นๆ ตอน serialize — **ไม่เชื่อ mapper ว่า whitelist ไว้ถูกแล้วเฉยๆ** เป็น defense-in-
 * depth ชั้นที่สอง ถ้า mapper มีบั๊กแล้วแปะ key แปลกปลอม (เช่น `registration_id`) มาด้วย ชั้นนี้จะกรองออก
 *
 * (implementation ผ่าน function overload 2 แบบ — ไม่ใช่ conditional-tuple rest param: ลองแบบนั้นมาก่อน
 * แล้วพัง TS inference ของ**ทุก**call site เดิมที่ไม่ส่ง type arg เลย เพราะ R ไม่มี anchor ให้ infer
 * จาก argument ไหนเลย TS เลย treat เป็น `never` ของ unresolved generic ตรงๆไม่ใช่ default ที่ตั้งไว้
 * — overload แก้ตรงนี้ได้สะอาดกว่า: overload แรกไม่มี type param เลย บังคับ `ApiResponse<T, never>`
 * ให้ call site เดิมทุกตัวที่เขียน `runAction(cid, fn)` เฉยๆ ตรงเป๊ะ ไม่ต้องแก้อะไร)
 */
export async function runAction<T>(correlationId: string, run: () => Promise<T>): Promise<ApiResponse<T, never>>;
export async function runAction<T, R extends string>(
  correlationId: string,
  run: () => Promise<T>,
  opts: { reasons: readonly R[]; reasonMetaKeys?: Partial<Record<R, readonly string[]>> },
): Promise<ApiResponse<T, R>>;
export async function runAction<T, R extends string = never>(
  correlationId: string,
  run: () => Promise<T>,
  opts?: { reasons?: readonly R[]; reasonMetaKeys?: Partial<Record<R, readonly string[]>> },
): Promise<ApiResponse<T, R>> {
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

    const { code, message, cause, reason, reasonMeta } = toErrorCode(err);

    // [planner, WO-B2.2 · F1] reason ต้องอยู่ใน allowlist ของ call site นี้จริงๆ (ไม่ใช่แค่ "มี reason
    // มาบ้าง") — `Array.includes` เทียบค่าตรงตัว ปฏิเสธทั้ง reason ที่ไม่รู้จักและ action ที่ไม่ได้ส่ง
    // opts.reasons มาเลย (`opts?.reasons` เป็น undefined ⇒ `.includes` ไม่ถูกเรียก ⇒ ไม่มี reason หลุด)
    const allowedReason: R | undefined =
      reason !== undefined && opts?.reasons?.includes(reason as R) ? (reason as R) : undefined;

    // reasonMeta: pick key ซ้ำตาม whitelist เฉพาะของ reason นั้น (ชั้นที่สอง ไม่เชื่อ mapper เฉยๆ) —
    // key ที่ reasonMeta ของจริงไม่มี (`Object.hasOwn`) ก็ไม่ติดมาด้วย แม้ whitelist จะอนุญาตชื่อนั้นก็ตาม
    const allowedMetaKeys = allowedReason ? opts?.reasonMetaKeys?.[allowedReason] : undefined;
    const pickedMeta: Record<string, unknown> | undefined =
      allowedReason && reasonMeta && allowedMetaKeys && allowedMetaKeys.length > 0
        ? Object.fromEntries(
            allowedMetaKeys.filter((key) => Object.hasOwn(reasonMeta, key)).map((key) => [key, reasonMeta[key]]),
          )
        : undefined;
    const finalMeta = pickedMeta && Object.keys(pickedMeta).length > 0 ? pickedMeta : undefined;

    if (code === 'INTERNAL_ERROR') {
      // 🔴 ห้าม swallow — ต้องเห็นต้นฉบับเต็มพร้อม correlation id (CLAUDE.md §5)
      console.error('[action] unhandled error', { correlationId, message, cause });
    } else {
      console.warn('[action] handled error', { correlationId, code, message, reason: allowedReason });
    }

    return fail(code, message, allowedReason, finalMeta);
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
