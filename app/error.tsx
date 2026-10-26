'use client';

import { useEffect } from 'react';

import { StatePanel } from '@/components/ui/StatePanel';

/**
 * ขอบเขต error ของทั้งแอป — hi-fi K g4 (5xx) · **[WO-6.1b]**
 *
 * 🔴 ห้ามแสดง `error.message` — ข้อความดิบอาจเป็น SQL/ชื่อตาราง/token (production Next ตัดให้เองอยู่แล้ว
 *    แต่ dev ไม่ตัด) แสดงเฉพาะรหัสอ้างอิง `digest` ที่ผู้ใช้อ่านให้ทีมงานค้น log ได้
 * 🔴 ห้ามกลืนเงียบ — log ชื่อ + digest ลง console (ไม่ log message/stack เผื่อมี token ใน URL)
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[error-boundary]', { name: error.name, digest: error.digest });
  }, [error]);

  return (
    <StatePanel
      tone="error"
      title="ระบบขัดข้องชั่วคราว"
      description="ทีมงานรับทราบแล้ว ลองใหม่อีกครั้งในไม่ช้า"
      actions={[
        { label: 'ลองใหม่', onClick: reset },
        { label: 'กลับหน้าแรก', href: '/', variant: 'secondary' },
      ]}
    >
      {error.digest ? <p className="text-xs opacity-70">รหัสอ้างอิง: {error.digest}</p> : null}
    </StatePanel>
  );
}
