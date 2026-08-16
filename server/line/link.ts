import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * ผูกบัญชี LINE + เข้าคิวข้อความยืนยัน — **[WO-4.B/4.D]**
 *
 * 🔴 มีสองทางเข้าที่ผูกบัญชีได้: รหัสในแชต (webhook · WO-4.B) และ LINE Login (WO-4.D)
 *    ⇒ รวมไว้ที่นี่ที่เดียว ไม่งั้นวันหนึ่งสองทางจะทำไม่เหมือนกัน (เช่นทางหนึ่งลืมยิงยืนยัน)
 *
 * ❌ ไม่เรียก reply/push API ตรงจากที่นี่ — เข้าคิวเดิมเสมอ (worker ของ WO-4.C เป็นคนส่ง)
 */
export async function linkAndNotify(input: {
  gangId: string;
  userId: string;
  lineUserId: string;
  correlationId: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { gangId, userId, lineUserId, correlationId } = input;
  const admin = supabaseAdmin();

  const { error } = await admin.rpc('link_line_account', {
    p_gang_id: gangId,
    p_user_id: userId,
    p_line_user_id: lineUserId,
    p_correlation_id: correlationId,
  });

  if (error) {
    console.warn('[line] ผูกบัญชีไม่สำเร็จ', { correlationId, gangId, message: error.message });
    return { ok: false, message: error.message };
  }

  // dedupe ผูกกับ (ก๊วน, ผู้ใช้, บัญชี LINE) ⇒ ผูกซ้ำใบเดิมไม่ได้ข้อความซ้ำ
  const { error: queueError } = await admin.rpc('enqueue_notifications', {
    p_rows: [
      {
        gang_id: gangId,
        recipient_id: userId,
        event_type: 'line.linked',
        payload: { correlation_id: correlationId },
        dedupe_key: `line-link:${gangId}:${userId}:${lineUserId}`,
      },
    ],
  });

  if (queueError) {
    // ผูกสำเร็จแล้ว — แค่ข้อความยืนยันเข้าคิวไม่ได้ ⇒ ไม่ถือว่าการผูกล้ม
    console.error('[line] เข้าคิวข้อความยืนยันการผูกบัญชีไม่สำเร็จ', {
      correlationId,
      gangId,
      message: queueError.message,
    });
  }

  return { ok: true };
}
