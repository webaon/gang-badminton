import { describe, expect, it } from 'vitest';

import { cancelNotice, type CancelPreview } from '@/domain/sessions/cancel-notice';

const fmt = (iso: string) => `T(${iso})`;
const preview = (p: Partial<CancelPreview>): CancelPreview => ({
  outcome: 'free_before_cutoff',
  freeUntil: '2026-08-01T06:00:00Z',
  penaltyType: null,
  reason: 'before_cutoff',
  ...p,
});

describe('cancelNotice — แปลผล preview ของ server เป็นข้อความ ไม่คำนวณเอง', () => {
  it('ไม่มี preview (เรียกไม่สำเร็จ) → ข้อความกลางที่ไม่อ้างเวลา/จำนวนเงิน', () => {
    const n = cancelNotice(null, fmt);
    expect(n.tone).toBe('neutral');
    expect(n.description).not.toMatch(/T\(|฿|\d{1,2}:\d{2}/);
  });

  it('free_in_grace → บอกเวลาที่ฟรีถึง (เวลาจาก server ผ่าน formatter)', () => {
    const n = cancelNotice(
      preview({ outcome: 'free_in_grace', reason: 'promoted_grace', freeUntil: '2026-08-01T10:00:00Z' }),
      fmt,
    );
    expect(n.tone).toBe('success');
    expect(n.description).toContain('ไม่เสียค่าปรับถึง T(2026-08-01T10:00:00Z)');
  });

  it('free_before_cutoff → ฟรีถึงเวลา และบอกว่าหลังจากนั้นอาจมีค่าปรับ (ไม่ระบุประเภท/จำนวน)', () => {
    const n = cancelNotice(preview({}), fmt);
    expect(n.tone).toBe('success');
    expect(n.description).toContain('ยกเลิกฟรีถึง T(2026-08-01T06:00:00Z)');
    expect(n.description).toContain('อาจมีค่าปรับ');
  });

  it('อยู่ในคิวรอ (reason=waitlist) → ออกจากคิวได้ ไม่เสียค่าปรับ ไม่อ้างเวลา', () => {
    const n = cancelNotice(preview({ reason: 'waitlist', freeUntil: null }), fmt);
    expect(n.tone).toBe('success');
    expect(n.title).toContain('คิวรอ');
    expect(n.description).not.toMatch(/T\(/);
  });

  it('penalty → เตือน (warning) ตามประเภทที่ server ส่ง · ประเภทที่ไม่รู้จัก/ว่าง → ตามกติกาของก๊วน · ไม่มีจำนวนเงิน', () => {
    const byType = (t: string | null) =>
      cancelNotice(preview({ outcome: 'penalty', reason: 'late_cancel', freeUntil: null, penaltyType: t }), fmt);

    expect(byType('full_share').description).toContain('ส่วนแบ่ง');
    expect(byType('fixed').description).toContain('จำนวนที่ก๊วนกำหนด');
    expect(byType('percent').description).toContain('เปอร์เซ็นต์');
    expect(byType('something_new').description).toContain('ตามกติกาของก๊วน');
    expect(byType(null).description).toContain('ตามกติกาของก๊วน');
    for (const t of ['full_share', 'fixed', 'percent', null]) {
      const n = byType(t);
      expect(n.tone).toBe('warning');
      expect(n.title).toContain('จะมีค่าปรับ');
      expect(n.description).not.toMatch(/฿|\d+\s*บาท/);
    }
  });

  it('penalty ที่ประเภท none → ไม่ขึ้นว่า "จะมีค่าปรับ" (ไม่ขัดกันเอง)', () => {
    const n = cancelNotice(
      preview({ outcome: 'penalty', reason: 'late_cancel', freeUntil: null, penaltyType: 'none' }),
      fmt,
    );
    expect(n.tone).toBe('success');
    expect(n.title).not.toContain('จะมีค่าปรับ');
    expect(n.description).toContain('ไม่คิดค่าปรับ');
  });

  it('blocked → error บอกให้ติดต่อแอดมิน', () => {
    const n = cancelNotice(preview({ outcome: 'blocked', reason: 'cutoff_passed', freeUntil: null }), fmt);
    expect(n.tone).toBe('error');
    expect(n.description).toContain('แอดมิน');
  });

  it('free_* ที่ server ไม่ส่งเวลา → ข้อความที่ไม่อ้างเวลา (ไม่โชว์ null/undefined)', () => {
    for (const outcome of ['free_in_grace', 'free_before_cutoff'] as const) {
      const n = cancelNotice(preview({ outcome, freeUntil: null }), fmt);
      expect(n.description).not.toMatch(/null|undefined|T\(/);
    }
  });
});
