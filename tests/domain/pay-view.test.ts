import { describe, expect, it } from 'vitest';

import {
  SLIP_PICKER_ACCEPT,
  SLIP_MAX_BYTES,
  SLIP_PROBLEM_TEXT,
  checkSlipFile,
  formatFileSize,
  payStepsOf,
} from '@/domain/payments/pay-view';

describe('checkSlipFile (ตรงกับ bucket payment-slips: 5MB · jpeg/png/webp/pdf)', () => {
  it('ไฟล์ปกติผ่าน', () => {
    expect(checkSlipFile({ size: 2_400_000, type: 'image/jpeg' })).toBeNull();
    expect(checkSlipFile({ size: 10, type: 'application/pdf' })).toBeNull();
    expect(checkSlipFile({ size: 1000, type: 'image/webp' })).toBeNull();
  });

  it('เท่ากับ 5MB พอดีผ่าน · เกินแม้ 1 byte ไม่ผ่าน', () => {
    expect(checkSlipFile({ size: SLIP_MAX_BYTES, type: 'image/png' })).toBeNull();
    expect(checkSlipFile({ size: SLIP_MAX_BYTES + 1, type: 'image/png' })).toBe('too_large');
  });

  it('HEIC / GIF / ชนิดว่าง ไม่ผ่าน', () => {
    expect(checkSlipFile({ size: 1000, type: 'image/heic' })).toBe('bad_type');
    expect(checkSlipFile({ size: 1000, type: 'image/gif' })).toBe('bad_type');
    expect(checkSlipFile({ size: 1000, type: '' })).toBe('bad_type');
  });

  it('ไฟล์ว่างไม่ผ่าน', () => {
    expect(checkSlipFile({ size: 0, type: 'image/png' })).toBe('empty');
  });

  it('ข้อความทุกกรณีเป็นไทยและพูดตัวเลขตรงกับ bucket (5MB)', () => {
    for (const text of Object.values(SLIP_PROBLEM_TEXT)) expect(text).toMatch(/[\u0E00-\u0E7F]/);
    expect(SLIP_PROBLEM_TEXT.too_large).toContain('5MB');
    expect(SLIP_PICKER_ACCEPT).toBe('image/*,application/pdf');
  });
});

describe('formatFileSize', () => {
  it('MB 1 ตำแหน่ง · KB ขั้นต่ำ 1', () => {
    expect(formatFileSize(2_516_582)).toBe('2.4 MB');
    expect(formatFileSize(340 * 1024)).toBe('340 KB');
    expect(formatFileSize(10)).toBe('1 KB');
  });
});

describe('payStepsOf', () => {
  const states = (s: string) => payStepsOf(s).map((x) => x.state);

  it('pending / rejected = ขั้น 1 กำลังทำ', () => {
    expect(states('pending')).toEqual(['current', 'todo', 'todo']);
    expect(states('rejected')).toEqual(['current', 'todo', 'todo']);
  });

  it('submitted = รอแอดมิน', () => {
    expect(states('submitted')).toEqual(['done', 'current', 'todo']);
  });

  it('verified = เสร็จทั้งสามขั้น (ไม่มี current)', () => {
    expect(states('verified')).toEqual(['done', 'done', 'done']);
  });

  it('สถานะที่ไม่รู้จักไม่โชว์ว่ายืนยันแล้ว', () => {
    expect(states('weird')).toEqual(['current', 'todo', 'todo']);
  });
});
