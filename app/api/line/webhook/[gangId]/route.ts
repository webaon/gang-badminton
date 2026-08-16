/**
 * Webhook ของ LINE ต่อก๊วน — `/api/line/webhook/<gangId>` · **[WO-4.B]**
 *
 * route บางๆ ตาม CLAUDE.md §3: อ่าน raw body + header แล้วส่งต่อให้ `server/line/`
 *
 * 🔴 **ห้าม `await request.json()`** — ลายเซ็นคำนวณจาก raw body ⇒ ต้องอ่านด้วย `.text()`
 *    ก่อนเสมอ แล้วค่อย parse ทีหลัง (ทำใน `handleLineWebhook`)
 */
import { correlationIdFrom, fail, httpStatusFor, ok } from '@/shared/api';
import { handleLineWebhook } from '@/server/line/webhook';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ gangId: string }> },
): Promise<Response> {
  const correlationId = correlationIdFrom(request.headers);
  const { gangId } = await context.params;

  const rawBody = await request.text();
  const signature = request.headers.get('x-line-signature');

  try {
    const outcome = await handleLineWebhook({ gangId, rawBody, signature, correlationId });

    if (outcome.errorCode) {
      return json(fail(outcome.errorCode), outcome.status, correlationId);
    }

    return json(ok({ handled: outcome.handled, ignored: outcome.ignored }), 200, correlationId);
  } catch (err) {
    // 🔴 ห้าม swallow — แต่ต้องไม่คืนรายละเอียดภายในให้ปลายทางที่เราไม่ได้ควบคุม
    console.error('[line] webhook ล้ม', {
      correlationId,
      gangId,
      message: err instanceof Error ? err.message : String(err),
    });
    return json(fail('INTERNAL_ERROR'), httpStatusFor('INTERNAL_ERROR'), correlationId);
  }
}

function json(body: unknown, status: number, correlationId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-correlation-id': correlationId,
      'cache-control': 'no-store',
    },
  });
}
