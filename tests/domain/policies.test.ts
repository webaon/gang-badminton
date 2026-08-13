/**
 * WO-2.3 — schema ของ cancellation policy + pricing (ADR-002)
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CANCELLATION_POLICY,
  fromJson,
  isImplemented as isPenaltyImplemented,
  toJson,
  validate,
  type CancellationPolicy,
} from '@/domain/policies/cancellation';
import {
  DEFAULT_ROUNDING_POLICY,
  flatRateFromJson,
  flatRateToJson,
  isImplemented as isPricingImplemented,
  roundingFromJson,
  validateFlatRate,
} from '@/domain/policies/pricing';

describe('cancellation policy — ADR-002', () => {
  it('ค่าเริ่มต้นคือ full_share ตามที่ ADR เลือก', () => {
    expect(DEFAULT_CANCELLATION_POLICY.penaltyType).toBe('full_share');
    expect(DEFAULT_CANCELLATION_POLICY.cutoffHours).toBe(12);
    expect(DEFAULT_CANCELLATION_POLICY.allowCancelAfterCutoff).toBe(true);
  });

  it('แปลงไป-กลับ jsonb แล้วได้ค่าเดิม', () => {
    const policy: CancellationPolicy = {
      cutoffHours: 6,
      allowCancelAfterCutoff: false,
      penaltyType: 'fixed',
      penaltyValue: '100.00',
      midwayCancelRatio: 0.25,
    };
    expect(fromJson(toJson(policy))).toEqual(policy);
  });

  it('ไม่ใส่ penaltyValue → ไม่โผล่ใน json (ไม่เขียน undefined ลง jsonb)', () => {
    const json = toJson(DEFAULT_CANCELLATION_POLICY);
    expect('penalty_value' in json).toBe(false);
  });

  it('🔴 [ADR-004] snapshot เก่าที่ไม่มี midway_cancel_ratio → ใช้ค่า fallback 0.5', () => {
    // เพิ่มคีย์แบบ additive ได้โดยไม่ต้องขึ้น snapshot_version ก็เพราะข้อนี้
    const old = fromJson({ cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' });
    expect(old.midwayCancelRatio).toBe(0.5);
  });

  it('[ADR-004] ค่านอกช่วง 0-1 ใน jsonb → ตกไปใช้ fallback ไม่เชื่อข้อมูลดิบ', () => {
    expect(fromJson({ midway_cancel_ratio: 5 }).midwayCancelRatio).toBe(0.5);
    expect(fromJson({ midway_cancel_ratio: -1 }).midwayCancelRatio).toBe(0.5);
    expect(fromJson({ midway_cancel_ratio: 'ครึ่งนึง' }).midwayCancelRatio).toBe(0.5);
    // ค่าที่ถูกต้องต้องอ่านได้ตามจริง
    expect(fromJson({ midway_cancel_ratio: 0 }).midwayCancelRatio).toBe(0);
    expect(fromJson({ midway_cancel_ratio: 1 }).midwayCancelRatio).toBe(1);
  });

  it('[ADR-004] validate ปฏิเสธสัดส่วนนอกช่วง 0-1', () => {
    for (const ratio of [-0.1, 1.1, Number.NaN]) {
      expect(
        validate({ ...DEFAULT_CANCELLATION_POLICY, midwayCancelRatio: ratio }),
      ).not.toEqual([]);
    }
    expect(validate({ ...DEFAULT_CANCELLATION_POLICY, midwayCancelRatio: 0 })).toEqual([]);
  });

  it('🔴 snapshot เก่าที่ไม่มี penalty_type → ตีความเป็น none ไม่ใช่พัง', () => {
    // ADR-002 ระบุไว้ตรงๆ — นัดที่สร้างก่อน ADR ต้องยังเปิดดูได้
    const old = fromJson({ cutoff_hours: 12, allow_cancel_after_cutoff: true });
    expect(old.penaltyType).toBe('none');
    expect(old.cutoffHours).toBe(12);
  });

  it('jsonb ที่พังสิ้นดี → ค่า fallback ที่ปลอดภัย ไม่โยน error', () => {
    for (const junk of [null, undefined, 'ไม่ใช่ object', 42, []]) {
      const parsed = fromJson(junk);
      expect(parsed.cutoffHours).toBe(0);
      expect(parsed.penaltyType).toBe('none');
    }
  });

  it('penalty_type ที่ไม่รู้จัก → none (ไม่เชื่อข้อมูลใน jsonb)', () => {
    expect(fromJson({ penalty_type: 'ลบเงินหมดบัญชี' }).penaltyType).toBe('none');
  });

  describe('validate — เข้มตอนเขียน', () => {
    it('policy มาตรฐานผ่าน', () => {
      expect(validate(DEFAULT_CANCELLATION_POLICY)).toEqual([]);
    });

    it('cutoff ติดลบ / ยาวเกินไป → ไม่ผ่าน', () => {
      expect(validate({ ...DEFAULT_CANCELLATION_POLICY, cutoffHours: -1 })).not.toEqual([]);
      expect(validate({ ...DEFAULT_CANCELLATION_POLICY, cutoffHours: 24 * 30 })).not.toEqual([]);
    });

    it('fixed/percent ต้องมี penaltyValue', () => {
      expect(validate({ ...DEFAULT_CANCELLATION_POLICY, penaltyType: 'fixed' })).not.toEqual([]);
      expect(validate({ ...DEFAULT_CANCELLATION_POLICY, penaltyType: 'percent' })).not.toEqual([]);
      expect(
        validate({ ...DEFAULT_CANCELLATION_POLICY, penaltyType: 'fixed', penaltyValue: '100' }),
      ).toEqual([]);
    });

    it('percent เกิน 100 → ไม่ผ่าน', () => {
      expect(
        validate({ ...DEFAULT_CANCELLATION_POLICY, penaltyType: 'percent', penaltyValue: '150' }),
      ).not.toEqual([]);
    });

    it('full_share / none ไม่ต้องมี penaltyValue', () => {
      expect(validate({ ...DEFAULT_CANCELLATION_POLICY, penaltyType: 'none' })).toEqual([]);
    });
  });

  it('🔴 MVP-0 implement แค่ full_share กับ none — ที่เหลือต้องรู้ว่ายังไม่รองรับ', () => {
    expect(isPenaltyImplemented('full_share')).toBe(true);
    expect(isPenaltyImplemented('none')).toBe(true);
    // ประกาศไว้ใน schema แล้วแต่ billing ยังคิดไม่ได้ ⇒ ต้อง raise ไม่ใช่คิดเป็น 0 เงียบๆ
    expect(isPenaltyImplemented('fixed')).toBe(false);
    expect(isPenaltyImplemented('percent')).toBe(false);
  });
});

describe('pricing — ADR-002 เลือก flat_rate โมเดลเดียวใน MVP-0', () => {
  it('flat_rate implement แล้ว ที่เหลือยัง', () => {
    expect(isPricingImplemented('flat_rate')).toBe(true);
    expect(isPricingImplemented('court_plus_shuttle')).toBe(false);
    expect(isPricingImplemented('monthly')).toBe(false);
  });

  it('ราคาปกติผ่าน', () => {
    expect(validateFlatRate({ amountPerPerson: '150' })).toEqual([]);
    expect(validateFlatRate({ amountPerPerson: '150.50' })).toEqual([]);
  });

  it('🔴 ค่าเงินที่ผิดรูปแบบถูกปฏิเสธ', () => {
    for (const bad of ['', '  ', 'abc', '-50', '150.555', '1e3', '150,50', '0']) {
      expect(validateFlatRate({ amountPerPerson: bad }), bad).not.toEqual([]);
    }
  });

  it('ราคาสูงผิดปกติถูกปฏิเสธ (กันพิมพ์ศูนย์เกิน)', () => {
    expect(validateFlatRate({ amountPerPerson: '999999' })).not.toEqual([]);
  });

  it('แปลงไป-กลับ jsonb ได้ค่าเดิม และเป็น string เสมอ', () => {
    const json = flatRateToJson({ amountPerPerson: ' 200.00 ' });
    expect(json).toEqual({ amount_per_person: '200.00' });
    expect(typeof json.amount_per_person).toBe('string');
    expect(flatRateFromJson(json).amountPerPerson).toBe('200.00');
  });

  it('rounding policy default = ปัดขึ้นเป็นบาท เศษเข้าก๊วน (baseline blocker)', () => {
    expect(DEFAULT_ROUNDING_POLICY).toEqual({ mode: 'ceil_baht', surplusTo: 'gang' });
    expect(roundingFromJson({ mode: 'ไม่รู้จัก' }).mode).toBe('ceil_baht');
    expect(roundingFromJson({ mode: 'absorb' }).mode).toBe('absorb');
  });
});
