/**
 * ปลายทางของ LINE Login — `/api/line/login/callback` · **[WO-4.D]**
 *
 * route บางๆ ตาม CLAUDE.md §3: อ่าน query + cookie แล้วส่งต่อให้ `server/line/login.ts`
 * จบด้วยการ **redirect กลับหน้าเดิม** (ผู้ใช้มาจากเบราว์เซอร์ ไม่ใช่ API client)
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/supabase/server';
import { LINE_LOGIN_NONCE_COOKIE } from '@/lib/line/login-state';
import { handleLoginCallback } from '@/server/line/login';
import { withinRateLimit } from '@/server/security/rate-limit';
import { correlationIdFrom } from '@/shared/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFrom(request.headers);
  const url = new URL(request.url);
  const jar = await cookies();

  // 🔴 **[WO-5.C]** เปิดสาธารณะและแลก code กับ LINE ทุกครั้ง ⇒ ต้องมีเพดานต่อ IP
  const allowed = await withinRateLimit({
    scope: 'line:login-callback',
    headers: request.headers,
    limit: 20,
    window: '1 hour',
  });

  if (!allowed) {
    const response = NextResponse.redirect(new URL('/gangs?error=rate_limited', url.origin));
    response.cookies.set(LINE_LOGIN_NONCE_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  }

  const result = await handleLoginCallback(
    {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      nonceCookie: jar.get(LINE_LOGIN_NONCE_COOKIE)?.value ?? null,
      redirectUri: `${url.origin}${url.pathname}`,
      correlationId,
    },
    { currentUserId: async () => (await currentUser())?.id ?? null },
  );

  const target = result.ok
    ? `/gangs/${result.gangId}/line?linked=1`
    : result.gangId
      ? `/gangs/${result.gangId}/line?error=${result.reason}`
      : '/gangs';

  const response = NextResponse.redirect(new URL(target, url.origin));

  // nonce เป็นของใช้ครั้งเดียว — ลบทิ้งเสมอ ไม่ว่าจะสำเร็จหรือไม่
  response.cookies.set(LINE_LOGIN_NONCE_COOKIE, '', { path: '/', maxAge: 0 });

  return response;
}
