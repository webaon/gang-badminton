'use client';

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
 */
export function Providers({children}: {children: ReactNode}) {
  return (
    <Theme theme={neutralTheme} mode="system">
      {children}
    </Theme>
  );
}
