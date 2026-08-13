'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { publicSupabaseEnv } from './env';

/**
 * Supabase client ฝั่ง browser — ทำงานภายใต้ **RLS** ด้วย anon key
 *
 * 🔴 หลัง WO-1.4 client ตัวนี้เรียก DB function ไม่ได้เลยสักตัว
 *    (revoke จาก anon/authenticated หมดแล้ว เหลือ service_role เท่านั้น)
 *    ⇒ ใช้ได้เฉพาะ **อ่าน** ตารางที่ policy อนุญาต และ mutation ตรงๆ ที่มี policy รองรับ
 *    ทุกอย่างที่เป็น flow ธุรกิจต้องเรียก server action
 *
 * ⚠️ ห้ามเอา service role key มาใส่ที่นี่เด็ดขาด — มันจะถูก bundle ไปฝั่ง browser
 */
let cached: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (cached) return cached;

  const { url, anonKey } = publicSupabaseEnv();
  cached = createBrowserClient(url, anonKey);
  return cached;
}
