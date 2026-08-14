import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * งาน cron ที่เรียกผ่าน HTTP ได้
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ทำไมมีทั้ง pg_cron และ Vercel Cron
 *
 * baseline §Roadmap Phase 1 ระบุ "Vercel Cron config + pg_cron jobs" ทั้งคู่
 *
 *   pg_cron      = ตัวหลัก งานที่เป็น SQL ล้วน รันในฐานข้อมูลเอง ไม่พึ่งแอป
 *                  (ถ้าแอปล่ม/ยังไม่ deploy งานกวาดก็ยังเดิน)
 *   Vercel Cron  = เส้นสำรองที่พกพาได้ เผื่อ pg_cron ถูกปิดในบาง environment
 *                  และเป็นที่ทางสำหรับงานที่ต้องใช้ runtime ของแอปในอนาคต
 *                  (เช่น worker ส่ง notification จริง — Phase 2)
 *
 * ⚠️ รันซ้อนกันได้โดยไม่เสียหาย เพราะทั้งสามงานเป็น idempotent โดยธรรมชาติ:
 *    - sweep_waitlist            → promote_waitlist() lock แถว session แล้วนับใหม่ทุกครั้ง
 *    - sweep_stuck_notifications → แตะเฉพาะแถวที่ค้างเกิน threshold
 *    - purge_rate_limits         → ลบแถวที่หมดอายุ ซึ่งลบซ้ำก็ไม่มีอะไรให้ลบแล้ว
 *
 * ✅ **WO-2.10 ต่อ worker ส่ง notification เข้ามาแล้ว** (`notification-dispatch`)
 *    ตอน Phase 1 จงใจไม่ต่อเพราะยังไม่มีตัวส่ง — claim แล้วไม่ส่ง = ข้อความหาย
 *
 * ✅ **WO-2.5-C ต่อ MembershipBilling เข้ามา** (`monthly-fees`)
 *    เป็น app logic ไม่ใช่ SQL ล้วน (ต้องคิดเงินใน `domain/billing` ตาม ADR-001)
 *    ⇒ อยู่ฝั่ง Vercel Cron ตาม baseline §การแบ่งงาน cron
 *
 * ✅ **WO-2.5-E ต่อ generate นัดประจำ** (`session-generate`)
 *    ต้องประกอบ snapshot ด้วย `domain/` + แปลง timezone ⇒ เป็น app logic เช่นกัน
 *
 * ✅ **WO-2.5-G ต่องานเตือน** (`reminders`)
 *    ⚠️ งานนี้แค่ **เข้าคิว** — ตัวส่งยังเป็น `notification-dispatch` เดิม
 *    ❌ ห้ามสร้าง worker ใหม่
 */
/** งานที่เป็น SQL ล้วน — เรียก DB function ตรง */
export const CRON_JOBS = {
  'waitlist-sweep': 'sweep_waitlist',
  'notification-sweep': 'sweep_stuck_notifications',
  'rate-limits-purge': 'purge_rate_limits',
} as const;

/**
 * งานที่ต้องใช้ runtime ของแอป — ไม่ใช่ SQL ล้วน จึงอยู่ใน Vercel Cron
 * (baseline §การแบ่งงาน cron แยกสองประเภทนี้ไว้ชัดเจน)
 */
export const APP_CRON_JOBS = [
  'notification-dispatch',
  'monthly-fees',
  'session-generate',
  'reminders',
] as const;
export type AppCronJobName = (typeof APP_CRON_JOBS)[number];

export type CronJobName = keyof typeof CRON_JOBS;

export function isCronJobName(value: string): value is CronJobName {
  return Object.prototype.hasOwnProperty.call(CRON_JOBS, value);
}

export function isAppCronJobName(value: string): value is AppCronJobName {
  return (APP_CRON_JOBS as readonly string[]).includes(value);
}

export type CronJobResult = {
  job: CronJobName;
  affected: number;
  durationMs: number;
};

/**
 * เรียก DB function ของงานนั้น
 *
 * ฟังก์ชันทั้งสามคืน integer = จำนวนแถวที่จัดการไป ⇒ เอาไปใส่ log/response
 * ให้เห็นว่า cron ทำงานจริงหรือแค่รันผ่าน
 */
export async function runCronJob(
  job: CronJobName,
  correlationId: string,
): Promise<CronJobResult> {
  const startedAt = Date.now();

  const { data, error } = await supabaseAdmin().rpc(CRON_JOBS[job]);

  if (error) {
    // โยนต่อให้ respond() แปลงเป็น ErrorCode + log พร้อม correlation id
    throw error;
  }

  const result: CronJobResult = {
    job,
    affected: typeof data === 'number' ? data : 0,
    durationMs: Date.now() - startedAt,
  };

  console.info('[cron] job finished', { correlationId, ...result });

  return result;
}
