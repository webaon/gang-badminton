import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { publicSupabaseEnv } from './env';

/**
 * Supabase client ฝั่ง server ที่ **ผูกกับ session ของผู้ใช้ที่เรียกมา**
 *
 * ต่างจาก `supabaseAdmin()` ตรงที่ตัวนี้ยังอยู่ใต้ RLS — `auth.uid()` เป็นของผู้ใช้จริง
 * ⇒ นี่คือ client ที่ควรใช้เป็นค่าเริ่มต้นใน server action และ RSC
 *
 * 🔴 ใช้ `supabaseAdmin()` เฉพาะตอนต้องเรียก DB function (ซึ่ง grant ให้ service_role
 *    เท่านั้น) และ **ต้องตรวจสิทธิ์ด้วย `can()` ก่อนเสมอ** เพราะ admin client bypass RLS
 *
 * ต้อง `await` เพราะ `cookies()` ของ Next 15 เป็น async
 */
export async function supabaseServer(): Promise<SupabaseClient> {
  const { url, anonKey } = publicSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // เรียกจาก Server Component จะเขียน cookie ไม่ได้ (อ่านอย่างเดียว)
          // ไม่เป็นไร เพราะ middleware เป็นตัวรีเฟรช session ให้อยู่แล้ว
          // — จับไว้เงียบๆ ตรงนี้ได้ เพราะเป็นข้อจำกัดของ runtime ไม่ใช่ error จริง
        }
      },
    },
  });
}

/** ผู้ใช้ปัจจุบัน (null ถ้ายังไม่ล็อกอิน) */
export async function currentUser() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
