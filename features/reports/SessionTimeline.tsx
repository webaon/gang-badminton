import type { TimelineItem } from '@/domain/reports/timeline';

/**
 * ไทม์ไลน์ของนัด — **[WO-3.C]**
 *
 * 🔴 รับ `TimelineItem` ที่ผ่าน `buildTimeline()` มาแล้วเท่านั้น
 *    ❌ ห้ามรับ payload ดิบเข้ามาเรนเดอร์ — คีย์ที่ไม่ได้ whitelist ต้องไม่มีทางถึงจอ
 */
export function SessionTimeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm">ยังไม่มีเหตุการณ์</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm">
              {item.title}
              {item.detail ? <span className="opacity-70"> · {item.detail}</span> : null}
            </p>
            {item.actorName ? <p className="text-xs opacity-60">โดย {item.actorName}</p> : null}
          </div>
          <span className="shrink-0 text-xs opacity-60">
            {new Date(item.createdAt).toLocaleString('th-TH', {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}
