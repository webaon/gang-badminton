import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';

/**
 * Worker ส่ง notification
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 baseline §การแบ่งงาน cron: "งานที่เป็น app logic (ส่ง notification, …)
 *    ใช้ **Vercel Cron → route handler**; pg_cron ใช้เฉพาะงาน pure SQL"
 *    ⇒ worker ตัวนี้ต้องอยู่ฝั่งแอป ไม่ใช่ pg_cron (WO-1.5 จงใจไม่ต่อไว้ด้วยเหตุผลนี้)
 *
 * 🔴 claim ด้วย `FOR UPDATE SKIP LOCKED` (มีเทสต์ตั้งแต่ WO-1.3)
 *    ⇒ worker หลายตัวรันทับกันไม่หยิบงานเดียวกัน
 *
 * ⚠️ **in_app: แถวใน `notifications` คือตัวข้อความเอง** — ผู้ใช้เห็นในกระดิ่ง
 *    ตั้งแต่ตอนเข้าคิวแล้ว การ "ส่ง" จึงเป็นการบันทึกว่าถึงมือแล้ว
 *    ที่ยังต้องผ่านคิวเพราะ Phase 4 จะมี channel `line` ที่ต้องยิง API จริง
 *    ⇒ ให้ทั้งสอง channel เดินเส้นทางเดียวกันตั้งแต่แรก จะได้ไม่ต้องรื้อทีหลัง
 */

export type DispatchResult = {
  claimed: number;
  sent: number;
  failed: number;
};

type ClaimedNotification = {
  id: string;
  channel: string;
  event_type: string;
};

/** ส่งจริงตาม channel — คืน error message ถ้าล้มเหลว */
async function deliver(notification: ClaimedNotification): Promise<string | null> {
  switch (notification.channel) {
    case 'in_app':
      // ข้อความอยู่ในฐานข้อมูลแล้ว ไม่มีปลายทางภายนอกให้ยิง
      return null;

    case 'line':
      // Phase 4 — ยังไม่ implement
      // 🔴 คืน error ชัดๆ ไม่ mark sent หลอกๆ ไม่งั้นจะดูเหมือนส่งแล้วทั้งที่ไม่มีใครได้รับ
      return 'ยังไม่รองรับการส่งผ่าน LINE (Phase 4)';

    default:
      return `ไม่รู้จัก channel "${notification.channel}"`;
  }
}

export async function dispatchNotifications(
  correlationId: string,
  limit = 25,
): Promise<DispatchResult> {
  const admin = supabaseAdmin();

  const { data, error } = await admin.rpc('claim_notifications', { p_limit: limit });
  if (error) throw error;

  const claimed = (data ?? []) as ClaimedNotification[];
  let sent = 0;
  let failed = 0;

  for (const notification of claimed) {
    let deliveryError: string | null;

    try {
      deliveryError = await deliver(notification);
    } catch (err) {
      // 🔴 ห้าม swallow — ต้องลง last_error ให้ตามรอยได้ (CLAUDE.md §5)
      deliveryError = err instanceof Error ? err.message : String(err);
    }

    const { error: markError } = await admin.rpc('mark_notification_sent', {
      p_notification_id: notification.id,
      p_success: deliveryError === null,
      p_error: deliveryError,
    });

    if (markError) {
      // บันทึกผลไม่ได้ = แถวค้าง processing → sweep_stuck_notifications() คืนคิวให้เอง
      console.error('[notify] บันทึกผลส่งไม่สำเร็จ', {
        correlationId,
        notificationId: notification.id,
        message: markError.message,
      });
      failed += 1;
      continue;
    }

    if (deliveryError === null) sent += 1;
    else failed += 1;
  }

  console.info('[notify] dispatch เสร็จ', { correlationId, claimed: claimed.length, sent, failed });

  return { claimed: claimed.length, sent, failed };
}
