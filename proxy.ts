import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';
import { buildContentSecurityPolicy, STATIC_ROUTES } from '@/lib/security/csp';
import { publicSupabaseEnv } from '@/lib/supabase/env';

/**
 * รีเฟรช session ของ Supabase ทุก request
 *
 * ⚠️ **[WO-5.A]** Next 16 เปลี่ยนชื่อแนวคิดนี้จาก `middleware` เป็น `proxy`
 *    (ไฟล์ `middleware.ts` ยังใช้ได้แต่ถูก deprecate) ⇒ ย้ายมาใช้ชื่อใหม่ตั้งแต่ตอนอัป
 *    จะได้ไม่ต้องมาไล่ตอนที่ Next ถอดของเก่าออกจริง
 *
 * 🔴 ต้องมี — Server Component เขียน cookie ไม่ได้ ⇒ ถ้าไม่รีเฟรชที่นี่
 *    access token จะหมดอายุแล้วผู้ใช้หลุดกลางคันแบบสุ่ม
 *
 * การ "กันหน้าที่ต้องล็อกอิน" **ไม่ได้ทำที่นี่** แต่ทำในแต่ละหน้าด้วย `requireUser()`
 * เหตุผล: middleware ไม่รู้ว่าหน้าไหนต้องล็อกอินโดยไม่ hardcode รายการ path
 * ซึ่งจะลืมอัปเดตแน่นอนเมื่อเพิ่มหน้าใหม่ — ให้หน้าประกาศความต้องการของตัวเองดีกว่า
 */
export async function proxy(request: NextRequest) {
  // 🔴 **[WO-5.B]** nonce ต้องใหม่ทุก request — nonce ที่ซ้ำได้เท่ากับไม่มี nonce
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  // Next อ่าน nonce จาก header นี้แล้วติดให้ `<script>` ของตัวเองอัตโนมัติ
  // 🔴 ต้องส่งต่อผ่าน `NextResponse.next({ request: { headers } })` เท่านั้น (ดู updateSession)
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = await updateSession(request, requestHeaders);

  response.headers.set(
    'Content-Security-Policy',
    buildContentSecurityPolicy({
      nonce,
      supabaseUrl: publicSupabaseEnv().url,
      isProduction: process.env.NODE_ENV === 'production',
      isStaticRoute: STATIC_ROUTES.has(request.nextUrl.pathname),
    }),
  );

  return response;
}

export const config = {
  matcher: [
    /*
     * ทุก path ยกเว้นไฟล์ static และรูป — ไม่มีประโยชน์ที่จะรีเฟรช session ให้ไฟล์ภาพ
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
