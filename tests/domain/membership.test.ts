/**
 * WO-2.5-C — MembershipBilling (กติกาที่ตกลง 13 ส.ค. 2026)
 *
 *   · เข้ากลางเดือน = **เก็บเต็มเดือน** ไม่มี pro-rate
 *   · ออกบิลต้นเดือนสำหรับ**เดือนนั้น** (จ่ายล่วงหน้า)
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import {
  assertBillingMonth,
  billingMonthOf,
  calculateMonthlyFees,
  isBillableInMonth,
  lastDayOfMonth,
  type MonthlyMember,
} from '@/domain/billing/membership';

function member(overrides: Partial<MonthlyMember> = {}): MonthlyMember {
  return {
    gangMemberId: crypto.randomUUID(),
    monthlyMemberSince: null,
    monthlyMemberUntil: null,
    ...overrides,
  };
}

describe('WO-2.5-C — ขอบเขตของเดือน', () => {
  it('หาวันสุดท้ายของเดือนถูกต้อง รวมเดือน ก.พ. ปีอธิกสุรทิน', () => {
    expect(lastDayOfMonth('2026-09-01')).toBe('2026-09-30');
    expect(lastDayOfMonth('2026-08-01')).toBe('2026-08-31');
    expect(lastDayOfMonth('2026-02-01')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02-01')).toBe('2028-02-29');
  });

  it('🔴 ปฏิเสธเดือนที่ไม่ใช่วันแรก — กันเรียกด้วยวันกลางเดือนแล้วช่วงเพี้ยน', () => {
    expect(() => assertBillingMonth('2026-09-15')).toThrow(/วันแรกของเดือน/);
    expect(() => assertBillingMonth('2026-09')).toThrow();
    expect(() => lastDayOfMonth('2026-09-15')).toThrow();
  });

  it('🔴 อ่านเดือนจากนาฬิกาของก๊วน ไม่ใช่ UTC', () => {
    // ก๊วนไทย 1 ก.ย. 00:10 (= 31 ส.ค. 17:10Z) ⇒ ต้องเป็นรอบเดือน ก.ย.
    expect(billingMonthOf('2026-09-01T00:10')).toBe('2026-09-01');
    expect(billingMonthOf('2026-08-31T17:10')).toBe('2026-08-01');
  });
});

describe('WO-2.5-C DoD — ใครถูกเก็บบ้างในเดือนนั้น', () => {
  const MONTH = '2026-09-01';

  it('ไม่ระบุวันเริ่ม/สิ้นสุด → เก็บ', () => {
    expect(isBillableInMonth(member(), MONTH)).toBe(true);
  });

  it('🔴 สมัครกลางเดือน → ยังเก็บเต็มเดือนนั้น (กติกาที่ตกลง)', () => {
    for (const since of ['2026-09-01', '2026-09-15', '2026-09-30']) {
      expect(isBillableInMonth(member({ monthlyMemberSince: since }), MONTH), since).toBe(true);
    }
  });

  it('สมัครเดือนถัดไป → ยังไม่เก็บเดือนนี้', () => {
    expect(isBillableInMonth(member({ monthlyMemberSince: '2026-10-01' }), MONTH)).toBe(false);
  });

  it('หมดสมาชิกก่อนเดือนนี้เริ่ม → ไม่เก็บย้อนหลัง', () => {
    expect(isBillableInMonth(member({ monthlyMemberUntil: '2026-08-31' }), MONTH)).toBe(false);
  });

  it('🔴 เลิกกลางเดือน → ยังเก็บเดือนนั้นเต็ม (สมมาตรกับตอนสมัคร)', () => {
    expect(isBillableInMonth(member({ monthlyMemberUntil: '2026-09-10' }), MONTH)).toBe(true);
  });

  it('ช่วงสมาชิกอยู่คนละเดือนกันทั้งหมด → ไม่เก็บ', () => {
    const past = member({ monthlyMemberSince: '2026-01-01', monthlyMemberUntil: '2026-03-31' });
    expect(isBillableInMonth(past, MONTH)).toBe(false);
  });
});

describe('WO-2.5-C — คิดยอดรวมของรอบ', () => {
  it('ทุกคนจ่ายเท่ากัน · ยอดรวม = ค่าสมาชิก × จำนวนคนที่ถูกเก็บ', () => {
    const result = calculateMonthlyFees({
      billingMonth: '2026-09-01',
      monthlyFee: '1200.00',
      members: [
        member(),
        member({ monthlyMemberSince: '2026-09-20' }),
        // คนนี้ไม่ถูกเก็บ — สมัครเดือนหน้า
        member({ monthlyMemberSince: '2026-10-05' }),
      ],
    });

    expect(result.charges).toHaveLength(2);
    expect(result.charges.every((c) => c.amount === '1200.00')).toBe(true);
    expect(result.total).toBe('2400.00');
  });

  it('breakdown บอกได้ว่าทำไมถึงเก็บเต็มเดือน (ตรวจย้อนหลังได้)', () => {
    const joined = member({ monthlyMemberSince: '2026-09-20' });
    const result = calculateMonthlyFees({
      billingMonth: '2026-09-01',
      monthlyFee: '1200.00',
      members: [joined],
    });

    expect(result.charges[0].breakdown).toMatchObject({
      monthly_fee: '1200.00',
      billing_month: '2026-09-01',
      proration: 'full_month',
      member_since: '2026-09-20',
    });
  });

  it('ไม่มีสมาชิกรายเดือนเลย → ไม่มี charge และยอดรวมเป็น 0', () => {
    const result = calculateMonthlyFees({
      billingMonth: '2026-09-01',
      monthlyFee: '1200.00',
      members: [],
    });

    expect(result.charges).toHaveLength(0);
    expect(result.total).toBe('0.00');
  });

  it('🔴 เงินไม่ผ่าน float — ค่าสมาชิกที่มีสตางค์ยังตรงเป๊ะเมื่อคูณหลายคน', () => {
    const result = calculateMonthlyFees({
      billingMonth: '2026-09-01',
      monthlyFee: '1200.10',
      members: [member(), member(), member()],
    });

    expect(result.total).toBe('3600.30');
  });

  it('เดือนที่ไม่ใช่วันแรก → throw ก่อนคิดเงิน', () => {
    expect(() =>
      calculateMonthlyFees({
        billingMonth: '2026-09-15',
        monthlyFee: '1200.00',
        members: [member()],
      }),
    ).toThrow(/วันแรกของเดือน/);
  });
});
