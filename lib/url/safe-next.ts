/**
 * ทำให้พารามิเตอร์ `next` (ปลายทางหลังล็อกอิน) ปลอดภัย
 *
 * 🔴 `next` มาจาก query string = **input ที่ผู้ใช้ควบคุมได้เต็มที่**
 *    ถ้าเอาไป redirect ตรงๆ จะเป็น open redirect: ส่งลิงก์
 *    `/sign-in?next=https://evil.example` ให้เหยื่อ พอล็อกอินเสร็จระบบจะพาไป
 *    หน้าปลอมที่หน้าตาเหมือนเว็บเรา แล้วขอรหัสผ่านซ้ำ
 *
 * กติกา: รับเฉพาะ path ภายในเท่านั้น
 *   - ต้องขึ้นต้นด้วย `/`
 *   - ห้ามขึ้นต้นด้วย `//` (protocol-relative URL — `//evil.example` พาออกนอกเว็บได้)
 *   - ห้ามขึ้นต้นด้วย `/\` (บางเบราว์เซอร์ตีความเหมือน `//`)
 *   - ห้ามมี backslash ปนใน path
 */
export const DEFAULT_NEXT = '/profile';

export function safeNext(raw: string | null | undefined, fallback = DEFAULT_NEXT): string {
  if (!raw) return fallback;

  const value = raw.trim();

  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  if (value.startsWith('/\\')) return fallback;
  if (value.includes('\\')) return fallback;

  return value;
}
