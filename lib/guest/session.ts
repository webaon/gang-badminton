import 'server-only';

import { cookies } from 'next/headers';

/**
 * guest token ใน cookie httpOnly — **[WO-2.5-F]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ปัญหาเดิม: token อยู่ใน query string (`/guest/<id>?t=…`)
 *    ⇒ ติดไปกับ referrer, log ของ proxy/CDN, ประวัติเบราว์เซอร์ และ URL ที่แชร์ต่อ
 *
 * วิธีแก้: เปิดลิงก์ครั้งแรก → แลกเป็น cookie **httpOnly** → redirect ทิ้ง query string
 *
 * ⚠️ cookie ตั้ง `path` เจาะจงถึงหน้าของ registration นั้น ⇒ เบราว์เซอร์ไม่ส่ง
 *    token ของแขกคนหนึ่งไปยังหน้าอื่นเลย (รวมถึงหน้าของแขกอีกคน)
 *
 * ⚠️ `httpOnly` ⇒ JavaScript ฝั่ง client อ่านไม่ได้ · server action อ่านได้ตามปกติ
 *    เพราะ POST ไปที่ path เดียวกัน
 *
 * ❌ ห้าม log ค่านี้ทุกกรณี (CLAUDE.md §2.5) — ฐานข้อมูลเก็บแค่ SHA-256 hash
 */

export const GUEST_COOKIE = 'gb_guest_token';

/** 30 วัน — ยาวพอสำหรับนัดที่จองล่วงหน้า แต่ไม่ใช่ตลอดไป */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function guestCookiePath(registrationId: string): string {
  return `/guest/${registrationId}`;
}

/**
 * ตัวเลือกของ cookie — แยกออกมาเพราะ route handler ต้อง set ลงบน `NextResponse`
 * โดยตรง (ตั้งผ่าน `cookies()` แล้วคืน redirect ไม่รับประกันว่าจะติดไปกับ response)
 */
export function guestCookieOptions(registrationId: string) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // production เท่านั้น — dev ใช้ http://localhost แล้ว secure จะทำให้ cookie ไม่ถูกตั้ง
    secure: process.env.NODE_ENV === 'production',
    path: guestCookiePath(registrationId),
    maxAge: MAX_AGE_SECONDS,
  };
}

export async function readGuestCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(GUEST_COOKIE)?.value ?? null;
}

export async function clearGuestCookie(registrationId: string): Promise<void> {
  const store = await cookies();
  store.delete({ name: GUEST_COOKIE, path: guestCookiePath(registrationId) });
}
