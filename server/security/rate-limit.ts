import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { AppError } from '@/shared/action';

/**
 * Rate limit ของทางเข้าสาธารณะ — **[WO-5.C]**
 *
 * baseline §Security Checklist: "Rate limit บน endpoint ที่ guest/public เรียกได้ทุกตัว"
 *
 * 🔴 ใช้ `check_rate_limit()` ตัวเดิมของ WO-1.3 (fixed window ใน Postgres, atomic ด้วย
 *    `ON CONFLICT DO UPDATE`) — ❌ ห้ามสร้างกลไก/ตารางนับใหม่
 *
 * 🔴 **fail-closed**: ตัวนับพัง = ปฏิเสธ ไม่ใช่ปล่อยผ่าน
 *    ทางเข้าพวกนี้เปิดให้คนไม่ล็อกอิน ⇒ fail-open เท่ากับถอด rate limit ทิ้ง
 *    ตอนที่ระบบกำลังมีปัญหา ซึ่งเป็นตอนที่ต้องการมันที่สุด
 *
 * รายการเพดานทั้งหมดอยู่ใน `docs/rate-limits.md` — เพิ่มทางเข้าใหม่ต้องไปเติมที่นั่นด้วย
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

export type RateLimitOptions = {
  /** ชื่อทางเข้า — เป็นส่วนหนึ่งของ key ⇒ แต่ละทางนับแยกกัน */
  scope: string;
  /** สิ่งที่ถูกจำกัดร่วมกับ IP (เช่น session id / gang id) — ไม่มีก็ได้ */
  subject?: string;
  headers: Headers;
  limit: number;
  /** interval ของ Postgres เช่น `'1 hour'` · `'1 minute'` */
  window: string;
};

/**
 * นับและตัดถ้าเกินโควต้า — โยน `RATE_LIMITED` เมื่อเกิน
 *
 * ⚠️ IP ที่อ่านไม่ได้ตกลงถังเดียวกันชื่อ `unknown` ⇒ **เข้มกว่าปกติ** โดยตั้งใจ
 *    (ยอมให้คนหลังพร็อกซีเดียวกันโดนจำกัดร่วมกัน ดีกว่าเปิดช่องให้เลี่ยงด้วยการซ่อน IP)
 */
export async function enforceRateLimit(options: RateLimitOptions): Promise<void> {
  const { scope, subject, headers, limit, window } = options;
  const key = [scope, subject, clientIp(headers)].filter(Boolean).join(':');

  const { data, error } = await supabaseAdmin().rpc('check_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window: window,
  });

  if (error) {
    // ❌ ห้าม log ค่า key เต็ม (มี IP อยู่ข้างใน) — log แค่ว่าเป็นทางเข้าไหน
    console.error('[rate-limit] check_rate_limit ล้มเหลว', { scope, message: error.message });
    throw new AppError('RATE_LIMITED', 'ระบบจำกัดจำนวนครั้งขัดข้อง ลองใหม่อีกครั้ง', {
      cause: error,
    });
  }

  if (data === false) {
    throw new AppError('RATE_LIMITED', 'ทำรายการถี่เกินไป ลองใหม่อีกครั้งภายหลัง');
  }
}

/**
 * เวอร์ชันที่ไม่โยน error — สำหรับ **route handler** ที่ต้องตอบ redirect/HTTP เอง
 *
 * คืน `true` = ผ่าน · `false` = เกินโควต้า (หรือระบบนับพัง ซึ่งถือว่าไม่ผ่านเช่นกัน)
 */
export async function withinRateLimit(options: RateLimitOptions): Promise<boolean> {
  try {
    await enforceRateLimit(options);
    return true;
  } catch {
    return false;
  }
}
