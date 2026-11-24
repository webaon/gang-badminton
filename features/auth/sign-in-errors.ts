/**
 * ข้อความของ `?error=` ที่ `/sign-in` — **[WO-B1.a]**
 *
 * 🔴 `error` มาจาก query string = input ที่ผู้ใช้ควบคุมได้ ⇒ **ไม่ echo ค่าที่ส่งมา**
 *    รับเฉพาะ code ในตารางนี้แล้วคืนข้อความตายตัว · code แปลก = ไม่แสดงอะไร
 *
 * code พวกนี้ถูกสร้างโดย `app/auth/callback/route.ts` เท่านั้น
 */
export const SIGN_IN_ERRORS_TH: Readonly<Record<string, string>> = {
  missing_code: 'ลิงก์เข้าสู่ระบบไม่สมบูรณ์ ลองเข้าสู่ระบบใหม่อีกครั้ง',
  invalid_code: 'ลิงก์เข้าสู่ระบบหมดอายุหรือถูกใช้ไปแล้ว ลองเข้าสู่ระบบใหม่อีกครั้ง',
  rate_limited: 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่',
  line_denied: 'ยกเลิกการเข้าสู่ระบบด้วย LINE แล้ว',
  oauth_failed: 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ ลองใหม่อีกครั้ง หรือใช้อีเมลแทน',
};

export function signInErrorText(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(SIGN_IN_ERRORS_TH, code) ? SIGN_IN_ERRORS_TH[code] : null;
}
