/**
 * WO-6.5c — H10 dashboard: ตัวช่วยคำนวณช่วงวัน/เดือนแบบปฏิทิน (ไม่ใช่สูตรการเงิน)
 *
 * แยกออกจาก `server/actions/dashboard.ts` เพราะไฟล์นั้นมี `'use server'` ซึ่ง Next.js บังคับว่า
 * export ได้แต่ async function เท่านั้น — ฟังก์ชันพวกนี้เป็น pure sync function ธรรมดา
 * export ตรงจากไฟล์ 'use server' ไม่ได้ (build error "A 'use server' file can only export
 * async functions") ต้องแยกไฟล์แบบนี้ถึงจะเทสต์ได้ตรงๆโดยไม่ผ่าน runAction()/DB
 */
import { utcToZonedWallClock } from '@/domain/time/timezone';

export const DASHBOARD_TIME_ZONE = 'Asia/Bangkok';

export function thaiToday(): string {
  return utcToZonedWallClock(new Date(), DASHBOARD_TIME_ZONE).slice(0, 10);
}

export function thaiMonthOf(dateStr: string): { year: number; month: number } {
  return { year: Number(dateStr.slice(0, 4)), month: Number(dateStr.slice(5, 7)) };
}

/** ช่วงวันของเดือนปฏิทิน (ไม่ใช่การแปลง timezone — แค่เลขวัน) */
export function monthDateRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** 6 เดือนล่าสุดรวมเดือนนี้ เรียงเก่า→ใหม่ */
export function last6Months(todayStr: string): { year: number; month: number }[] {
  const { year, month } = thaiMonthOf(todayStr);
  const months: { year: number; month: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return months;
}
