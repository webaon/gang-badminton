'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { markAllRead, markNotificationRead } from '@/server/actions/notifications';

export type NotificationRow = {
  id: string;
  eventType: string;
  sessionTitle: string | null;
  createdAt: string;
  readAt: string | null;
};

const EVENT_LABELS: Record<string, string> = {
  'session.opened': 'เปิดรับสมัครนัดใหม่',
  'waitlist.promoted': 'คิวถึงคุณแล้ว — ได้ที่เล่น',
  'payment.due': 'มียอดที่ต้องจ่าย',
  // [WO-2.5-G] งานเตือน
  'session.reminder': 'ใกล้ถึงเวลานัดแล้ว',
  'payment.overdue': 'ยังมียอดค้างจ่าย',
};

export function NotificationList({ items }: { items: NotificationRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const unread = items.filter((n) => n.readAt === null);

  async function run(fn: () => Promise<{ success: boolean; error?: { message: string } }>) {
    setPending(true);
    setError(null);
    const result = await fn();
    if (result.success) router.refresh();
    else setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');
    setPending(false);
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm">ยังไม่ได้อ่าน {unread.length} รายการ</p>
        {unread.length > 0 ? (
          <Button
            size="sm"
            label="อ่านทั้งหมดแล้ว"
            isDisabled={pending}
            onClick={() => run(markAllRead)}
          />
        ) : null}
      </div>

      {error ? <Banner status="error" title={error} /> : null}

      {items.length === 0 ? (
        <p className="text-sm">ยังไม่มีการแจ้งเตือน</p>
      ) : (
        <ul className="divide-y">
          {items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className={n.readAt === null ? 'font-medium' : ''}>
                  {EVENT_LABELS[n.eventType] ?? n.eventType}
                </p>
                {n.sessionTitle ? <p className="text-sm">{n.sessionTitle}</p> : null}
              </div>

              {n.readAt === null ? (
                <div className="flex items-center gap-2">
                  <Badge label="ใหม่" />
                  <Button
                    size="sm"
                    variant="ghost"
                    label="อ่านแล้ว"
                    isDisabled={pending}
                    onClick={() => run(() => markNotificationRead(n.id))}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
