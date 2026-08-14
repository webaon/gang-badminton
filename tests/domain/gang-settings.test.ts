/**
 * WO-2.5-G — `gangs.settings` (เวลาเตือน)
 *
 * อ่านผ่อนปรน / เขียนเข้ม — แนวเดียวกับ cancellation policy และ recurrence
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REMINDER_SETTINGS,
  reminderFromJson,
  reminderToJson,
  shouldRemindPayment,
  shouldRemindSession,
  validateReminder,
} from '@/domain/gangs/settings';

describe('WO-2.5-G — อ่าน/เขียน settings', () => {
  it('แปลงไป-กลับได้ค่าเดิม', () => {
    const settings = { sessionHoursBefore: 6, paymentDueAfterHours: 48 };
    expect(reminderFromJson(reminderToJson(settings))).toEqual(settings);
  });

  it('ก๊วนเก่าที่ไม่มีคีย์นี้ → ค่า default (ไม่พัง)', () => {
    expect(reminderFromJson({})).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(reminderFromJson(null)).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(reminderFromJson({ reminder: 'พัง' })).toEqual(DEFAULT_REMINDER_SETTINGS);
  });

  it('🔴 ค่าที่พังใน jsonb → ตกไปใช้ default ไม่ใช่ทำให้ cron พัง', () => {
    const broken = reminderFromJson({
      reminder: { session_hours_before: -5, payment_due_after_hours: 99999 },
    });
    expect(broken).toEqual(DEFAULT_REMINDER_SETTINGS);
  });

  it('validate — ตัวเลขนอกช่วงไม่ผ่าน · 0 ผ่าน (แปลว่าปิด)', () => {
    expect(validateReminder({ sessionHoursBefore: 0, paymentDueAfterHours: 0 })).toEqual([]);
    expect(validateReminder({ sessionHoursBefore: -1, paymentDueAfterHours: 24 })).toHaveLength(1);
    expect(validateReminder({ sessionHoursBefore: 1.5, paymentDueAfterHours: 24 })).toHaveLength(1);
  });
});

describe('WO-2.5-G — หน้าต่างเวลาเตือน', () => {
  const now = new Date('2026-08-13T03:00:00Z');

  it('เตือนเมื่อเหลือเวลาน้อยกว่าที่ตั้งไว้', () => {
    const in12h = new Date(now.getTime() + 12 * 60 * 60 * 1000);
    expect(shouldRemindSession(in12h, now, 24)).toBe(true);
  });

  it('🔴 ยังไม่ถึงหน้าต่าง → ไม่เตือน · เริ่มไปแล้ว → ไม่เตือน', () => {
    const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const passed = new Date(now.getTime() - 60 * 1000);

    expect(shouldRemindSession(in48h, now, 24)).toBe(false);
    expect(shouldRemindSession(passed, now, 24)).toBe(false);
  });

  it('ตั้ง 0 = ปิดการเตือน', () => {
    const in1h = new Date(now.getTime() + 60 * 60 * 1000);
    expect(shouldRemindSession(in1h, now, 0)).toBe(false);
    expect(shouldRemindPayment(new Date(now.getTime() - 99 * 3600_000), now, 0)).toBe(false);
  });

  it('เตือนยอดค้างเมื่อพ้นเวลาที่ตั้งไว้หลังนัดจบ', () => {
    const ended25hAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const ended1hAgo = new Date(now.getTime() - 60 * 60 * 1000);

    expect(shouldRemindPayment(ended25hAgo, now, 24)).toBe(true);
    expect(shouldRemindPayment(ended1hAgo, now, 24)).toBe(false);
  });
});
