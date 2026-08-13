/**
 * WO-2.5-E — recurrence ของนัดประจำ
 *
 * pure unit test — ไม่แตะ DB และไม่มี `Date` ที่ผูกโซนเวลาโผล่ออกมา
 */
import { describe, it, expect } from 'vitest';
import {
  fromJson,
  occurrencesBetween,
  toJson,
  validate,
  type Recurrence,
} from '@/domain/sessions/recurrence';

function recurrence(overrides: Partial<Recurrence> = {}): Recurrence {
  return { days: [1, 4], startTime: '19:00', endTime: '21:00', ...overrides };
}

describe('WO-2.5-E — อ่าน/เขียน jsonb', () => {
  it('แปลงไป-กลับได้ค่าเดิม · เรียงวันและตัดซ้ำ', () => {
    expect(toJson(recurrence({ days: [4, 1, 1] }))).toEqual({
      days: [1, 4],
      start_time: '19:00',
      end_time: '21:00',
    });
    expect(fromJson(toJson(recurrence()))).toEqual(recurrence());
  });

  it('jsonb ที่พัง → ค่า fallback ที่ปลอดภัย ไม่โยน error', () => {
    expect(fromJson(null)).toEqual({ days: [], startTime: '19:00', endTime: '21:00' });
    // วันที่อยู่นอกช่วง 0–6 ถูกตัดทิ้ง ไม่ใช่ปัดเข้าช่วง
    expect(fromJson({ days: [1, 9, -2, 6] }).days).toEqual([1, 6]);
  });
});

describe('WO-2.5-E — validate', () => {
  it('ตารางปกติผ่าน', () => {
    expect(validate(recurrence())).toEqual([]);
  });

  it('🔴 ไม่เลือกวันเลย / เวลาไม่ถูกรูปแบบ / เริ่มเท่ากับจบ → ไม่ผ่าน', () => {
    expect(validate(recurrence({ days: [] }))).toHaveLength(1);
    expect(validate(recurrence({ startTime: '7 โมง' }))).toHaveLength(1);
    expect(validate(recurrence({ startTime: '25:00' }))).toHaveLength(1);
    expect(validate(recurrence({ endTime: '19:00' }))).toHaveLength(1);
  });
});

describe('WO-2.5-E — รอบที่ควรมีในช่วง 2 สัปดาห์', () => {
  it('จันทร์กับพฤหัส 14 วัน → 4 รอบ ตรงวันจริง', () => {
    // 2026-08-13 คือวันพฤหัสบดี
    const occurrences = occurrencesBetween(recurrence(), '2026-08-13', 14);

    expect(occurrences.map((o) => o.startLocal)).toEqual([
      '2026-08-13T19:00',
      '2026-08-17T19:00',
      '2026-08-20T19:00',
      '2026-08-24T19:00',
    ]);
    expect(occurrences[0].endLocal).toBe('2026-08-13T21:00');
  });

  it('วันอาทิตย์ = 0 (เลขวันแบบ JavaScript ไม่ใช่ ISO)', () => {
    const occurrences = occurrencesBetween(recurrence({ days: [0] }), '2026-08-13', 7);
    // อาทิตย์ถัดจาก 13 ส.ค. 2026 (พฤหัส) คือ 16 ส.ค.
    expect(occurrences.map((o) => o.startLocal)).toEqual(['2026-08-16T19:00']);
  });

  it('🔴 จบข้ามเที่ยงคืน → วันจบเลื่อนไปวันถัดไป (ไม่งั้น ends_at > starts_at พังที่ DB)', () => {
    const occurrences = occurrencesBetween(
      recurrence({ days: [4], startTime: '22:00', endTime: '00:30' }),
      '2026-08-13',
      7,
    );

    expect(occurrences[0]).toEqual({
      startLocal: '2026-08-13T22:00',
      endLocal: '2026-08-14T00:30',
    });
  });

  it('ข้ามเดือน/ข้ามปีได้ถูกต้อง', () => {
    const occurrences = occurrencesBetween(recurrence({ days: [4] }), '2026-12-28', 14);
    expect(occurrences.map((o) => o.startLocal.slice(0, 10))).toEqual(['2026-12-31', '2027-01-07']);
  });

  it('รวมวันแรกด้วยถ้าตรงวัน', () => {
    const occurrences = occurrencesBetween(recurrence({ days: [4] }), '2026-08-13', 1);
    expect(occurrences).toHaveLength(1);
  });

  it('🔴 recurrence ที่ใช้ไม่ได้ → throw ไม่ใช่คืน array ว่าง', () => {
    expect(() => occurrencesBetween(recurrence({ days: [] }), '2026-08-13', 14)).toThrow(
      /recurrence/,
    );
    expect(() => occurrencesBetween(recurrence(), '13/08/2026', 14)).toThrow(/YYYY-MM-DD/);
    expect(() => occurrencesBetween(recurrence(), '2026-08-13', 0)).toThrow(/จำนวนเต็มบวก/);
  });
});
