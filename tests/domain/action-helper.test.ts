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
import type { ApiFailure } from '@/shared/api';
import { safeFileName, paymentSlipPath, avatarPath, tenantKeyOf } from '@/lib/storage/paths';
import {
  LEAVE_GANG_REASONS,
  LEAVE_GANG_REASON_META_KEYS,
  type LeaveGangFailureReason,
} from '@/domain/gangs/leave-gang-error';

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

  it('🔴 [WO-B2.2] AppError ที่มี reason/reasonMeta + reason อยู่ใน allowlist จริง → ApiFailure.error.reason/reasonMeta ตรงตัว (additive) — ใช้ HAS_LATE_CANCEL_REGISTRATION เพราะเป็นตัวเดียวที่มี meta จริงตาม whitelist [QA wob22-static-followup-f4aefc3: ผูกกับ contract จริงของ leaveGang() ด้วย LEAVE_GANG_REASONS/LEAVE_GANG_REASON_META_KEYS ที่ export จริง ไม่เขียน options ปลอมขึ้นมาเอง]', async () => {
    const res = await runAction<{ id: number }, LeaveGangFailureReason>(
      'cid-4',
      async () => {
        throw new AppError('CANCEL_CUTOFF_PASSED', 'CANCEL_CUTOFF_PASSED', {
          reason: 'HAS_LATE_CANCEL_REGISTRATION',
          reasonMeta: { startsAt: '2026-11-01T18:00:00+07:00', cutoffAt: '2026-11-01T10:00:00+07:00' },
        });
      },
      { reasons: LEAVE_GANG_REASONS, reasonMetaKeys: LEAVE_GANG_REASON_META_KEYS },
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('CANCEL_CUTOFF_PASSED');
      expect(res.error.reason).toBe('HAS_LATE_CANCEL_REGISTRATION');
      expect(res.error.reasonMeta).toEqual({
        startsAt: '2026-11-01T18:00:00+07:00',
        cutoffAt: '2026-11-01T10:00:00+07:00',
      });
    }
  });

  it('🔴 [QA, WO-B2.2 · F1 เพิ่มเติม] OWNER_MUST_TRANSFER + reasonMeta ติดมาด้วย (แม้มี object จริงอยู่) → ถูก strip meta ทิ้งเสมอ เพราะ reason นี้ไม่มี key ไหนอยู่ใน whitelist เลย (LEAVE_GANG_REASON_META_KEYS ไม่มี entry ของ OWNER_MUST_TRANSFER) [QA wob22-static-followup-f4aefc3: ผูกกับ contract จริงด้วย LEAVE_GANG_REASONS/LEAVE_GANG_REASON_META_KEYS object จริง ไม่ใช่แค่ไม่ส่ง reasonMetaKeys เลย]', async () => {
    const res = await runAction<{ id: number }, LeaveGangFailureReason>(
      'cid-4h',
      async () => {
        throw new AppError('VALIDATION_ERROR', 'VALIDATION_ERROR', {
          reason: 'OWNER_MUST_TRANSFER',
          // มี object จริงติดมาด้วย (เช่น โค้ด action พลาดแปะ meta ที่ไม่ควรมี) — ต้องไม่หลุดออกไปเลย
          reasonMeta: { startsAt: '2026-11-01T18:00:00+07:00', cutoffAt: '2026-11-01T10:00:00+07:00' },
        });
      },
      // ส่ง object จริง (LEAVE_GANG_REASON_META_KEYS) ไม่ใช่แค่ไม่ส่งมาเลย — object จริงนี้เองที่ไม่มี
      // entry ของ OWNER_MUST_TRANSFER จึงพิสูจน์ contract จริง ไม่ใช่แค่ "ไม่ได้ส่ง opts มา"
      { reasons: LEAVE_GANG_REASONS, reasonMetaKeys: LEAVE_GANG_REASON_META_KEYS },
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.reason).toBe('OWNER_MUST_TRANSFER'); // reason เองยังผ่าน (อยู่ใน allowlist)
      expect(res.error.reasonMeta).toBeUndefined(); // แต่ meta ต้องหายไปทั้งหมด
    }
  });

  it('🔴 [planner · F1] AppError ที่มี reason จริง แต่ runAction ไม่ได้ส่ง opts เลย (default R=never, 2 args) → reason/reasonMeta ถูก strip ทิ้งเสมอที่ runtime ไม่ว่า error จะมีอะไรติดมา', async () => {
    const res = await runAction('cid-4b', async () => {
      throw new AppError('VALIDATION_ERROR', 'VALIDATION_ERROR', {
        reason: 'OWNER_MUST_TRANSFER',
        reasonMeta: { startsAt: 'x', cutoffAt: 'y' },
      });
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.reason).toBeUndefined();
      expect(res.error.reasonMeta).toBeUndefined();
    }
  });

  it('🔴 [planner · F1] AppError ที่มี reason จริงแต่**ไม่อยู่ใน allowlist**ของ call site นี้ (ส่ง opts.reasons มาแล้ว แต่ไม่มีค่านี้) → strip ทิ้ง — allowlist เช็คค่า ไม่ใช่แค่ "มีสิทธิ์มี reason บ้าง"', async () => {
    const res = await runAction<{ id: number }, 'RETRY'>(
      'cid-4d',
      async () => {
        // action นี้ throw AppError ที่มี reason เป็น OWNER_MUST_TRANSFER แต่ allowlist ของมันมีแค่ RETRY
        // (เช่น บั๊กในโค้ด action ที่ throw ผิด หรือ mapper คนละตัวกันโดยไม่ตั้งใจ)
        throw new AppError('VALIDATION_ERROR', 'VALIDATION_ERROR', { reason: 'OWNER_MUST_TRANSFER' as 'RETRY' });
      },
      { reasons: ['RETRY'] },
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(res.error.reason).toBeUndefined();
    }
  });

  it('🔴 [planner · F1] ปลอม error object ธรรมดา (ไม่ใช่ AppError จริง) ที่มี .code ตรง ErrorCode + .reason/.reasonMeta ติดมาด้วย แม้ allowlist จะมีค่านั้นพอดีก็หลุดไม่ได้ เพราะ toErrorCode() เช็ค instanceof AppError จริง ไม่ใช่ duck-type', async () => {
    const res = await runAction<{ id: number }, string>(
      'cid-4c',
      async () => {
        // object ธรรมดา (plain literal) ไม่ใช่ `new AppError(...)` เลย — นี่คือ counterexample ที่ QA ยกมา
        throw {
          code: 'FORBIDDEN',
          message: 'FORBIDDEN',
          reason: 'UNAPPROVED',
          reasonMeta: { registration_id: 'PRIVATE_MARKER', cause: { details: 'RAW_MARKER' } },
        };
      },
      { reasons: ['UNAPPROVED'], reasonMetaKeys: { UNAPPROVED: ['registration_id', 'cause'] } },
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('FORBIDDEN');
      expect(res.error.reason).toBeUndefined();
      expect(res.error.reasonMeta).toBeUndefined();
      expect(JSON.stringify(res.error)).not.toContain('PRIVATE_MARKER');
      expect(JSON.stringify(res.error)).not.toContain('RAW_MARKER');
    }
  });

  it('🔴 [planner · F1] ค่า reason ที่ inherit มาจาก prototype ของ AppError (prototype pollution) ไม่หลุดออกไป — ต้องเป็น own property จริงเท่านั้น (Object.hasOwn)', async () => {
    // จำลองโค้ดอื่นเผลอ/ตั้งใจเซ็ต AppError.prototype.reason ไว้ (ไม่ควรเกิดในโค้ดจริง แต่เทสต์นี้
    // พิสูจน์ว่าแม้เกิดขึ้น ก็ไม่หลุดผ่าน toErrorCode()/runAction() ออกไปอยู่ดี)
    //
    // 🔴 `new AppError(...)` เสมอตั้ง `this.reason = options?.reason` ไม่ว่าจะส่ง options มาหรือไม่
    // (แม้เป็น undefined ก็ยังเป็น own property) ⇒ shadow prototype เองอยู่แล้วโดยธรรมชาติ ไม่ใช่
    // vector ที่เป็นไปได้จริง — vector จริงคือ `Object.create(AppError.prototype)` ที่ **ข้าม
    // constructor ไปเลย** (เช่น โค้ด deserialize บางจุดที่ reconstruct error object ด้วย prototype
    // ตรงๆ) ⇒ ไม่มี own property ใดๆถูกตั้งเลย แต่ `instanceof AppError` ยังเป็น true เพราะเช็คแค่
    // prototype chain
    const proto = AppError.prototype as unknown as Record<string, unknown>;
    expect(Object.hasOwn(proto, 'reason')).toBe(false); // sanity: ปกติไม่มี own prop นี้บน prototype
    try {
      (proto as { reason?: string }).reason = 'SPOOFED_VIA_PROTOTYPE';
      const spoofed = Object.create(AppError.prototype) as AppError & { code: string; message: string };
      spoofed.code = 'VALIDATION_ERROR';
      spoofed.message = 'VALIDATION_ERROR';
      // ไม่ได้ตั้ง .reason ของตัวเองเลย — ไม่มี own property นี้
      expect(spoofed instanceof AppError).toBe(true); // ยืนยัน: instanceof ยัง true (เช็คแค่ prototype chain)
      expect(Object.hasOwn(spoofed, 'reason')).toBe(false); // ยืนยัน: ไม่มี own prop จริง
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- จำลอง .reason ที่ inherit มา ไม่ใช่ own
      expect((spoofed as any).reason).toBe('SPOOFED_VIA_PROTOTYPE'); // แต่ property access ธรรมดาเห็นค่านี้ (ทะลุ prototype)

      const res = await runAction<{ id: number }, string>(
        'cid-4e',
        async () => {
          throw spoofed;
        },
        { reasons: ['SPOOFED_VIA_PROTOTYPE'] },
      );
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.code).toBe('VALIDATION_ERROR');
        expect(res.error.reason).toBeUndefined(); // hasOwn gate ปิดช่องนี้ไว้
      }
    } finally {
      delete (proto as { reason?: string }).reason; // ห้ามปล่อย pollution ค้างไปเทสต์อื่น
    }
  });

  it('🔴 [planner · F1] reasonMeta ที่มี key แปลกปลอม (registration_id/cause) ติดมาจาก AppError จริง → ถูก pick เฉพาะ key ที่ whitelist ไว้เท่านั้น ไม่ว่า mapper จะใส่อะไรมาเพิ่มก็ตาม', async () => {
    const res = await runAction<{ id: number }, 'HAS_LATE_CANCEL_REGISTRATION'>(
      'cid-4f',
      async () => {
        throw new AppError('CANCEL_CUTOFF_PASSED', 'CANCEL_CUTOFF_PASSED', {
          reason: 'HAS_LATE_CANCEL_REGISTRATION',
          // จำลอง mapper ที่มีบั๊ก แปะ key แปลกปลอมมาด้วย (ไม่ควรเกิดกับ mapLeaveGangError() จริง
          // แต่ runAction()'s whitelist ชั้นที่สองต้องกรองได้แม้ mapper พลาด)
          reasonMeta: { startsAt: 'a', cutoffAt: 'b', registration_id: 'LEAK_ME_NOT', cause: { raw: 'x' } },
        });
      },
      { reasons: ['HAS_LATE_CANCEL_REGISTRATION'], reasonMetaKeys: { HAS_LATE_CANCEL_REGISTRATION: ['startsAt', 'cutoffAt'] } },
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.reason).toBe('HAS_LATE_CANCEL_REGISTRATION');
      expect(res.error.reasonMeta).toEqual({ startsAt: 'a', cutoffAt: 'b' });
      expect(Object.keys(res.error.reasonMeta ?? {}).sort()).toEqual(['cutoffAt', 'startsAt']);
      expect(JSON.stringify(res.error)).not.toContain('LEAK_ME_NOT');
    }
  });

  it('[type-level] ApiFailure<never> (action ที่ไม่ประกาศ R) ใส่ reason เป็น string จริงไม่ได้ — ยืนยันด้วย @ts-expect-error (tsc เช็คจริง ไม่ใช่แค่ comment)', () => {
    // ApiFailure<never> คือ type ของ error ที่ action ส่วนใหญ่ (ไม่ประกาศ R) ได้ — ลองใส่ reason เป็น
    // string literal ตรงๆ ต้อง error จริง เพราะ 'X' ไม่ assignable กับ never
    // @ts-expect-error — reason: 'X' ไม่ตรงกับ ApiFailure<never>'s reason?: never
    const fake: ApiFailure<never> = { success: false, error: { code: 'FORBIDDEN', message: 'x', reason: 'X' } };
    expect(fake.success).toBe(false);
  });

  it('🔴 [WO-B2.2] AppError ธรรมดา (ไม่ตั้ง reason) → error.reason เป็น undefined เหมือนของเดิมทุกประการ — ไม่กระทบ action อื่น', async () => {
    const res = await runAction('cid-5', async () => {
      throw new AppError('SESSION_FULL');
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('SESSION_FULL');
      expect(res.error.reason).toBeUndefined();
      expect(res.error.reasonMeta).toBeUndefined();
    }
  });

  it('🔴 [WO-B2.2] error ดิบจาก Postgrest (ไม่ใช่ AppError) ไม่มี reason ติดมาด้วยเลย แม้จะดัน .reason เข้าไปใน object เอง', async () => {
    const res = await runAction('cid-6', async () => {
      // จำลอง error ที่ "เผลอ" มี key ชื่อ reason อยู่แล้ว (เช่นมาจากไลบรารีอื่น) — ต้องไม่ผ่านมาได้
      // เพราะ toErrorCode() เช็ค 'code' in err ก่อน (err นี้ไม่มี .code ที่ตรง ErrorCode) จึงไม่ใช่กิ่งที่อ่าน reason
      throw { message: 'บางอย่างพัง', reason: 'ไม่ควรเห็นค่านี้' };
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe('INTERNAL_ERROR');
      expect(res.error.reason).toBeUndefined();
    }
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
