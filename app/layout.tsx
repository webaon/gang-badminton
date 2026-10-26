import type {Metadata, Viewport} from 'next';
import './globals.css';
import {Providers} from './providers';
import {notoSansThai} from '@/lib/font';

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
    <html lang="th" className={notoSansThai.variable} suppressHydrationWarning>
      <body className="tabular-nums">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
