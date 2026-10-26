'use client';

import NextLink from 'next/link';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Theme} from '@astryxdesign/core/theme';
import {badgameTheme} from '@/theme/badgame.js';
import type {ReactNode} from 'react';

/**
 * Astryx theme provider.
 *
 * 🔴 ใช้ theme ที่ **build แล้ว** (`theme/badgame.js` มี `__built: true` + `theme/badgame.css`
 *    ที่ import ใน globals.css) — ห้ามชี้ไป `theme/src/badgame.ts` ซึ่งเป็น source ของ
 *    `defineTheme()` (runtime injection จะ inject หลัง hydration ⇒ first paint ไม่มี style)
 *    แก้ theme ที่ source แล้วรัน `npm run theme:build`
 *
 * mode="system" = ตาม OS preference (light/dark)
 *
 * 🔴 **[WO-5.A]** `LinkProvider` ตั้ง `next/link` เป็น component เริ่มต้นของลิงก์ Astryx ทั้งซับทรี
 *    ⇒ **ห้ามส่ง `as={NextLink}` จาก server component อีก** — Next 16 ห้ามส่ง component
 *      ข้ามขอบ RSC ไปให้ client component (`Functions cannot be passed directly to
 *      Client Components`) · ตั้งที่นี่ทีเดียวจบ เพราะไฟล์นี้อยู่ฝั่ง client อยู่แล้ว
 */
export function Providers({children}: {children: ReactNode}) {
  return (
    <Theme theme={badgameTheme} mode="system">
      <LinkProvider component={NextLink}>{children}</LinkProvider>
    </Theme>
  );
}
