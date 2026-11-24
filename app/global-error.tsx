'use client';

import './globals.css';

import { useEffect } from 'react';

import { StatePanel } from '@/components/ui/StatePanel';
import { notoSansThai } from '@/lib/font';
import { badgameTheme } from '@/theme/badgame.js';

import { Providers } from './providers';

/**
 * error ที่เกิดใน root layout เอง — แทนที่ทั้ง `<html>` จึงต้องประกอบ shell ของตัวเองครบ · **[WO-6.1b]**
 * (theme + ฟอนต์ + Providers เหมือน `layout.tsx` ⇒ หน้าตาเหมือนส่วนอื่น ไม่ใช่หน้าขาวเปล่า)
 *
 * `/_global-error` อยู่ใน `STATIC_ROUTES` แล้ว (prerender) — ไฟล์นี้ไม่ดึงข้อมูล จึงยังเป็น static
 * กติกาเดียวกับ `error.tsx`: ไม่แสดง message ดิบ · log เฉพาะ name + digest
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', { name: error.name, digest: error.digest });
  }, [error]);

  return (
    <html lang="th" className={notoSansThai.variable} data-astryx-theme={badgameTheme.name} suppressHydrationWarning>
      <body className="tabular-nums">
        <Providers>
          <StatePanel
            tone="error"
            title="ระบบขัดข้องชั่วคราว"
            description="ทีมงานรับทราบแล้ว ลองใหม่อีกครั้งในไม่ช้า"
            actions={[{ label: 'ลองใหม่', onClick: reset }]}
          >
            {error.digest ? <p className="text-xs opacity-70">รหัสอ้างอิง: {error.digest}</p> : null}
          </StatePanel>
        </Providers>
      </body>
    </html>
  );
}
