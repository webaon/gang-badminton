import 'server-only';

import { enforceRateLimit, clientIp } from '@/server/security/rate-limit';

/**
 * Rate limit ของ endpoint ที่ guest เรียกได้
 *
 * 🔴 baseline §การตัดสินใจสะสม (Guest/walk-in):
 *    "ทุก endpoint guest มี rate limit ต่อ IP ต่อ session"
 *
 * ⚠️ **[WO-5.C]** ตัวนับจริงย้ายไปอยู่ที่ `server/security/rate-limit.ts` แล้ว
 *    (ทางเข้าสาธารณะทุกทางใช้ตัวเดียวกัน) — ที่นี่เหลือแค่ค่า default ของฝั่ง guest
 */

export { clientIp };

export async function enforceGuestRateLimit(options: {
  action: string;
  sessionId: string;
  headers: Headers;
  limit?: number;
  window?: string;
}): Promise<void> {
  const { action, sessionId, headers, limit = 10, window = '1 hour' } = options;

  await enforceRateLimit({
    scope: `guest:${action}`,
    subject: sessionId,
    headers,
    limit,
    window,
  });
}
