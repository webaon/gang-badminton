import type {Metadata, Viewport} from 'next';
import './globals.css';
import {Providers} from './providers';

export const metadata: Metadata = {
  title: 'Gang Badminton',
  description: 'ระบบจัดการก๊วนแบดมินตัน — จองคิว เก็บเงิน จัดคู่ลงสนาม',
};

// mobile-first ตาม baseline (สถาปัตยกรรม: Next.js 15 App Router, mobile-first)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{children: React.ReactNode}>) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
