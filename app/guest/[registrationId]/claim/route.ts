import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { GUEST_COOKIE, guestCookieOptions } from '@/lib/guest/session';
import { correlationIdFrom } from '@/shared/api';

// แตะฐานข้อมูลและตั้ง cookie ทุกครั้ง — ห้าม cache
export const dynamic = 'force-dynamic';

/**
 * แลก guest token ใน query string เป็น cookie httpOnly — **[WO-2.5-F]**
 *
 *   `/guest/<id>?t=<token>` → redirect มาที่นี่ → ตั้ง cookie → กลับไป `/guest/<id>` (ไม่มี token)
 *
 * 🔴 ตรวจ token ก่อนตั้ง cookie เสมอ — ไม่งั้นใครยิง URL มั่วก็ได้ cookie ติดไป
 *    แล้วหน้า guest จะแสดง "เปิดดูไม่ได้" ทั้งที่จริงคือ cookie ขยะ
 *
 * ❌ ห้าม log ค่า token (CLAUDE.md §2.5) — log ได้แค่ว่าแลกสำเร็จหรือไม่
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ registrationId: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request.headers);
  const { registrationId } = await context.params;

  const token = new URL(request.url).searchParams.get('t');
  const clean = new URL(`/guest/${registrationId}`, request.url);

  if (!token) return NextResponse.redirect(clean);

  const { error } = await supabaseAdmin().rpc('guest_registration', {
    p_registration_id: registrationId,
    p_guest_token: token,
  });

  if (error) {
    console.warn('[guest] แลก token ไม่สำเร็จ', { correlationId, registrationId });
    // ส่งกลับหน้าเดิมโดยไม่ตั้ง cookie — หน้านั้นจะขึ้น "เปิดดูไม่ได้" เอง
    return NextResponse.redirect(clean);
  }

  const response = NextResponse.redirect(clean);
  response.cookies.set({
    name: GUEST_COOKIE,
    value: token,
    ...guestCookieOptions(registrationId),
  });

  return response;
}
