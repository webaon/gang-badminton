/**
 * โดเมนของแอป สำหรับประกอบ `redirectTo` ของ OAuth — **[WO-B1.a · ADR-013 §6.2]**
 *
 * 🔴 ต้อง **นิ่ง** และ **ปลอมไม่ได้**
 *    · Supabase เทียบ `redirectTo` กับ allow-list (Redirect URLs) แบบตรงตัว — ถ้าเดาจาก header
 *      แล้วผู้ใช้เข้าผ่าน alias (`*-ruddy.vercel.app`) ค่าจะหลุด allow-list
 *    · header `host` / `x-forwarded-host` / `origin` ผู้โจมตีปลอมได้ — ถ้าเชื่อ ⇒ `redirectTo` ชี้ไปโดเมนคนร้าย
 *      และ PKCE verifier ถูกเขียนลง cookie ของคนเรียก ⇒ เปิดทางยึด session ถ้า allow-list ของ Supabase หลวม
 *
 * กติกา **[WO-B1.a fix · QA ข้อ 3]**
 *   · production (`NODE_ENV === 'production'` หรือ `VERCEL_ENV` มีค่า) → ใช้ `APP_BASE_URL` **เท่านั้น**
 *     ไม่ตั้ง/ค่าพัง ⇒ คืน `null` (fail-closed) — ❌ ไม่ถอยไปเชื่อ header
 *   · dev / test → `APP_BASE_URL` ก่อน แล้วค่อย header `origin` → `x-forwarded-host` / `host` (ให้รัน localhost ได้)
 *   · ตั้ง `APP_BASE_URL` แล้ว header ถูกเมินเสมอ ไม่ว่าโหมดไหน
 *
 * ⚠️ allow-list ของ Supabase ยังเป็นด่านชั้นสอง — ต้องไม่มี wildcard กว้าง (ดู docs/ops/line-login-setup.md)
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

/** รันบน production จริงไหม — ตัดสินจาก env ที่ส่งเข้ามา (เทสต์ฉีด env เองได้) */
export function isProductionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'production' || Boolean(env.VERCEL_ENV);
}

export function resolveAppOrigin(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = toOrigin(env.APP_BASE_URL);
  if (configured) return configured;

  // 🔴 production: ไม่มี/พัง = หยุด ไม่เดาจาก header ที่ผู้โจมตีปลอมได้
  if (isProductionEnv(env)) return null;

  const fromOrigin = toOrigin(headers.get('origin'));
  if (fromOrigin) return fromOrigin;

  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host) return null;

  const proto = headers.get('x-forwarded-proto') ?? 'https';
  return toOrigin(`${proto}://${host}`);
}
