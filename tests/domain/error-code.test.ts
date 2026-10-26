/**
 * `toErrorCode` / `runAction` ต้องหยิบ `.code` ของ AppError เสมอ แม้ message ไม่ใช่ตัว code
 *
 * [WO-6.1b] บั๊กที่พบตอนแทนข้อความ error: `new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อนัด')` เคยตกเป็น
 * INTERNAL_ERROR ทุกครั้ง (toErrorCode เทียบแต่ message) — เทสต์เดิมใช้ `new AppError('SESSION_FULL')`
 * ที่ message = code พอดีจึงไม่เคยจับได้
 */
import { describe, expect, it, vi } from 'vitest';

import { AppError, runAction } from '@/shared/action';
import { toErrorCode } from '@/shared/errors';

describe('toErrorCode — AppError ที่มี message เฉพาะเรื่อง', () => {
  it('หยิบ code จาก AppError แม้ message เป็นข้อความไทย', () => {
    const err = new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อนัด');
    expect(toErrorCode(err)).toMatchObject({ code: 'VALIDATION_ERROR', message: 'ต้องระบุชื่อนัด' });
  });

  it('ทุก code ของ AppError ถูกคงไว้ (ไม่ตกเป็น INTERNAL_ERROR)', () => {
    for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFIRMATION_REQUIRED'] as const) {
      expect(toErrorCode(new AppError(code, 'ข้อความอะไรก็ได้')).code).toBe(code);
    }
  });

  it('error ทั่วไปที่ไม่มี code ของเรา ยังเป็น INTERNAL_ERROR · Postgres 42501 ยังเป็น FORBIDDEN', () => {
    expect(toErrorCode(new Error('boom')).code).toBe('INTERNAL_ERROR');
    expect(toErrorCode({ code: '23505', message: 'duplicate key' }).code).toBe('INTERNAL_ERROR');
    expect(toErrorCode({ code: '42501', message: 'denied' }).code).toBe('FORBIDDEN');
  });

  it('PostgREST error ที่ message คือ code (DB function raise) ยังใช้ได้', () => {
    expect(toErrorCode({ code: 'P0001', message: 'SESSION_NOT_OPEN' }).code).toBe('SESSION_NOT_OPEN');
  });
});

describe('runAction — AppError พร้อม message เฉพาะเรื่อง', () => {
  it('คืน code ที่โยน + message เดิม (ไม่ log เป็น unhandled)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await runAction('cid-x', async () => {
      throw new AppError('VALIDATION_ERROR', 'เวลาจบต้องหลังเวลาเริ่ม');
    });

    expect(res).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'เวลาจบต้องหลังเวลาเริ่ม' },
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
