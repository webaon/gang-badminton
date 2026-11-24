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
  cashFlowPartsOf,
  cashFlowRatiosOf,
  calculateFinanceReport,
  splitCashFlow,
  type ReportCharge,
} from '@/domain/reports/finance';
import { fromSatang, toSatang } from '@/domain/billing/money';

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

describe('WO-6.5c — splitCashFlow(cashFlowPartsOf()): เงินเข้า/เงินออกแยกสองฝั่ง ต้องตรงกับ netCash ของ calculateFinanceReport ทุกเคส (สูตรเดียว — ใช้ aggregate() ร่วมกัน ไม่มีฟังก์ชันคำนวณซ้ำตัวที่สอง)', () => {
  function expectIdentity(input: Parameters<typeof calculateFinanceReport>[0]) {
    const report = calculateFinanceReport(input);
    const split = splitCashFlow(cashFlowPartsOf(input));
    const inflowSatang = toSatang(split.inflow);
    const outflowSatang = toSatang(split.outflow);
    expect(fromSatang(inflowSatang - outflowSatang)).toBe(report.netCash);
    return { report, split };
  }

  it('ไม่มีข้อมูลเลย → inflow=outflow=0, netCash=0', () => {
    const { split } = expectIdentity({ charges: [], otherIncomes: [], expenses: [] });
    expect(split).toEqual({ inflow: '0.00', outflow: '0.00' });
  });

  it('จ่ายครบไม่มี refund/overpayment/expense → inflow = ยอดที่จ่ายมา, outflow = 0', () => {
    const { split } = expectIdentity({
      charges: [charge({ allocated: ['200.00'] })],
      otherIncomes: [],
      expenses: [],
    });
    expect(split).toEqual({ inflow: '200.00', outflow: '0.00' });
  });

  it('🔴 มี refund ≠ 0 ตัวเลขชัดเจน → refund ไปอยู่ฝั่ง outflow เป็นค่า**บวก** ไม่ใช่หักจาก inflow เงียบๆ (ต่างจาก collected ของรายงานเดิมที่หัก refund ไปแล้ว)', () => {
    const { split } = expectIdentity({
      charges: [
        charge({ allocated: ['200.00'], adjustments: ['-50.00'], refunds: ['-50.00'] }),
      ],
      otherIncomes: [],
      expenses: [],
    });
    // transferIn (ก่อนหัก refund) = allocated 200 (ไม่มี creditAllocated) → inflow = 200
    expect(split.inflow).toBe('200.00');
    // outflow = refund 50 — เครื่องหมายต้องพลิกจาก -50 (เก็บใน aggregate().refunded) เป็น +50
    expect(split.outflow).toBe('50.00');
  });

  it('🔴 เช็คเครื่องหมาย refunded ตรงๆ: cashFlowPartsOf().refunds ต้องเป็นค่าบวกเสมอ แม้ aggregate() เก็บ refunded เป็นลบ', () => {
    const parts = cashFlowPartsOf({
      charges: [charge({ allocated: ['300.00'], refunds: ['-75.25'] })],
      otherIncomes: [],
      expenses: [],
    });
    expect(parts.refunds).toBe('75.25'); // ไม่ใช่ '-75.25'
    expect(parts.transferIn).toBe('300.00'); // ก่อนหัก refund
  });

  it('refund หลายรายการสะสมกันถูกต้อง (ไม่ใช่แค่รายการเดียว)', () => {
    const { split } = expectIdentity({
      charges: [
        charge({ allocated: ['200.00'], refunds: ['-30.00', '-20.00'] }),
        charge({ allocated: ['100.00'], refunds: ['-10.00'] }),
      ],
      otherIncomes: [],
      expenses: [],
    });
    expect(split.inflow).toBe('300.00'); // 200+100 ก่อนหัก refund
    expect(split.outflow).toBe('60.00'); // 30+20+10
  });

  it('ส่วนที่จ่ายด้วยเครดิตไม่ใช่เงินสดเข้า ⇒ ไม่เข้า inflow', () => {
    const { split } = expectIdentity({
      charges: [charge({ allocated: ['200.00'], creditAllocated: ['200.00'] })],
      otherIncomes: [],
      expenses: [],
    });
    expect(split.inflow).toBe('0.00');
  });

  it('โอนเกินเข้าเครดิต + รายรับอื่น เข้า inflow · รายจ่าย + เงินคืนสมาชิก เข้า outflow', () => {
    const { split } = expectIdentity({
      charges: [charge({ allocated: ['200.00'] })],
      otherIncomes: ['500.00'],
      expenses: ['100.00'],
      overpayments: ['80.00'],
      memberPayouts: ['-30.00'],
    });
    expect(split).toEqual({ inflow: '780.00', outflow: '130.00' });
  });

  it('เงินไม่ผ่าน float — สตางค์ยังตรงหลังบวกลบหลายชั้นทั้ง inflow/outflow (รวม refund)', () => {
    expectIdentity({
      charges: [
        charge({ amount: '333.33', allocated: ['111.11'], refunds: ['-10.01'] }),
        charge({ amount: '66.67', allocated: ['66.67'] }),
      ],
      otherIncomes: ['0.10'],
      expenses: ['0.03'],
      overpayments: ['12.34'],
      memberPayouts: ['-5.05'],
    });
  });
});

