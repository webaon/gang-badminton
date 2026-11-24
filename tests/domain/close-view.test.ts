import { describe, expect, it } from 'vitest';

import { baht, groupAmount, hasShuttleSplit, isZeroAmount, reasonView } from '@/domain/sessions/close-view';

describe('groupAmount / baht', () => {
  it('คั่นหลักพันด้วยการแก้ string และคงทศนิยมเดิม', () => {
    expect(groupAmount('0.00')).toBe('0.00');
    expect(groupAmount('127.00')).toBe('127.00');
    expect(groupAmount('1700.50')).toBe('1,700.50');
    expect(groupAmount('1234567.00')).toBe('1,234,567.00');
    expect(groupAmount('150')).toBe('150');
  });

  it('ติดลบ (ก๊วนรับส่วนต่างเอง) คงเครื่องหมาย', () => {
    expect(groupAmount('-5.00')).toBe('-5.00');
    expect(baht('-1200.00')).toBe('-฿1,200.00');
  });

  it('ค่าที่ไม่ใช่ตัวเลขคืนตามเดิม ไม่ขึ้น NaN', () => {
    expect(groupAmount('abc')).toBe('abc');
    expect(groupAmount('')).toBe('');
    expect(baht('abc')).toBe('฿abc');
  });

  it('baht ใส่สัญลักษณ์หน้าตัวเลข', () => {
    expect(baht('1700.00')).toBe('฿1,700.00');
  });
});

describe('reasonView', () => {
  it('ทุกเหตุผลที่ server ส่งได้ มีข้อความไทย (ไม่โชว์รหัสดิบ)', () => {
    for (const r of [
      'attended',
      'no_check_in',
      'no_show',
      'late_cancel',
      'cancelled_in_time',
      'waitlist',
      'monthly_member',
      'not_charged',
    ]) {
      const v = reasonView(r);
      expect(v.label).toMatch(/[\u0E00-\u0E7F]/);
      expect(v.label).not.toContain('_');
    }
  });

  it('เหตุผลที่ไม่รู้จักได้ข้อความกลาง ไม่ใช่รหัสดิบ', () => {
    expect(reasonView('something_new')).toEqual({ label: 'ตามเงื่อนไขของก๊วน', tone: 'neutral' });
  });

  it('ไม่มา = error · ยกเลิกช้า = warning · มาเล่น = success', () => {
    expect(reasonView('no_show').tone).toBe('error');
    expect(reasonView('late_cancel').tone).toBe('warning');
    expect(reasonView('attended').tone).toBe('success');
  });
});

describe('hasShuttleSplit', () => {
  it('เฉพาะ court_plus_shuttle', () => {
    expect(hasShuttleSplit('court_plus_shuttle')).toBe(true);
    expect(hasShuttleSplit('flat_per_head')).toBe(false);
  });
});

describe('isZeroAmount', () => {
  it('ศูนย์ทุกรูปแบบ string', () => {
    for (const z of ['0', '0.00', '-0.00', '000.0']) expect(isZeroAmount(z), z).toBe(true);
  });
  it('ไม่ใช่ศูนย์', () => {
    for (const n of ['0.01', '150.00', '-5.00', '10']) expect(isZeroAmount(n), n).toBe(false);
  });
});
