import 'server-only';

/**
 * LINE Login ระดับ **แพลตฟอร์ม** (ทางเข้าหลัก) — **[WO-B1.a · ADR-013]**
 *
 * ❗ คนละเรื่องกับ `server/line/login.ts` (WO-4.D · channel ต่อก๊วน ใช้ผูกบัญชีที่ล็อกอินอยู่)
 *    ตัวนี้ไม่แตะ `member_line_links` และไม่เรียก `link.ts` — ตัวตนระดับ Auth ผ่าน Supabase Auth API เท่านั้น
 *    (ADR-013 §0.1 Q8: ห้ามเขียน `auth.*` ตรง)
 *
 * 🔴 ซ่อนหลัง flag `LINE_PLATFORM_LOGIN_ENABLED=true` จนกว่า spike S1–S3, S5 จะผ่าน
 *    · fail-closed: ไม่ตั้ง / ค่าอื่น = ปิด (ทั้งปุ่มและ server action)
 *    · เป็น env ฝั่ง server (ไม่ใช่ `NEXT_PUBLIC_*`) ⇒ เปลี่ยนค่าแล้ว redeploy พอ ไม่ต้อง rebuild bundle
 */

/** id ของ Custom OIDC provider ใน Supabase (ต้องตรงกับที่เจ้าของงานตั้ง — `docs/ops/line-login-setup.md` ส่วน B) */
export const LINE_PLATFORM_PROVIDER = 'custom:line' as const;

/**
 * `next` ของ flow ผูก LINE กับบัญชีที่ล็อกอินอยู่ — **[WO-B1.c]**
 * ค่าเดียวที่ `/auth/callback` ยอมให้ส่งผู้ใช้กลับ `/profile` พร้อมสถานะ (ทั้งสำเร็จและล้มเหลว)
 * ⇒ เทียบแบบตรงตัวเท่านั้น ห้ามใช้ `startsWith`
 */
export const LINE_LINK_NEXT = '/profile?line=linked';

/** สถานะที่ `/profile?line=` ยอมรับ — อย่างอื่นไม่แสดงอะไร (ไม่ echo) */
export const LINE_PROFILE_STATUSES = ['linked', 'unlinked', 'denied', 'in_use', 'failed'] as const;
export type LineProfileStatus = (typeof LINE_PROFILE_STATUSES)[number];

export function parseLineProfileStatus(value: string | null | undefined): LineProfileStatus | null {
  return (LINE_PROFILE_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as LineProfileStatus)
    : null;
}

export function isLinePlatformLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LINE_PLATFORM_LOGIN_ENABLED === 'true';
}
