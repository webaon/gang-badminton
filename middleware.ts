import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';

/**
 * รีเฟรช session ของ Supabase ทุก request
 *
 * 🔴 ต้องมี — Server Component เขียน cookie ไม่ได้ ⇒ ถ้าไม่รีเฟรชที่นี่
 *    access token จะหมดอายุแล้วผู้ใช้หลุดกลางคันแบบสุ่ม
 *
 * การ "กันหน้าที่ต้องล็อกอิน" **ไม่ได้ทำที่นี่** แต่ทำในแต่ละหน้าด้วย `requireUser()`
 * เหตุผล: middleware ไม่รู้ว่าหน้าไหนต้องล็อกอินโดยไม่ hardcode รายการ path
 * ซึ่งจะลืมอัปเดตแน่นอนเมื่อเพิ่มหน้าใหม่ — ให้หน้าประกาศความต้องการของตัวเองดีกว่า
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * ทุก path ยกเว้นไฟล์ static และรูป — ไม่มีประโยชน์ที่จะรีเฟรช session ให้ไฟล์ภาพ
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
