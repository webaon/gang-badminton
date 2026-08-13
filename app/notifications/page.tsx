import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { NotificationList, type NotificationRow } from '@/features/notifications/NotificationList';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'การแจ้งเตือน · Gang Badminton' };

export default async function NotificationsPage() {
  const user = await requireUser('/notifications');
  const supabase = await supabaseServer();

  /**
   * แสดงทุกสถานะยกเว้น `failed`
   *
   * สำหรับ `in_app` แถวในตารางคือตัวข้อความเอง ⇒ ผู้ใช้ควรเห็นตั้งแต่เข้าคิว
   * ไม่ต้องรอ worker (worker มีไว้เพื่อให้ channel อื่นอย่าง LINE เดินเส้นทางเดียวกัน)
   */
  const { data } = await supabase
    .from('notifications')
    .select('id, event_type, payload, created_at, read_at, status')
    .eq('recipient_id', user.id)
    .eq('channel', 'in_app')
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(50);

  type Row = {
    id: string;
    event_type: string;
    payload: { session_title?: string } | null;
    created_at: string;
    read_at: string | null;
  };

  const items: NotificationRow[] = ((data ?? []) as unknown as Row[]).map((n) => ({
    id: n.id,
    eventType: n.event_type,
    sessionTitle: n.payload?.session_title ?? null,
    createdAt: n.created_at,
    readAt: n.read_at,
  }));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <h1 className="mb-4 text-xl font-semibold">การแจ้งเตือน</h1>
      <Card padding={6}>
        <NotificationList items={items} />
      </Card>
    </main>
  );
}
