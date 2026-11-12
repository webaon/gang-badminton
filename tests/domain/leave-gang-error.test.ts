/**
 * [WO-B2.2] mapLeaveGangError() — pure function, unit tests ครบทุกแถวในตารางที่ reviewer อนุมัติ
 *
 * ไม่มี DB/network เลย — ทดสอบด้วย fixture ที่หน้าตาเหมือน PostgrestError จริง
 * (message = SQL RAISE's MESSAGE, details = SQL RAISE's DETAIL ซึ่งเป็น JSON-encoded string)
 */
import { describe, it, expect } from 'vitest';
import { mapLeaveGangError, type LeaveGangFailureReason } from '@/domain/gangs/leave-gang-error';

describe('mapLeaveGangError() — ทุกแถวของตาราง WO-B2.2', () => {
  it('🔴 #1 leave_gang:142 VALIDATION_ERROR (ไม่มี field=role) → MISSING_REQUIRED_FIELDS', () => {
    const result = mapLeaveGangError({
      message: 'VALIDATION_ERROR',
      details: JSON.stringify({ reason: 'ต้องระบุก๊วนและผู้ใช้' }),
    });
    expect(result).toEqual({ reason: 'MISSING_REQUIRED_FIELDS' });
  });

  it('🔴 #2 leave_gang:148 NOT_FOUND entity=gang → GANG_NOT_FOUND', () => {
    const result = mapLeaveGangError({
      message: 'NOT_FOUND',
      details: JSON.stringify({ entity: 'gang', id: 'some-uuid' }),
    });
    expect(result).toEqual({ reason: 'GANG_NOT_FOUND' });
  });

  it('🔴 #3 leave_gang:169 NOT_GANG_MEMBER → NOT_A_MEMBER (detail ไม่มีผลต่อการตัดสิน)', () => {
    const result = mapLeaveGangError({
      message: 'NOT_GANG_MEMBER',
      details: JSON.stringify({ gang_id: 'some-uuid' }),
    });
    expect(result).toEqual({ reason: 'NOT_A_MEMBER' });
  });

  it('🔴 #4 leave_gang:184 VALIDATION_ERROR field=role → OWNER_MUST_TRANSFER', () => {
    const result = mapLeaveGangError({
      message: 'VALIDATION_ERROR',
      details: JSON.stringify({ field: 'role', reason: 'เจ้าของก๊วนคนสุดท้ายออกไม่ได้ — ต้องโอนความเป็นเจ้าของก่อน' }),
    });
    expect(result).toEqual({ reason: 'OWNER_MUST_TRANSFER' });
  });

  it('🔴 #5/#7 cancel_registration:277/303 REGISTRATION_NOT_FOUND (race) → RETRY', () => {
    const result = mapLeaveGangError({
      message: 'REGISTRATION_NOT_FOUND',
      details: JSON.stringify({ registration_id: 'some-uuid' }),
    });
    expect(result).toEqual({ reason: 'RETRY' });
  });

  it('🔴 #6 cancel_registration:290 NOT_FOUND entity=session (race) → RETRY (ไม่ใช่ GANG_NOT_FOUND)', () => {
    const result = mapLeaveGangError({
      message: 'NOT_FOUND',
      details: JSON.stringify({ entity: 'session' }),
    });
    expect(result).toEqual({ reason: 'RETRY' });
  });

  it('🔴 #8 cancel_registration:313 INVALID_REGISTRATION_TRANSITION (race) → RETRY', () => {
    const result = mapLeaveGangError({
      message: 'INVALID_REGISTRATION_TRANSITION',
      details: JSON.stringify({ registration_id: 'x', from_status: 'confirmed', to_status: 'cancelled' }),
    });
    expect(result).toEqual({ reason: 'RETRY' });
  });

  it('🔴 #9 cancel_registration:358 CANCEL_CUTOFF_PASSED → HAS_LATE_CANCEL_REGISTRATION + reasonMeta {startsAt, cutoffAt} เท่านั้น', () => {
    const result = mapLeaveGangError({
      message: 'CANCEL_CUTOFF_PASSED',
      details: JSON.stringify({
        registration_id: 'super-secret-registration-id', // ต้องไม่หลุดออกไปใน reasonMeta
        cutoff_at: '2026-11-01T10:00:00+07:00',
        starts_at: '2026-11-01T18:00:00+07:00',
      }),
    });
    expect(result).toEqual({
      reason: 'HAS_LATE_CANCEL_REGISTRATION',
      reasonMeta: { startsAt: '2026-11-01T18:00:00+07:00', cutoffAt: '2026-11-01T10:00:00+07:00' },
    });
    // whitelist จริง — ไม่ใช่แค่ shape ตรง แต่ registration_id ต้องไม่โผล่ในค่าที่ได้เลย
    expect(JSON.stringify(result)).not.toContain('super-secret-registration-id');
  });

  it('🔴 #9 แปรผัน: CANCEL_CUTOFF_PASSED ที่ detail พังพาร์สไม่ได้ (ไม่ควรเกิดกับ migration ปัจจุบัน) → ยังได้ reason แต่ไม่มี reasonMeta', () => {
    const result = mapLeaveGangError({ message: 'CANCEL_CUTOFF_PASSED', details: 'not json at all' });
    expect(result).toEqual({ reason: 'HAS_LATE_CANCEL_REGISTRATION' });
    expect(result.reasonMeta).toBeUndefined();
  });

  it('🔴 #9 แปรผัน: CANCEL_CUTOFF_PASSED ที่มี detail แต่ cutoff_at/starts_at ไม่ใช่ string ที่ใช้ได้ → ไม่มี reasonMeta', () => {
    const result = mapLeaveGangError({
      message: 'CANCEL_CUTOFF_PASSED',
      details: JSON.stringify({ cutoff_at: '', starts_at: null }),
    });
    expect(result).toEqual({ reason: 'HAS_LATE_CANCEL_REGISTRATION' });
  });

  it('🔴 message ที่ไม่รู้จักเลย (ไม่อยู่ในตาราง) → {} ไม่มี reason — caller fallback เป็น code เดิม', () => {
    expect(mapLeaveGangError({ message: 'SOME_FUTURE_ERROR_NOBODY_HAS_SEEN_YET' })).toEqual({});
    expect(mapLeaveGangError({ message: 'FORBIDDEN' })).toEqual({});
  });

  it('🔴 VALIDATION_ERROR ที่ details หายไปเลย (undefined/null) → fallback MISSING_REQUIRED_FIELDS (ไม่ throw)', () => {
    expect(mapLeaveGangError({ message: 'VALIDATION_ERROR' })).toEqual({ reason: 'MISSING_REQUIRED_FIELDS' });
    expect(mapLeaveGangError({ message: 'VALIDATION_ERROR', details: null })).toEqual({
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('🔴 VALIDATION_ERROR ที่ details พังพาร์สไม่ได้ (ไม่ใช่ JSON ที่ถูกต้อง) → fallback MISSING_REQUIRED_FIELDS (ไม่ throw)', () => {
    expect(mapLeaveGangError({ message: 'VALIDATION_ERROR', details: '{not valid json' })).toEqual({
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('🔴 VALIDATION_ERROR ที่ details เป็น JSON array (ไม่ใช่ object) → fallback MISSING_REQUIRED_FIELDS ไม่ crash', () => {
    expect(mapLeaveGangError({ message: 'VALIDATION_ERROR', details: JSON.stringify(['x', 'y']) })).toEqual({
      reason: 'MISSING_REQUIRED_FIELDS',
    });
  });

  it('🔴 NOT_FOUND ที่ details หายไปเลย → fallback RETRY (ไม่ใช่ GANG_NOT_FOUND แบบมั่วๆ)', () => {
    expect(mapLeaveGangError({ message: 'NOT_FOUND' })).toEqual({ reason: 'RETRY' });
  });

  it('exhaustiveness: ทุก reason ที่ map ออกมาต้องอยู่ใน LeaveGangFailureReason union จริง (กัน typo เงียบๆ)', () => {
    const allReasons: LeaveGangFailureReason[] = [
      'OWNER_MUST_TRANSFER',
      'HAS_LATE_CANCEL_REGISTRATION',
      'NOT_A_MEMBER',
      'GANG_NOT_FOUND',
      'RETRY',
      'MISSING_REQUIRED_FIELDS',
    ];
    const produced = new Set<string>();
    for (const [message, details] of [
      ['VALIDATION_ERROR', JSON.stringify({ reason: 'x' })],
      ['NOT_FOUND', JSON.stringify({ entity: 'gang' })],
      ['NOT_GANG_MEMBER', undefined],
      ['VALIDATION_ERROR', JSON.stringify({ field: 'role' })],
      ['REGISTRATION_NOT_FOUND', undefined],
      ['NOT_FOUND', JSON.stringify({ entity: 'session' })],
      ['INVALID_REGISTRATION_TRANSITION', undefined],
      ['CANCEL_CUTOFF_PASSED', JSON.stringify({ cutoff_at: 'a', starts_at: 'b' })],
    ] as const) {
      const { reason } = mapLeaveGangError({ message, details });
      if (reason) produced.add(reason);
    }
    expect(produced.size).toBe(allReasons.length);
    for (const r of produced) expect(allReasons).toContain(r);
  });
});