describe('WO-6.5c-DTO — cashFlowRatiosOf(): inRatio/outRatio ของกราฟ monthlyCashFlow [planner 31 ต.ค. 2026: max ร่วมตัวเดียวจากทั้ง 12 ค่า ไม่ใช่ max แยก series]', () => {
  it('🔴 ทุกเดือนเป็น 0 ทั้ง in และ out → ratio=0 ทุกตัว (กัน NaN จากหาร 0/0)', () => {
    const result = cashFlowRatiosOf([
      { inflow: '0.00', outflow: '0.00' },
      { inflow: '0.00', outflow: '0.00' },
    ]);
    expect(result).toEqual([
      { inRatio: 0, outRatio: 0 },
      { inRatio: 0, outRatio: 0 },
    ]);
  });

  it('เดือนเดียว (array ยาว 1) ที่มีค่าจริง → ตัวที่มากกว่าได้ ratio=1 เทียบกับตัวเองในเดือนนั้น', () => {
    const result = cashFlowRatiosOf([{ inflow: '500.00', outflow: '200.00' }]);
    // max ร่วม = 500 (inflow ของเดือนนั้นเอง เพราะมากกว่า outflow) ⇒ in=500/500=1, out=200/500=0.4
    expect(result).toEqual([{ inRatio: 1, outRatio: 0.4 }]);
  });

  it('🔴 [planner คำตัดสิน 31 ต.ค. 2026] in=1000/out=500 เดือนเดียว → inRatio=1.0, outRatio=0.5 (max ร่วมของทั้งคู่คือ 1000 — ไม่ใช่ max แยก series ที่จะได้ 1.0/1.0 ทั้งคู่)', () => {
    const result = cashFlowRatiosOf([{ inflow: '1000.00', outflow: '500.00' }]);
    expect(result).toEqual([{ inRatio: 1, outRatio: 0.5 }]);
  });

  it('ทศนิยม — max ร่วมจากหลายเดือน คำนวณผ่านสตางค์ (จำนวนเต็ม) ก่อนหารเสมอ ไม่ parse string เงินเป็น float ตรงๆ', () => {
    const result = cashFlowRatiosOf([
      { inflow: '150.55', outflow: '0.00' }, // 15055 สตางค์
      { inflow: '0.00', outflow: '300.10' }, // 30010 สตางค์ — max ร่วม = 30010
    ]);
    expect(result).toEqual([
      { inRatio: 15055 / 30010, outRatio: 0 },
      { inRatio: 0, outRatio: 1 },
    ]);
    // ยืนยันว่าค่าที่ได้ไม่ใช่ float parse ตรงๆที่อาจเพี้ยน (150.55/300.10 ควรได้ค่าเดียวกันพอดีในเคสนี้
    // เพราะเป็นจำนวนเต็มสตางค์ล้วน แต่สูตรต้องมาจาก toSatang() ก่อนเสมอ ไม่ใช่ Number(string) ตรงๆ)
    expect(result[0].inRatio).toBeCloseTo(0.50166611, 7);
  });

  it('หลายเดือนรวมกัน (6 เดือนจริงของ dashboard) — max ร่วมมาจากค่าที่สูงสุดในทั้ง 12 ค่า (in 6 + out 6) ไม่ใช่ max แยกฝั่ง', () => {
    const result = cashFlowRatiosOf([
      { inflow: '100.00', outflow: '900.00' }, // out เดือนนี้คือ max ร่วมของทั้งหมด (900)
      { inflow: '450.00', outflow: '50.00' },
      { inflow: '0.00', outflow: '0.00' },
      { inflow: '300.00', outflow: '300.00' },
      { inflow: '900.00', outflow: '0.00' }, // in เดือนนี้เท่ากับ max ร่วมเป๊ะ (900) — ต้องได้ 1 พอดี
      { inflow: '10.00', outflow: '10.00' },
    ]);
    expect(result[0]).toEqual({ inRatio: 100 / 900, outRatio: 1 }); // outflow 900 = max ⇒ outRatio=1
    expect(result[4]).toEqual({ inRatio: 1, outRatio: 0 }); // inflow 900 = max ⇒ inRatio=1
    expect(result[2]).toEqual({ inRatio: 0, outRatio: 0 }); // เดือนที่เป็น 0 ทั้งคู่
  });
});
