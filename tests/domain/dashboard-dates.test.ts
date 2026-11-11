/**
 * WO-6.5c — tests/domain เพราะเป็น pure function ล้วน (ไม่แตะ DB/Next 'use server')
 * ของ server/sessions/dashboard-dates.ts ที่ server/actions/dashboard.ts (H10 loader) ใช้
 */
import { describe, it, expect } from 'vitest';
import { thaiMonthOf, monthDateRange, last6Months } from '@/server/sessions/dashboard-dates';

describe('WO-6.5c — dashboard-dates.ts (ปฏิทิน ไม่ใช่สูตรการเงิน)', () => {
  it('thaiMonthOf แยกปี/เดือนจาก YYYY-MM-DD', () => {
    expect(thaiMonthOf('2026-03-15')).toEqual({ year: 2026, month: 3 });
    expect(thaiMonthOf('2026-12-01')).toEqual({ year: 2026, month: 12 });
  });

  it('monthDateRange คืนวันแรก/วันสุดท้ายของเดือนถูกต้อง รวมปีอธิกสุรทิน', () => {
    expect(monthDateRange(2026, 3)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(monthDateRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' }); // 2026 ไม่อธิกสุรทิน
    expect(monthDateRange(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' }); // 2024 อธิกสุรทิน
    expect(monthDateRange(2026, 4)).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('last6Months เรียงเก่า→ใหม่ รวมเดือนปัจจุบันเป็นตัวสุดท้าย', () => {
    expect(last6Months('2026-03-15')).toEqual([
      { year: 2025, month: 10 }, { year: 2025, month: 11 }, { year: 2025, month: 12 },
      { year: 2026, month: 1 }, { year: 2026, month: 2 }, { year: 2026, month: 3 },
    ]);
  });

  it('last6Months ข้ามปีถูกต้องตอนเดือนปัจจุบันเป็น ม.ค.', () => {
    expect(last6Months('2026-01-10')).toEqual([
      { year: 2025, month: 8 }, { year: 2025, month: 9 }, { year: 2025, month: 10 },
      { year: 2025, month: 11 }, { year: 2025, month: 12 }, { year: 2026, month: 1 },
    ]);
  });

  it('🔴 ผลลัพธ์ last6Months แต่ละตัวต้องผ่าน monthDateRange ได้จริง (ไม่มีเดือน/ปีเพี้ยน)', () => {
    for (const { year, month } of last6Months('2027-06-01')) {
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      const range = monthDateRange(year, month);
      expect(range.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(range.to >= range.from).toBe(true);
    }
  });
});
