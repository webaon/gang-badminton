'use client';

import type { ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';

import { badgameTheme } from '@/theme/badgame.js';

/**
 * บังคับธีมมืด (navy) ให้กระดานคิวสดทั้งจอ แม้เครื่องที่สนามตั้งเป็นโหมดสว่าง — **[WO-6.4a · hi-fi 24]**
 *
 * token ของ theme ประกาศเป็น `light-dark(...)` บน root ของ theme (`:scope`) ⇒ แค่ตั้ง `color-scheme`
 * ที่ลูกหลานไม่พอ (ค่าถูกตัดสินที่ root แล้ว) ต้องห่อด้วย `Theme` ซ้อนที่ `mode="dark"`
 * เพื่อให้ root ใหม่ประกาศ token ชุดมืดใหม่ — ใช้ theme ที่ build แล้วตัวเดียวกับทั้งแอป (ไม่ใช่ source)
 */
export function BoardTheme({ children }: { children: ReactNode }) {
  return (
    <Theme theme={badgameTheme} mode="dark">
      {children}
    </Theme>
  );
}
