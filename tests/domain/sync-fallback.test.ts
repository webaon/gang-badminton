/**
 * WO-2.5 DoD — "ตัด realtime ออกแล้วหน้าจอยัง sync ได้ด้วย polling
 * (พิสูจน์ว่า fallback ทำงานจริง ไม่ใช่เขียนไว้เฉยๆ)"
 */
import { describe, it, expect } from 'vitest';
import {
  POLL_INTERVAL_MS,
  REALTIME_GRACE_MS,
  pollIntervalFor,
  syncMode,
} from '@/lib/sync/fallback';

describe('syncMode — เลือก realtime หรือ polling', () => {
  it('ต่อ realtime ติดแล้ว → ใช้ realtime ไม่ poll ซ้ำซ้อน', () => {
    expect(syncMode('subscribed', 0)).toBe('realtime');
    expect(syncMode('subscribed', 999_999)).toBe('realtime');
    expect(pollIntervalFor('realtime')).toBeNull();
  });

  it('🔴 realtime ถูกปิดใน environment → polling ทันที ไม่ต้องรอ', () => {
    expect(syncMode('disabled', 0)).toBe('polling');
  });

  it('🔴 ต่อไม่ได้ / หลุดกลางคัน → polling ทันที', () => {
    expect(syncMode('error', 0)).toBe('polling');
    expect(syncMode('closed', 0)).toBe('polling');
  });

  it('ยังต่ออยู่ในช่วงผ่อนผัน → ยังไม่ poll (กันยิง request ถี่โดยไม่จำเป็น)', () => {
    expect(syncMode('connecting', 0)).toBe('realtime');
    expect(syncMode('connecting', REALTIME_GRACE_MS - 1)).toBe('realtime');
  });

  it('🔴 ต่อไม่ติดจนหมดเวลาผ่อนผัน → ตกไป polling เอง', () => {
    expect(syncMode('connecting', REALTIME_GRACE_MS)).toBe('polling');
    expect(syncMode('connecting', REALTIME_GRACE_MS * 10)).toBe('polling');
  });

  it('polling ใช้รอบ 10 วินาทีตามที่ baseline ระบุ', () => {
    expect(POLL_INTERVAL_MS).toBe(10_000);
    expect(pollIntervalFor('polling')).toBe(10_000);
  });
});
