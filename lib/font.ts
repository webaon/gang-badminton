import {Noto_Sans_Thai} from 'next/font/google';

/**
 * Noto Sans Thai — self-host ผ่าน `next/font/google` (ดาวน์โหลดตอน build แล้วเสิร์ฟจาก origin เรา)
 * ⇒ ไม่เรียก fonts.googleapis.com ตอน runtime และไม่ต้องแก้ CSP (WO-6.0)
 *
 * ใช้ผ่านตัวแปร CSS `--font-noto-thai` เท่านั้น (ใส่ `.variable` บน <html>) —
 * font stack จริงคือ `'Segoe UI', var(--font-noto-thai), system-ui` ซึ่งประกาศใน theme/src/badgame.ts
 */
export const notoSansThai = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-noto-thai',
});
