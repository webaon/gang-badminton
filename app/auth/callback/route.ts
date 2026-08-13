import { NextResponse, type NextRequest } from 'next/server';

import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/url/safe-next';

/**
 * ปลายทางของ magic link และลิงก์ยืนยันอีเมล
 *
 * Supabase ส่งผู้ใช้กลับมาที่นี่พร้อม `code` แล้วเราแลกเป็น session (เขียนลง cookie)
 *
 * ⚠️ `next` มาจาก query string = **input ที่ผู้ใช้ควบคุมได้**
 *    ถ้าเอาไป redirect ตรงๆ จะกลายเป็น open redirect (พาไปเว็บฟิชชิ่งได้)
 *    ⇒ กรองผ่าน `safeNext()` ใน `lib/url/safe-next.ts` (มี unit test คุมแยก)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNext(searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(`${origin}/sign-in?error=missing_code`);
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.warn('[auth] แลก code เป็น session ไม่สำเร็จ', { message: error.message });
    return NextResponse.redirect(`${origin}/sign-in?error=invalid_code`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
