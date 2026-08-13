import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { publicSupabaseEnv } from './env';

/**
 * รีเฟรช session ของ Supabase ในทุก request
 *
 * 🔴 ต้องมี ไม่งั้น access token หมดอายุแล้วผู้ใช้จะถูกเด้งออกกลางคัน
 *    เพราะ Server Component เขียน cookie ไม่ได้ — middleware เป็นที่เดียวที่เขียนได้
 *
 * ⚠️ ห้ามใส่ logic อื่นระหว่าง `createServerClient` กับ `getUser()`
 *    ถ้ามีอะไรคั่นแล้ว throw จะได้ response ที่ไม่มี cookie ใหม่ ⇒ ผู้ใช้หลุด session แบบสุ่ม
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const { url, anonKey } = publicSupabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() ตรวจ token กับเซิร์ฟเวอร์จริง ต่างจาก getSession() ที่เชื่อ cookie ดิบๆ
  // ⇒ ห้ามเปลี่ยนไปใช้ getSession() ที่นี่
  await supabase.auth.getUser();

  return response;
}
