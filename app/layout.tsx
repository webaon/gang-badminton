import type {Metadata, Viewport} from 'next';
import './globals.css';
import {Providers} from './providers';
import {notoSansThai} from '@/lib/font';
import {badgameTheme} from '@/theme/badgame.js';

export const metadata: Metadata = {
  title: 'Gang Badminton',
  description: 'ระบบจัดการก๊วนแบดมินตัน — จองคิว เก็บเงิน จัดคู่ลงสนาม',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{children: React.ReactNode}>) {
  return (
    // `.variable` ประกาศ --font-noto-thai บน <html> ⇒ font stack ใน theme อ้างผ่านตัวแปรนี้
    // (`'Segoe UI', var(--font-noto-thai), system-ui`) · ตัวเลขใช้ tabular-nums ตาม v4
    //
    // `data-astryx-theme` ใส่ตั้งแต่ SSR — `<Theme>` ตั้งค่านี้บน <html> ตอน hydrate เหมือนกัน
    // แต่ CSS ของ theme (`@scope ([data-astryx-theme="badgame"])`) ต้องมีตัวนี้ก่อน first paint
    // ไม่งั้นพื้นหน้า/ฟอนต์จะแฟลชเป็น default [WO-6.0 QA ข้อสังเกต A]
    <html
      lang="th"
      className={notoSansThai.variable}
      data-astryx-theme={badgameTheme.name}
      suppressHydrationWarning
    >
      <body className="tabular-nums">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
