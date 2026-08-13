/**
 * Cron endpoint — `/api/cron/<job>`
 *
 * route บางๆ ตาม CLAUDE.md §3: ตรวจสิทธิ์ + เรียก `server/cron/` แล้วจบ
 * logic จริงอยู่ใน `server/cron/jobs.ts` ทั้งหมด
 *
 * ตอบตาม API response contract (CLAUDE.md §4) ผ่าน `respond()` เสมอ
 */
import { correlationIdFrom, fail, httpStatusFor, respond } from '@/shared/api';
import { isAuthorizedCronRequest } from '@/server/cron/auth';
import { isAppCronJobName, isCronJobName, runCronJob } from '@/server/cron/jobs';
import { dispatchNotifications } from '@/server/cron/notifications';
import { billAllGangs } from '@/server/membership/billing';

// งาน cron แตะฐานข้อมูลจริงทุกครั้ง — ห้าม prerender หรือ cache
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ job: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request.headers);

  if (!isAuthorizedCronRequest(request.headers)) {
    console.warn('[cron] ปฏิเสธ request ที่ไม่มีสิทธิ์', { correlationId });
    return jsonError('CRON_UNAUTHORIZED', correlationId);
  }

  const { job } = await context.params;

  // งานที่ต้องใช้ runtime ของแอป (คิดเงิน/ส่ง notification) แยกจากงาน SQL ล้วน
  if (isAppCronJobName(job)) {
    if (job === 'monthly-fees') {
      return respond(correlationId, () => billAllGangs(correlationId));
    }
    return respond(correlationId, () => dispatchNotifications(correlationId));
  }

  if (!isCronJobName(job)) {
    return jsonError('NOT_FOUND', correlationId, `ไม่รู้จักงาน cron ชื่อ "${job}"`);
  }

  return respond(correlationId, () => runCronJob(job, correlationId));
}

function jsonError(
  code: Parameters<typeof fail>[0],
  correlationId: string,
  message?: string,
): Response {
  return new Response(JSON.stringify(fail(code, message)), {
    status: httpStatusFor(code),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-correlation-id': correlationId,
      'cache-control': 'no-store',
    },
  });
}
