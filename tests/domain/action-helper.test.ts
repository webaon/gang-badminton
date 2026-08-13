/**
 * WO-2.1 DoD — helper server action ต้องแปลง `rowCount = 0` เป็น `FORBIDDEN`
 * ไม่ใช่ success (ข้อจำกัดจาก Phase 1 ข้อ 2)
 *
 * นี่คือกับดักที่ทำให้ระบบ "โกหกผู้ใช้" ได้เงียบที่สุด: RLS กรองแถวออกแล้ว
 * mutation สำเร็จโดยไม่มี error ⇒ ถ้าไม่เช็คจำนวนแถวจะตอบว่าบันทึกแล้ว
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AppError,
  runAction,
  assertAffected,
  assertOne,
  assertFound,
  unwrap,
} from '@/shared/action';
import { safeFileName, paymentSlipPath, avatarPath, tenantKeyOf } from '@/lib/storage/paths';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assertAffected — กัน "บันทึกแล้ว" ทั้งที่ไม่มีอะไรเปลี่ยน', () => {
  it('🔴 0 แถว → โยน FORBIDDEN', () => {
    expect(() => assertAffected([])).toThrowError(AppError);
    try {
      assertAffected([]);
    } catch (err) {
      expect((err as AppError).code).toBe('FORBIDDEN');
    }
  });

  it('null / undefined → โยน FORBIDDEN เหมือนกัน (supabase คืน null ได้)', () => {
    for (const value of [null, undefined]) {
      try {
        assertAffected(value);
        expect.unreachable(`ควรโยนเมื่อได้ ${value}`);
      } catch (err) {
        expect((err as AppError).code).toBe('FORBIDDEN');
      }
    }
  });

  it('มีแถว → คืนแถวกลับมาตามเดิม', () => {
    expect(assertAffected([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('เลือก code เองได้เมื่อแยกได้ชัดว่าเป็น "ไม่พบ"', () => {
    try {
      assertAffected([], 'NOT_FOUND');
    } catch (err) {
      expect((err as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('assertOne คืนแถวแรก และโยนเมื่อว่าง', () => {
    expect(assertOne([{ id: 'a' }])).toEqual({ id: 'a' });
    expect(() => assertOne([])).toThrowError(AppError);
  });
});

describe('assertFound', () => {
  it('null → NOT_FOUND', () => {
    try {
      assertFound(null);
    } catch (err) {
      expect((err as AppError).code).toBe('NOT_FOUND');
    }
  });

  it('ค่าที่เป็น falsy แต่มีจริง (0, "") ต้องผ่าน', () => {
    expect(assertFound(0)).toBe(0);
    expect(assertFound('')).toBe('');
    expect(assertFound(false)).toBe(false);
  });
});

describe('unwrap — เช็ค error ก่อนแล้วค่อยเช็คแถว', () => {
  it('error จาก DB function แปลงเป็น ErrorCode ตรงตัว', () => {
    try {
      unwrap({ data: null, error: { message: 'SESSION_NOT_OPEN' } });
    } catch (err) {
      expect((err as AppError).code).toBe('SESSION_NOT_OPEN');
    }
  });

  it('error 42501 (RLS/grant ปฏิเสธ) → FORBIDDEN', () => {
    try {
      unwrap({ data: null, error: { message: 'permission denied', code: '42501' } });
    } catch (err) {
      expect((err as AppError).code).toBe('FORBIDDEN');
    }
  });

  it('error ที่ไม่รู้จัก → INTERNAL_ERROR', () => {
    try {
      unwrap({ data: null, error: { message: 'อะไรสักอย่างที่ไม่เคยเจอ' } });
    } catch (err) {
      expect((err as AppError).code).toBe('INTERNAL_ERROR');
    }
  });

  it('ไม่มี error → คืน data (null กลายเป็น [])', () => {
    expect(unwrap({ data: [{ a: 1 }], error: null })).toEqual([{ a: 1 }]);
    expect(unwrap({ data: null, error: null })).toEqual([]);
  });
});

describe('runAction — ตอบตาม API response contract เสมอ', () => {
  it('สำเร็จ → { success: true, data }', async () => {
    const res = await runAction('cid-1', async () => ({ id: 42 }));
    expect(res).toEqual({ success: true, data: { id: 42 } });
  });

  it('AppError → { success: false, error.code } ตรงตามที่โยน', async () => {
    const res = await runAction('cid-2', async () => {
      throw new AppError('SESSION_FULL');
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('SESSION_FULL');
  });

  it('🔴 error ที่ไม่รู้จัก → INTERNAL_ERROR และต้อง log ต้นฉบับ ห้าม swallow', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('ระเบิดที่ไม่ได้คาดไว้');

    const res = await runAction('cid-3', async () => {
      throw boom;
    });

    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('INTERNAL_ERROR');

    expect(spy).toHaveBeenCalledOnce();
    const logged = spy.mock.calls[0][1] as { correlationId: string; cause: unknown };
    expect(logged.correlationId).toBe('cid-3');
    expect(logged.cause).toBe(boom);
  });
});

describe('storage paths [D-15] — สิทธิ์ขึ้นกับ path จึงต้องประกอบที่เดียว', () => {
  const gang = '00000000-0000-7000-8000-00000000b001';
  const payment = '00000000-0000-7000-8000-00000000e001';

  it('ประกอบ path ตามรูปแบบที่ policy คาดหวัง', () => {
    expect(paymentSlipPath(gang, payment, 'slip.jpg')).toBe(`${gang}/${payment}/slip.jpg`);
    expect(tenantKeyOf(paymentSlipPath(gang, payment, 'slip.jpg'))).toBe(gang);
  });

  it('🔴 path traversal ถูกตัดทิ้ง — ../ ห้ามเล็ดลอด', () => {
    const evil = paymentSlipPath(gang, payment, '../../other-gang/slip.jpg');
    expect(evil).not.toContain('..');
    expect(evil.split('/')).toHaveLength(3);
    expect(tenantKeyOf(evil)).toBe(gang);
  });

  it('ชื่อไฟล์ถูก sanitize', () => {
    expect(safeFileName('สลิป โอนเงิน.JPG')).toMatch(/^[a-z0-9._-]+$/);
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('a'.repeat(500)).length).toBeLessThanOrEqual(100);
  });

  it('🔴 id ที่ไม่ใช่ UUID ถูกปฏิเสธทันที (กันเอา input ดิบจาก client มาต่อ path)', () => {
    expect(() => paymentSlipPath('not-a-uuid', payment, 'x.jpg')).toThrow(/UUID/);
    expect(() => paymentSlipPath(gang, '../evil', 'x.jpg')).toThrow(/UUID/);
    expect(() => avatarPath('; drop table users', 'x.jpg')).toThrow(/UUID/);
  });

  it('tenantKeyOf คืน null ถ้า path ไม่ได้ขึ้นต้นด้วย UUID', () => {
    expect(tenantKeyOf('public/x.jpg')).toBeNull();
  });
});
