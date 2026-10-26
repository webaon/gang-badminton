'use client';

import { useRouter } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * แถบ "ไม่มีอินเทอร์เน็ต" — hi-fi K g1 · **[WO-6.1b]**
 *
 * สนามแบดมักสัญญาณแย่ ⇒ ต้องบอกผู้ใช้ตรงๆ ว่าข้อมูลบนจออาจไม่ล่าสุด แทนที่จะให้กดปุ่มแล้วเงียบ
 *   · อ่านสถานะจาก `navigator.onLine` + event `online`/`offline` ผ่าน `useSyncExternalStore`
 *   · server snapshot = ออนไลน์ ⇒ HTML ที่ prerender (หน้าแรก static) ไม่เปลี่ยน ไม่มี hydration mismatch
 *   · `role="status"` (Banner) ⇒ screen reader ประกาศเมื่อสถานะเปลี่ยน
 */
function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const getSnapshot = () => navigator.onLine;
const getServerSnapshot = () => true;

export function OfflineBanner() {
  const router = useRouter();
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (isOnline) return null;

  return (
    <VStack className="sticky top-0 z-50">
      <Banner
        status="warning"
        container="section"
        title="ไม่มีอินเทอร์เน็ต — ข้อมูลอาจไม่ล่าสุด"
        endContent={
          <Button
            label="ลองใหม่"
            variant="secondary"
            size="sm"
            onClick={() => {
              if (navigator.onLine) router.refresh();
            }}
          />
        }
      />
    </VStack>
  );
}
