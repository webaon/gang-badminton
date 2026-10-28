import { describe, expect, it } from 'vitest';

import { SHUTTLE_STEP_MAX, stepShuttles } from '@/domain/play/shuttle-step';

describe('stepShuttles', () => {
  it('+1 / −1 จากค่าปกติ', () => {
    expect(stepShuttles('2', 1)).toBe('3');
    expect(stepShuttles('2', -1)).toBe('1');
  });

  it('ค่าว่าง/ไม่ใช่ตัวเลข เริ่มจาก 0 · ไม่ติดลบ', () => {
    expect(stepShuttles('', 1)).toBe('1');
    expect(stepShuttles('abc', 1)).toBe('1');
    expect(stepShuttles('0', -1)).toBe('0');
    expect(stepShuttles('-3', 1)).toBe('1');
  });

  it('ทศนิยมคงอยู่ ไม่มี float เพี้ยน และไม่มีศูนย์ท้าย', () => {
    expect(stepShuttles('1.5', 1)).toBe('2.5');
    expect(stepShuttles('0.1', 0.2)).toBe('0.3');
    expect(stepShuttles('1,5', 1)).toBe('2.5');
    expect(stepShuttles('1.5', 0.5)).toBe('2');
  });

  it('ไม่เกินเพดาน', () => {
    expect(stepShuttles(String(SHUTTLE_STEP_MAX), 1)).toBe(String(SHUTTLE_STEP_MAX));
  });
});
