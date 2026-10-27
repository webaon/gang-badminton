/**
 * ค่าคงที่/ฟังก์ชันล้วนของ LINE Login ระดับแพลตฟอร์ม ที่ **client component import ได้** — [WO-B1.c · ADR-013]
 *
 * ❗ ห้ามใส่ `import 'server-only'` และห้ามอ่าน env/DB ในไฟล์นี้
 *    (`platform-login.ts` มี `server-only` — ถ้า client component import ตรงๆ `next build` ล้ม)
 * `platform-login.ts` re-export ทุกอย่างจากไฟล์นี้ ⇒ ฝั่ง server import จากที่เดิมได้เหมือนเดิม
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
