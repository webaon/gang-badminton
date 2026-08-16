import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ตรวจลายเซ็นของ webhook LINE — **[WO-4.B]**
 *
 * LINE เซ็น **raw body** ด้วย channel secret ของก๊วนนั้นเป็น HMAC-SHA256 แล้วส่งมาเป็น
 * base64 ใน header `x-line-signature`
 *
 * 🔴 ต้องเซ็นจาก **raw body เท่านั้น** — `JSON.parse` แล้ว `JSON.stringify` กลับ
 *    จะได้ไบต์คนละชุด (ลำดับคีย์/ช่องว่าง/escape ต่างกัน) ⇒ ลายเซ็นไม่มีวันตรง
 *    หรือแย่กว่านั้นคือ "ตรงเป็นบางที" ซึ่งดีบักไม่ออก
 *
 * 🔴 เทียบแบบ timing-safe (กติกาเดียวกับ `CRON_SECRET` ใน WO-1.5)
 *
 * 🔴 ไม่มี secret = ไม่ผ่าน (fail-closed) — ห้ามตีความว่า "ยังไม่ได้ตั้งค่า = ปล่อยผ่าน"
 */
export function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string | null,
): boolean {
  if (!signature || !channelSecret) return false;

  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest();

  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  // timingSafeEqual โยน error ถ้าความยาวต่างกัน — ความยาวของ digest ไม่ใช่ความลับ
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

/** ใช้ในเทสต์และเครื่องมือ dev — โค้ดฝั่ง production ไม่ควรต้องเซ็นเอง */
export function signLineBody(rawBody: string, channelSecret: string): string {
  return createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest('base64');
}
