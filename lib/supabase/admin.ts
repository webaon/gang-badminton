import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client ที่ใช้ service role — **ฝั่ง server เท่านั้น**
 *
 * 🔴 หลัง WO-1.4 ทุก DB function ถูก revoke จาก anon/authenticated แล้ว
 *    เหลือ grant ให้ `service_role` เท่านั้น ⇒ นี่คือทางเดียวที่เรียกฟังก์ชันได้
 *
 * ⚠️ `import 'server-only'` ทำให้ build พังทันทีถ้ามีไฟล์ client component เผลอ import
 *    เข้ามา — ป้องกัน service key หลุดไปฝั่ง browser ตั้งแต่ตอน build ไม่ใช่ตอน runtime
 *
 * ⚠️ client นี้ **bypass RLS ทั้งหมด** ⇒ ทุกที่ที่ใช้ต้องตรวจสิทธิ์เองก่อนเสมอ
 *    (ผ่าน `domain/permissions/can()` เมื่อ Phase 2 เขียนเสร็จ)
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // ล้มเร็วพร้อมบอกชื่อตัวแปรที่ขาด ดีกว่าไปพังตอนเรียก API แล้วได้ 401 ที่อ่านไม่ออก
    throw new Error(
      'ตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ก่อน (ดู .env.example)',
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}
