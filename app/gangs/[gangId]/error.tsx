'use client';

import { useEffect } from 'react';

import { StatePanel } from '@/components/ui/StatePanel';

/**
 * error ภายใน `/gangs/[gangId]/*` — ให้ shell (header + เมนู) ยังอยู่ แทนที่แค่เนื้อหา · **[WO-6.1b]**
 * (error ที่เกิดใน `layout.tsx` ของ segment นี้เองยังไปตกที่ `app/error.tsx`)
 * กติกาเดียวกับ `app/error.tsx`: ไม่แสดง message ดิบ · log เฉพาะ name + digest
 */
export default function GangError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[error-boundary:gang]', { name: error.name, digest: error.digest });
  }, [error]);

  return (
    <StatePanel
      fullPage={false}
      headingLevel={2}
      tone="error"
      title="ระบบขัดข้องชั่วคราว"
      description="หน้านี้โหลดไม่สำเร็จ ลองใหม่อีกครั้ง"
      actions={[{ label: 'ลองใหม่', onClick: reset }]}
    >
      {error.digest ? <p className="text-xs opacity-70">รหัสอ้างอิง: {error.digest}</p> : null}
    </StatePanel>
  );
}
