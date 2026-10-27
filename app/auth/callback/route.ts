import { NextResponse, type NextRequest } from 'next/server';

import { LINE_LINK_NEXT } from '@/lib/line/platform-login';
import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/url/safe-next';
import { withinRateLimit } from '@/server/security/rate-limit';

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

  // **[WO-B1.a]** ผู้ให้บริการ OAuth (LINE ผ่าน Supabase) ส่ง `?error=` กลับมาตอนผู้ใช้กดยกเลิกหรือ
  // ตั้งค่าผิด · 🔴 ไม่ส่ง `error_description` ต่อไปให้ผู้ใช้ (ข้อความดิบจากภายนอก) —
  // map เป็น code ตายตัวที่ `/sign-in` รู้จักเท่านั้น (`features/auth/sign-in-errors.ts`)
  const providerError = searchParams.get('error');

  // **[WO-B1.c]** flow "ผูก LINE กับบัญชีที่ล็อกอินอยู่" ใช้ `next` ค่าเฉพาะ (เทียบตรงตัว ไม่ใช่ startsWith)
  //   ⇒ ล้มเหลวแล้วพากลับ `/profile?line=<สถานะ>` แทนการเด้งไป /sign-in ทั้งที่ผู้ใช้ยังล็อกอินอยู่
  //   `error_code=identity_already_exists` = LINE นี้ผูกกับบัญชีอื่นแล้ว (ชื่อ code ตาม docs ของ Supabase — ยังไม่ยืนยันบน cloud · S2;
  //   ถ้าไม่ตรงจะตกเป็น `failed` ซึ่งปลอดภัย ไม่เปิดเผยว่าเป็นบัญชีของใคร)
  const isLinkFlow = searchParams.get('next') === LINE_LINK_NEXT;

  if (providerError) {
    console.warn('[auth] ผู้ให้บริการ OAuth ตอบ error', { error: providerError.slice(0, 64) });

    if (isLinkFlow) {
      const status =
        providerError === 'access_denied'
          ? 'denied'
          : searchParams.get('error_code') === 'identity_already_exists'
            ? 'in_use'
            : 'failed';
      return NextResponse.redirect(`${origin}/profile?line=${status}`);
    }

    const reason = providerError === 'access_denied' ? 'line_denied' : 'oauth_failed';
    return NextResponse.redirect(`${origin}/sign-in?error=${reason}`);
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}${isLinkFlow ? '/profile?line=failed' : '/sign-in?error=missing_code'}`,
    );
  }

  // 🔴 **[WO-5.C]** เปิดสาธารณะและแลก code กับ Supabase ทุกครั้ง ⇒ ต้องมีเพดานต่อ IP
  //    เพดานตั้งหลวมพอให้คนหลัง NAT เดียวกันยืนยันอีเมลพร้อมกันได้ (ไม่ใช่ 3-5 ครั้ง)
  const allowed = await withinRateLimit({
    scope: 'auth:callback',
    headers: request.headers,
    limit: 30,
    window: '1 hour',
  });

  if (!allowed) {
    return NextResponse.redirect(
      `${origin}${isLinkFlow ? '/profile?line=failed' : '/sign-in?error=rate_limited'}`,
    );
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.warn('[auth] แลก code เป็น session ไม่สำเร็จ', { message: error.message });
    return NextResponse.redirect(
      `${origin}${isLinkFlow ? '/profile?line=failed' : '/sign-in?error=invalid_code'}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
