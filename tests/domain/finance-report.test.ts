/**
 * WO-3.B — รายงานรายรับ-รายจ่าย-กำไร (สูตร)
 *
 * 🔴 baseline §Verification: `sum(charges) − ต้นทุนจริง = rounding surplus`
 *    และ [v3.3]: รายรับนับจาก charges/ledger เสมอ ไม่อิง session status
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import {
  assertReportReconciles,
  calculateFinanceReport,
  type ReportCharge,
} from '@/domain/reports/finance';

function charge(overrides: Partial<ReportCharge> = {}): ReportCharge {
  return {
    chargeId: crypto.randomUUID(),
    amount: '200.00',
    allocated: [],
    adjustments: [],
    refunds: [],
    roundingSurplus: '0.00',
    ...overrides,
  };
}

describe('WO-3.B — แยก "เรียกเก็บแล้ว" กับ "เก็บได้จริง"', () => {
  it('ยังไม่มีใครจ่าย → เรียกเก็บมี แต่เก็บได้จริงเป็น 0', () => {
    const report = calculateFinanceReport({
      charges: [charge(), charge()],
      otherIncomes: [],
      expenses: [],
    });

    expect(report.charged).toBe('400.00');
    expect(report.collected).toBe('0.00');
    expect(report.outstanding).toBe('400.00');
    expect(report.netCash).toBe('0.00');
  });

  it('จ่ายครบ → เก็บได้จริงเท่าเรียกเก็บ และไม่ค้าง', () => {
    const report = calculateFinanceReport({
      charges: [charge({ allocated: ['200.00'] })],
      otherIncomes: [],
      expenses: [],
    });

    expect(report.collected).toBe('200.00');
    expect(report.outstanding).toBe('0.00');
  });

  it('🔴 refund หักออกจาก "เก็บได้จริง" — เป็นเงินสดที่คืนออกไปแล้ว', () => {
    const report = calculateFinanceReport({
      charges: [
        charge({ allocated: ['200.00'], adjustments: ['-50.00'], refunds: ['-50.00'] }),
      ],
      otherIncomes: [],
      expenses: [],
    });

    expect(report.collected).toBe('150.00');
    // หนี้ติดลบ = ก๊วนเป็นหนี้ผู้เล่น
    expect(report.credit).toBe('-50.00');
  });

  it('🔴 credit ลดหนี้แต่ไม่ใช่เงินสด ⇒ ไม่กระทบ "เก็บได้จริง"', () => {
    const report = calculateFinanceReport({
      charges: [charge({ adjustments: ['-200.00'] })],
      otherIncomes: [],
      expenses: [],
    });

    expect(report.collected).toBe('0.00');
    expect(report.outstanding).toBe('0.00');
    expect(report.charged).toBe('200.00');
  });

  it('correction เพิ่มหนี้ → ค้างเพิ่ม แต่เงินสดยังเท่าเดิม', () => {
    const report = calculateFinanceReport({
      charges: [charge({ adjustments: ['30.00'] })],
      otherIncomes: [],
      expenses: [],
    });

    expect(report.outstanding).toBe('230.00');
    expect(report.collected).toBe('0.00');
  });
});

describe('WO-3.B — กำไรเงินสด', () => {
  it('เก็บได้จริง + รายรับอื่น − รายจ่าย', () => {
    const report = calculateFinanceReport({
      charges: [charge({ allocated: ['200.00'] }), charge({ allocated: ['200.00'] })],
      otherIncomes: ['500.00'],
      expenses: ['800.00', '25.50'],
    });

    expect(report.collected).toBe('400.00');
    expect(report.otherIncome).toBe('500.00');
    expect(report.expense).toBe('825.50');
    expect(report.netCash).toBe('74.50');
  });

  it('🔴 ขาดทุนแสดงเป็นค่าติดลบ ไม่ใช่ 0', () => {
    const report = calculateFinanceReport({
      charges: [charge({ allocated: ['100.00'] })],
      otherIncomes: [],
      expenses: ['800.00'],
    });

    expect(report.netCash).toBe('-700.00');
  });

  it('เงินไม่ผ่าน float — สตางค์ยังตรงหลังบวกลบหลายชั้น', () => {
    const report = calculateFinanceReport({
      charges: [
        charge({ amount: '333.33', allocated: ['111.11'] }),
        charge({ amount: '66.67', allocated: ['66.67'] }),
      ],
      otherIncomes: ['0.10'],
      expenses: ['0.03'],
    });

    expect(report.charged).toBe('400.00');
    expect(report.collected).toBe('177.78');
    expect(report.netCash).toBe('177.85');
  });
});

describe('WO-3.B DoD — reconcile ได้', () => {
  it('🔴 sum(charges) − ต้นทุนจริง = เศษจากการปัด', () => {
    // 7 คน จ่ายคนละ 137 = 959 · ต้นทุนจริง 950 ⇒ เศษ 9 (เคสจริงจาก WO-2.5-B)
    const charges = [
      ...Array.from({ length: 4 }, () => charge({ amount: '137.00', roundingSurplus: '1.28' })),
      ...Array.from({ length: 3 }, () => charge({ amount: '137.00', roundingSurplus: '1.30' })),
    ];

    const report = calculateFinanceReport({ charges, otherIncomes: [], expenses: [] });

    expect(report.charged).toBe('959.00');
    expect(report.roundingSurplus).toBe('9.02');

    // ตรวจกับต้นทุนที่รู้คำตอบ
    expect(() => assertReportReconciles(report, '949.98')).not.toThrow();
    expect(() => assertReportReconciles(report, '950.00')).toThrow(/reconcile ไม่ได้/);
  });

  it('ไม่มีการหาร (flat_rate) → เศษเป็น 0 และต้นทุนเท่ากับที่เรียกเก็บ', () => {
    const report = calculateFinanceReport({
      charges: [charge({ amount: '200.00' }), charge({ amount: '200.00' })],
      otherIncomes: [],
      expenses: [],
    });

    expect(report.roundingSurplus).toBe('0.00');
    expect(() => assertReportReconciles(report, '400.00')).not.toThrow();
  });

  it('ช่วงที่ไม่มีข้อมูลเลย → ทุกช่องเป็น 0.00 ไม่ใช่ค่าว่าง', () => {
    const report = calculateFinanceReport({ charges: [], otherIncomes: [], expenses: [] });

    expect(report).toMatchObject({
      charged: '0.00',
      collected: '0.00',
      outstanding: '0.00',
      credit: '0.00',
      roundingSurplus: '0.00',
      netCash: '0.00',
    });
  });
});
