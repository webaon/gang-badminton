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

/**
 * ค่าคงที่ล้วน (provider id, LINE_LINK_NEXT, สถานะ `/profile?line=`) ย้ายไป `platform-constants.ts`
 * เพราะ client component (`LineAccountPanel`) ต้อง import — ไฟล์นี้มี `server-only` import จาก client ไม่ได้
 * re-export ไว้ให้ฝั่ง server import จากที่เดิมได้
 */
export {
  LINE_PLATFORM_PROVIDER,
  LINE_LINK_NEXT,
  LINE_PROFILE_STATUSES,
  parseLineProfileStatus,
  type LineProfileStatus,
} from './platform-constants';

export function isLinePlatformLoginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LINE_PLATFORM_LOGIN_ENABLED === 'true';
}
