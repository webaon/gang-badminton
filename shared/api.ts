/**
 * API response contract — CLAUDE.md §4
 *
 *   { success: boolean, data?: T, error?: { code: ErrorCode, message: string } }
 *
 * route handlers ทุกตัว (cron, webhook, endpoint ที่ guest เรียก) และ server actions
 * ตอบรูปแบบเดียวกันหมด
 *
 * ⚠️ ที่นี่ประกาศเป็น **discriminated union** ไม่ใช่ optional fields ทั้งคู่
 *    รูปร่างตอน serialize เป็น JSON เหมือนกันเป๊ะ แต่ฝั่ง TypeScript จะบังคับให้
 *    เช็ค `success` ก่อนแตะ `data` ⇒ ลืมเช็คแล้ว build ไม่ผ่าน
 */
import { ERROR_HTTP_STATUS, toErrorCode, type ErrorCode } from './errors';

export type ApiSuccess<T> = { success: true; data: T };
export type ApiFailure = { success: false; error: { code: ErrorCode; message: string } };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function fail(code: ErrorCode, message?: string): ApiFailure {
  return { success: false, error: { code, message: message ?? code } };
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

/**
 * correlation id — baseline §Observability
 *
 * ทุก request/cron run ต้องมี id เดียวที่ตามได้ตั้งแต่ log จนถึง `event_logs.payload`
 * ใช้ค่าจาก header ถ้ามี (เผื่อ upstream ส่งมาแล้ว) ไม่งั้นสร้างใหม่
 */
export function correlationIdFrom(headers: Headers): string {
  return (
    headers.get('x-correlation-id') ??
    headers.get('x-vercel-id') ??
    crypto.randomUUID()
  );
}

/**
 * ห่อ handler ให้ตอบตาม contract เสมอ + log error ต้นฉบับ
 *
 * 🔴 ห้าม swallow error เงียบ (CLAUDE.md §5) — ทุกเคสที่ไม่ใช่ ErrorCode ที่รู้จัก
 *    จะถูก log พร้อม correlation id ก่อนแปลงเป็น INTERNAL_ERROR
 */
export async function respond<T>(
  correlationId: string,
  run: () => Promise<T>,
): Promise<Response> {
  try {
    return json(ok(await run()), 200, correlationId);
  } catch (err) {
    const { code, message, cause } = toErrorCode(err);

    if (code === 'INTERNAL_ERROR') {
      console.error('[api] unhandled error', { correlationId, message, cause });
    } else {
      console.warn('[api] handled error', { correlationId, code, message });
    }

    return json(fail(code, message), httpStatusFor(code), correlationId);
  }
}

function json(body: unknown, status: number, correlationId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-correlation-id': correlationId,
      // ผลลัพธ์ของ cron/API พวกนี้ห้ามถูก cache ที่ edge
      'cache-control': 'no-store',
    },
  });
}
