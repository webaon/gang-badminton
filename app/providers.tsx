'use client';

import NextLink from 'next/link';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Theme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import type {ReactNode} from 'react';

/**
 * Astryx theme provider.
 *
 * ใช้ `/built` + `theme.css` (import ใน globals.css) ตามคำแนะนำ Astryx สำหรับ SSR
 * — runtime injection จะ inject หลัง hydration ทำให้ first paint ไม่มี style
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
    <Theme theme={neutralTheme} mode="system">
      <LinkProvider component={NextLink}>{children}</LinkProvider>
    </Theme>
  );
}
