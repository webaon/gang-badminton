/**
 * โดเมนของแอป สำหรับประกอบ `redirectTo` ของ OAuth — **[WO-B1.a · ADR-013 §6.2]**
 *
 * 🔴 ต้อง **นิ่ง**: Supabase เทียบ `redirectTo` กับ allow-list (Redirect URLs) แบบตรงตัว
 *    ถ้าเดาจาก header แล้วผู้ใช้เข้าผ่าน alias (`*-ruddy.vercel.app`) ค่าจะหลุด allow-list
 *    ⇒ ใช้ `APP_BASE_URL` ก่อนเสมอ (ตั้งไว้ใน Vercel) · header เป็นแค่ทางสำรอง
 *
 * ลำดับ: `APP_BASE_URL` → header `origin` → `x-forwarded-host` / `host`
 * คืน `null` เมื่อหาไม่ได้ หรือค่าไม่ใช่ http(s) ที่ถูกต้อง — ❌ ไม่เดาค่าเอง
 *
 * ⚠️ ฟังก์ชันนี้ไม่ได้ทำให้ค่า "ปลอดภัย" เพียงลำพัง — ผู้ใช้ปลอม header `host` ได้
 *    ด่านจริงคือ allow-list ของ Supabase (ปลอมแล้ว Supabase ปฏิเสธ `redirectTo`)
 */
type HeaderReader = { get(name: string): string | null };

function toOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveAppOrigin(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = toOrigin(env.APP_BASE_URL);
  if (configured) return configured;

  const fromOrigin = toOrigin(headers.get('origin'));
  if (fromOrigin) return fromOrigin;

  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host) return null;

  const proto = headers.get('x-forwarded-proto') ?? 'https';
  return toOrigin(`${proto}://${host}`);
}
