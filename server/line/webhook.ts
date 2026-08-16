import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { verifyLineSignature } from '@/lib/line/signature';
import { extractLinkCode, verifyLinkCode } from '@/lib/line/link-code';
import { linkAndNotify } from './link';
import type { ErrorCode } from '@/shared/errors';

/**
 * Webhook ของ LINE ต่อก๊วน — **[WO-4.B]**
 *
 * 🔴 **verify ก่อนแตะอะไรทั้งนั้น** — ทุกอย่างใน body เป็นข้อมูลที่ใครก็ยิงมาได้
 *    จนกว่าลายเซ็นจะผ่าน (รวมถึง `userId` ที่เราเอาไปผูกบัญชี)
 *
 * 🔴 **ห้ามยิง API ภายนอกใน request นี้** — LINE มี timeout สั้นและ retry เอง
 *    ⇒ ที่นี่ทำแค่ "อ่าน event แล้วเขียน DB" · งานที่ต้องคุยกับ LINE เป็นของ WO-4.C ผ่านคิวเดิม
 *
 * ✅ **[WO-4.C]** ข้อความยืนยัน "ผูกบัญชีสำเร็จ" ถูกส่งแล้ว — แต่ **ผ่านคิวเดิม**
 *    (`enqueue_notifications` → worker) ไม่ใช่ reply API ในคำขอนี้ ⇒ ยังตอบ 200 ให้ LINE ได้เร็ว
 *    นี่คือของที่ WO-4.B บันทึกไว้ว่า "เลื่อนไป 4.C" และปิดเรียบร้อยแล้ว
 */

export type WebhookOutcome = {
  status: number;
  /** null = สำเร็จ (ตอบ 200 ให้ LINE) */
  errorCode: ErrorCode | null;
  handled: number;
  ignored: number;
};

type LineEvent = {
  type?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
};

type Credentials = {
  channel_secret: string | null;
  is_enabled: boolean;
};

const OK = (handled: number, ignored: number): WebhookOutcome => ({
  status: 200,
  errorCode: null,
  handled,
  ignored,
});

const REJECT = (status: number, errorCode: ErrorCode): WebhookOutcome => ({
  status,
  errorCode,
  handled: 0,
  ignored: 0,
});

export async function handleLineWebhook(input: {
  gangId: string;
  rawBody: string;
  signature: string | null;
  correlationId: string;
}): Promise<WebhookOutcome> {
  const { gangId, rawBody, signature, correlationId } = input;
  const admin = supabaseAdmin();

  const { data, error } = await admin.rpc('get_gang_line_credentials', { p_gang_id: gangId });
  if (error) throw error;

  const credentials = (data as Credentials[] | null)?.[0];

  // ยังไม่ได้ตั้งค่า = ไม่มี secret ให้ verify ⇒ ปฏิเสธแบบไม่บอกรายละเอียด
  if (!credentials?.channel_secret) {
    console.warn('[line] webhook ของก๊วนที่ยังไม่ได้ตั้งค่า', { correlationId, gangId });
    return REJECT(404, 'NOT_FOUND');
  }

  // 🔴 verify ก่อนเสมอ — แม้ก๊วนจะปิด flag อยู่ ก็ยังต้องพิสูจน์ก่อนว่ามาจาก LINE จริง
  //    (ไม่งั้น endpoint นี้จะบอกสถานะ flag ของก๊วนให้ใครก็ได้ที่ยิงมั่ว)
  if (!verifyLineSignature(rawBody, signature, credentials.channel_secret)) {
    console.warn('[line] ลายเซ็นไม่ถูกต้อง', { correlationId, gangId });
    return REJECT(401, 'WEBHOOK_SIGNATURE_INVALID');
  }

  if (!credentials.is_enabled) {
    return REJECT(403, 'FEATURE_DISABLED');
  }

  let events: LineEvent[];
  try {
    events = (JSON.parse(rawBody) as { events?: LineEvent[] }).events ?? [];
  } catch {
    return REJECT(400, 'VALIDATION_ERROR');
  }

  let handled = 0;
  let ignored = 0;

  for (const event of events) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) {
      ignored += 1;
      continue;
    }

    switch (event.type) {
      case 'unfollow': {
        // บล็อก/ลบเพื่อน OA — ห้ามส่งหาเขาอีกจนกว่าจะ follow กลับ
        await setBlocked(gangId, lineUserId, true, correlationId);
        handled += 1;
        break;
      }

      case 'follow': {
        await setBlocked(gangId, lineUserId, false, correlationId);
        handled += 1;
        break;
      }

      case 'message': {
        const linked = await tryLink(gangId, lineUserId, event.message, correlationId);
        if (linked) handled += 1;
        else ignored += 1;
        break;
      }

      default:
        ignored += 1;
    }
  }

  return OK(handled, ignored);
}

async function setBlocked(
  gangId: string,
  lineUserId: string,
  blocked: boolean,
  correlationId: string,
): Promise<void> {
  const { error } = await supabaseAdmin().rpc('set_line_link_blocked', {
    p_gang_id: gangId,
    p_line_user_id: lineUserId,
    p_blocked: blocked,
    p_correlation_id: correlationId,
  });

  // ❌ ห้าม swallow — แต่ต้องไม่ทำให้ทั้ง webhook ล้ม (LINE จะ retry ทั้งก้อน)
  if (error) {
    console.error('[line] อัปเดตสถานะบล็อกไม่สำเร็จ', {
      correlationId,
      gangId,
      message: error.message,
    });
  }
}

/**
 * ข้อความที่มี "รหัสผูกบัญชี" = คำสั่งเดียวที่ใบนี้รู้จัก
 *
 * รหัสเป็นแบบ stateless (ดู `lib/line/link-code.ts`) ⇒ ไม่มีตารางรหัสให้ค้น
 * และรหัสของก๊วนอื่นใช้ที่นี่ไม่ได้เพราะ `gangId` ถูกผูกไว้ในลายเซ็นของรหัส
 */
async function tryLink(
  gangId: string,
  lineUserId: string,
  message: LineEvent['message'],
  correlationId: string,
): Promise<boolean> {
  if (message?.type !== 'text' || !message.text) return false;

  const code = extractLinkCode(message.text);
  if (!code) return false;

  const userId = verifyLinkCode(code, gangId);
  if (!userId) {
    // รหัสผิด/หมดอายุ/ของก๊วนอื่น — ไม่บอกรายละเอียดและไม่ถือเป็น error ของ webhook
    console.info('[line] รหัสผูกบัญชีใช้ไม่ได้', { correlationId, gangId });
    return false;
  }

  // ผูก + เข้าคิวข้อความยืนยัน — เส้นทางเดียวกับ LINE Login (WO-4.D)
  const result = await linkAndNotify({ gangId, userId, lineUserId, correlationId });

  return result.ok;
}
