import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { AppError } from '@/shared/action';

/**
 * Rate limit ของ endpoint ที่ guest เรียกได้
 *
 * 🔴 baseline §การตัดสินใจสะสม (Guest/walk-in):
 *    "ทุก endpoint guest มี rate limit ต่อ IP ต่อ session"
 *
 * เหตุผล: endpoint พวกนี้เรียกได้โดยไม่ต้องล็อกอิน แค่มีลิงก์เชิญ
 * ⇒ ถ้าไม่จำกัด คนที่ได้ลิงก์ไปสามารถยิงลงชื่อรัวๆ จนเต็มนัดได้ในไม่กี่วินาที
 *   หรือเดา registration id เพื่อหา guest token
 */

/** IP ของผู้เรียก — Vercel/proxy ใส่มาใน `x-forwarded-for` */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    // ค่าแรกคือ client จริง ที่เหลือคือ proxy ที่ผ่านมา
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * นับและตัดถ้าเกินโควต้า — โยน `RATE_LIMITED` เมื่อเกิน
 *
 * ⚠️ IP ที่อ่านไม่ได้จะตกลงถังเดียวกันชื่อ `unknown` ⇒ **เข้มกว่าปกติ** โดยตั้งใจ
 *    (ยอมให้คนหลังพร็อกซีเดียวกันโดนจำกัดร่วมกัน ดีกว่าเปิดช่องให้เลี่ยงด้วยการซ่อน IP)
 */
export async function enforceGuestRateLimit(options: {
  action: string;
  sessionId: string;
  headers: Headers;
  limit?: number;
  window?: string;
}): Promise<void> {
  const { action, sessionId, headers, limit = 10, window = '1 hour' } = options;
  const key = `guest:${action}:${sessionId}:${clientIp(headers)}`;

  const { data, error } = await supabaseAdmin().rpc('check_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window: window,
  });

  if (error) {
    // 🔴 ตัวนับพัง = ปฏิเสธ ไม่ใช่ปล่อยผ่าน
    //    endpoint นี้เปิดสาธารณะ การ fail-open เท่ากับถอด rate limit ทิ้งตอนที่ต้องการที่สุด
    console.error('[guest] check_rate_limit ล้มเหลว', { key, message: error.message });
    throw new AppError('RATE_LIMITED', 'ระบบจำกัดจำนวนครั้งขัดข้อง ลองใหม่อีกครั้ง', {
      cause: error,
    });
  }

  if (data === false) {
    throw new AppError('RATE_LIMITED', 'ทำรายการถี่เกินไป ลองใหม่อีกครั้งภายหลัง');
  }
}
