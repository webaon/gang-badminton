import { describe, expect, it } from 'vitest';

import {
  REST_LONG_MINUTES,
  courtSlots,
  formatRest,
  isLongRest,
  longestRest,
  restBarPercent,
  restMinutes,
} from '@/domain/play/rest-time';

const NOW = '2026-10-28T12:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

describe('restMinutes', () => {
  it('ปัดลงเป็นนาทีเต็ม', () => {
    expect(restMinutes(ago(14), NOW)).toBe(14);
    expect(restMinutes(new Date(Date.parse(NOW) - 14.9 * 60_000).toISOString(), NOW)).toBe(14);
  });

  it('เวลาในอนาคต/เวลาเสีย/ว่าง = 0 ไม่ติดลบ ไม่ NaN', () => {
    expect(restMinutes(ago(-5), NOW)).toBe(0);
    expect(restMinutes('ไม่ใช่เวลา', NOW)).toBe(0);
    expect(restMinutes(null, NOW)).toBe(0);
    expect(restMinutes(undefined, NOW)).toBe(0);
    expect(restMinutes(ago(3), 'พัง')).toBe(0);
  });
});

describe('isLongRest / formatRest / restBarPercent', () => {
  it('พักนานเริ่มที่ 20 นาที (ขอบ: 19 ไม่นาน · 20 นาน)', () => {
    expect(REST_LONG_MINUTES).toBe(20);
    expect(isLongRest(19)).toBe(false);
    expect(isLongRest(20)).toBe(true);
  });

  it('ข้อความไทย: เพิ่งพัก · นาที · ชั่วโมง', () => {
    expect(formatRest(0)).toBe('เพิ่งพัก');
    expect(formatRest(1)).toBe('พักมา 1 นาที');
    expect(formatRest(59)).toBe('พักมา 59 นาที');
    expect(formatRest(60)).toBe('พักมา 1 ชม.');
    expect(formatRest(65)).toBe('พักมา 1 ชม. 5 นาที');
  });

  it('แถบ 0–100 และไม่เกิน 100', () => {
    expect(restBarPercent(0)).toBe(0);
    expect(restBarPercent(15)).toBe(50);
    expect(restBarPercent(30)).toBe(100);
    expect(restBarPercent(500)).toBe(100);
  });
});

describe('longestRest', () => {
  it('เลือกคนที่พักนานสุด ไม่สลับลำดับคิว', () => {
    const rows = [
      { registrationId: 'a', waitingSince: ago(9) },
      { registrationId: 'b', waitingSince: ago(26) },
      { registrationId: 'c', waitingSince: ago(14) },
    ];
    expect(longestRest(rows, NOW)).toEqual({ registrationId: 'b', minutes: 26 });
  });

  it('เสมอกัน = คนแรกตามลำดับที่ server ส่ง', () => {
    const rows = [
      { registrationId: 'x', waitingSince: ago(12) },
      { registrationId: 'y', waitingSince: ago(12) },
    ];
    expect(longestRest(rows, NOW)?.registrationId).toBe('x');
  });

  it('ไม่มีใคร / ทุกคนเพิ่งพัก (0 นาที) = null (ไม่เน้นใครลอยๆ)', () => {
    expect(longestRest([], NOW)).toBeNull();
    expect(longestRest([{ registrationId: 'a', waitingSince: ago(0) }], NOW)).toBeNull();
  });
});

describe('courtSlots', () => {
  it('คอร์ทที่ไม่มีเกม = null (ว่าง) เรียงตามเลขคอร์ท', () => {
    const slots = courtSlots(3, [{ courtNo: 2 }]);
    expect(slots.map((s) => [s.courtNo, s.game !== null])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('เกมที่เลขคอร์ทเกินจำนวนคอร์ทไม่ถูกทิ้ง (ข้อมูลเก่า/แก้จำนวนคอร์ททีหลัง)', () => {
    const slots = courtSlots(2, [{ courtNo: 5 }]);
    expect(slots.map((s) => s.courtNo)).toEqual([1, 2, 5]);
    expect(slots[2].game).not.toBeNull();
  });

  it('courtCount ติดลบ/0 ไม่พัง', () => {
    expect(courtSlots(0, [])).toEqual([]);
    expect(courtSlots(-3, [])).toEqual([]);
  });
});
