'use client';

import { usePathname, useRouter } from 'next/navigation';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';

import { SESSION_TABS, type SessionTab } from '@/domain/sessions/member-view';

const LABELS: Record<SessionTab, string> = {
  upcoming: 'เร็วๆ นี้',
  mine: 'ของฉัน',
  past: 'ผ่านมาแล้ว',
};

/** hi-fi 17 `Seg` — ตัวกรองลิสต์นัด · เก็บค่าใน `?tab=` เพื่อให้ server render เนื้อหาตรงกับที่เลือก (แชร์ลิงก์/รีเฟรชได้) */
export function SessionFilterTabs({ value }: { value: SessionTab }) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <SegmentedControl
      label="กรองรายการนัด"
      layout="fill"
      value={value}
      onChange={(next) => {
        router.replace(next === 'upcoming' ? pathname : `${pathname}?tab=${next}`, { scroll: false });
      }}
    >
      {SESSION_TABS.map((tab) => (
        <SegmentedControlItem key={tab} value={tab} label={LABELS[tab]} />
      ))}
    </SegmentedControl>
  );
}
