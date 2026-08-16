/**
 * WO-3.F DoD — หน้าแรก
 *
 *   · 🔴 หน้าแรกต้องเป็น **static/ISR** ไม่ใช่ `force-dynamic`
 *     (ผลลัพธ์จริงดูจาก `npm run build`: `○ /` + Revalidate 1h — เทสต์นี้กันไม่ให้
 *      มีใครเผลอเพิ่มสิ่งที่ทำให้ Next สลับหน้าไปเป็น dynamic แบบเงียบๆ)
 *   · 🔴 ตัวเลขบนหน้าแรกอ่านจาก `daily_metrics` เท่านั้น — ไม่มี query ตารางธุรกรรมสด
 *   · ไม่มีข้อมูลของก๊วนใดก๊วนหนึ่งบนหน้าแรก
 *   · อ่านฐานข้อมูลไม่ได้ (เช่นตอน build ที่ไม่มี env) ต้องไม่ทำให้หน้าแรกพัง
 *
 * ⚠️ ไฟล์นี้ **ห้ามตั้ง `process.env.SUPABASE_*`** — เคส fail-soft ด้านล่างพึ่งการที่ env ว่าง
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  summarizePlatformMetrics,
  hasHighlights,
  type DailyMetricRow,
} from '@/domain/reports/platform';
import { highlightRangeStart, platformHighlights } from '@/server/landing/metrics';

const pageSource = readFileSync(
  fileURLToPath(new URL('../../app/page.tsx', import.meta.url)),
  'utf8',
);

/**
 * ตัดคอมเมนต์ออกก่อนตรวจ — คอมเมนต์ของหน้าแรกเขียนถึงชื่อที่ห้ามใช้อยู่แล้ว
 * (เช่น "ห้ามเรียก `supabaseServer()`") ถ้าไม่ตัดจะกลายเป็นเทสต์ที่จับคำอธิบายของตัวเอง
 */
const pageCode = pageSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const row = (
  metricDate: string,
  newMembers: number,
  gamesPlayed: number,
  sessionsHeld: number,
): DailyMetricRow => ({ metricDate, newMembers, gamesPlayed, sessionsHeld });

describe('WO-3.F DoD — หน้าแรกต้องยัง static/ISR', () => {
  it('🔴 ไม่มี force-dynamic และประกาศ revalidate ไว้', () => {
    expect(pageCode).not.toMatch(/force-dynamic/);
    expect(pageCode).toMatch(/export const revalidate\s*=\s*\d+/);
  });

  it('🔴 ไม่แตะ API ที่ทำให้ Next สลับเป็น dynamic (cookies/headers/client ที่ผูก session)', () => {
    expect(pageCode).not.toMatch(/next\/headers/);
    expect(pageCode).not.toMatch(/supabaseServer|requireUser|currentUser/);
  });

  it('🔴 อ่านตัวเลขผ่าน `platformHighlights()` (daily_metrics) ไม่ query ตารางอื่นเอง', () => {
    expect(pageCode).toMatch(/platformHighlights/);
    // ไม่มีการยิงตารางธุรกรรมสดจากหน้าแรก
    expect(pageCode).not.toMatch(/from\(['"](sessions|games|session_charges|payments|gangs)['"]\)/);
  });

  it('ไม่มีข้อมูลของก๊วนใดก๊วนหนึ่งบนหน้าแรก (ไม่มีการอ่าน gangs / join_requests)', () => {
    expect(pageCode).not.toMatch(/search_public_gangs|join_requests|member_statistics/);
  });
});

describe('WO-3.F — สรุปตัวเลขแพลตฟอร์ม (pure)', () => {
  it('ไม่มีข้อมูล → ศูนย์ทุกช่องและไม่มีวันล่าสุด', () => {
    const summary = summarizePlatformMetrics([]);
    expect(summary).toEqual({
      days: 0,
      newMembers: 0,
      gamesPlayed: 0,
      sessionsHeld: 0,
      latestDate: null,
    });
    expect(hasHighlights(summary)).toBe(false);
  });

  it('บวกทุกวันเข้าด้วยกัน และหยิบวันล่าสุดมาแสดง', () => {
    const summary = summarizePlatformMetrics([
      row('2026-08-15', 2, 10, 3),
      row('2026-08-13', 1, 4, 1),
      row('2026-08-14', 0, 6, 2),
    ]);

    expect(summary).toEqual({
      days: 3,
      newMembers: 3,
      gamesPlayed: 20,
      sessionsHeld: 6,
      latestDate: '2026-08-15',
    });
    expect(hasHighlights(summary)).toBe(true);
  });

  it('ค่าเพี้ยน (ติดลบ / ไม่ใช่ตัวเลข) นับเป็น 0 ไม่โผล่เป็นเลขติดลบบนหน้าแรก', () => {
    const summary = summarizePlatformMetrics([
      row('2026-08-15', -5, Number.NaN, 2),
      row('2026-08-16', 1.9, 3, 0),
    ]);

    expect(summary.newMembers).toBe(1); // 1.9 → ตัดเศษ
    expect(summary.gamesPlayed).toBe(3);
    expect(summary.sessionsHeld).toBe(2);
  });

  it('ทุกช่องเป็น 0 = ยังไม่ต้องขึ้นบล็อกตัวเลข', () => {
    expect(hasHighlights(summarizePlatformMetrics([row('2026-08-15', 0, 0, 0)]))).toBe(false);
  });

  it('ช่วงเวลาเริ่มนับย้อนหลังตามจำนวนวันที่ขอ (นาฬิกาไทย)', () => {
    // 2026-08-15 07:00 UTC = 14:00 ไทย ⇒ ย้อน 30 วัน = 2026-07-16
    expect(highlightRangeStart(new Date('2026-08-15T07:00:00Z'), 30)).toBe('2026-07-16');
    expect(highlightRangeStart(new Date('2026-08-15T07:00:00Z'), 1)).toBe('2026-08-14');
  });
});

describe('WO-3.F — อ่านฐานข้อมูลไม่ได้ต้องไม่ทำให้หน้าแรกพัง', () => {
  it('ไม่มี env ของ Supabase → คืน null (ไม่ throw) เพื่อให้ build ผ่าน', async () => {
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    await expect(platformHighlights()).resolves.toBeNull();
  });
});
