/**
 * WO-B5b-2 (Q4) — รายงานการเงินกับเครดิตสมาชิก: ตรงกับ "บัญชีธนาคาร" ไม่นับเงินซ้ำ ไม่ตกหล่น
 *
 *   · ไม่ส่งฟิลด์ใหม่ = ผลเหมือนเดิมทุกตัวเลข (ไม่กระทบรายงานเดิม)
 *   · โอนเกินนับตอนเงินเข้า (overpaymentIn) · allocation ที่จ่ายด้วยเครดิตไม่นับเป็นเงินสดซ้ำ
 *   · cash_payout = เงินคืนสมาชิก หัก netCash · topup/charge_return ไม่ใช่เงินสด
 */
import { describe, it, expect } from 'vitest';
import { calculateFinanceReport, type ReportCharge } from '@/domain/reports/finance';

const charge = (p: Partial<ReportCharge> & { amount: string; allocated?: string[] }): ReportCharge => ({
  chargeId: crypto.randomUUID(),
  allocated: [],
  adjustments: [],
  refunds: [],
  roundingSurplus: '0.00',
  ...p,
});

describe('calculateFinanceReport — เดิมไม่เปลี่ยน', () => {
  it('ไม่ส่ง creditAllocated/overpayments/memberPayouts ⇒ collected/netCash สูตรเดิม · ฟิลด์ใหม่เป็น 0.00', () => {
    const r = calculateFinanceReport({
      charges: [
        charge({ amount: '150.00', allocated: ['150.00'] }),
        charge({ amount: '100.00', allocated: ['100.00'], adjustments: ['-30.00'], refunds: ['-30.00'] }),
      ],
      otherIncomes: ['50.00'],
      expenses: ['20.00'],
    });
    expect(r.collected).toBe('220.00'); // 250 − 30
    expect(r.netCash).toBe('250.00'); // 220 + 50 − 20
    expect(r.overpaymentIn).toBe('0.00');
    expect(r.memberPayouts).toBe('0.00');
  });
});

describe('calculateFinanceReport — เครดิตสมาชิก (ADR-010 Q4)', () => {
  it('🔴 โอน 200 แทนสลิป 150 → เก็บได้ 150 + โอนเกินเข้า 50 · เครดิตจ่ายหนี้ 50 ไม่นับเงินสดซ้ำ · netCash = เงินเข้าบัญชีจริง 200', () => {
    const r = calculateFinanceReport({
      charges: [
        charge({ amount: '150.00', allocated: ['150.00'] }), // จ่ายด้วยโอน
        charge({ amount: '50.00', allocated: ['50.00'], creditAllocated: ['50.00'] }), // จ่ายด้วยเครดิตที่ได้จากโอนเกิน
      ],
      otherIncomes: [],
      expenses: [],
      overpayments: ['50.00'],
    });
    expect(r.charged).toBe('200.00');
    expect(r.collected).toBe('150.00'); // ไม่รวมส่วนที่จ่ายด้วยเครดิต
    expect(r.overpaymentIn).toBe('50.00');
    expect(r.outstanding).toBe('0.00');
    expect(r.netCash).toBe('200.00'); // = เงินที่เข้าบัญชีจริงทั้งหมด
  });

  it('🔴 จ่ายคืนเครดิตเป็นเงินสด → "เงินคืนสมาชิก" หักจาก netCash (รับค่าบวกหรือลบก็ได้ ใช้ค่าสัมบูรณ์)', () => {
    const base = {
      charges: [charge({ amount: '100.00', allocated: ['100.00'] })],
      otherIncomes: [],
      expenses: ['10.00'],
      overpayments: ['40.00'],
    };
    const positive = calculateFinanceReport({ ...base, memberPayouts: ['15.00', '5.00'] });
    const negative = calculateFinanceReport({ ...base, memberPayouts: ['-15.00', '-5.00'] });
    expect(positive.memberPayouts).toBe('20.00');
    expect(positive.netCash).toBe('110.00'); // 100 + 40 − 10 − 20
    expect(negative).toEqual(positive);
  });

  it('เครดิตที่ "ให้" (admin_topup) แล้วหักกับหนี้ → ไม่มีเงินสดเข้า: collected/netCash ไม่เพิ่ม', () => {
    const r = calculateFinanceReport({
      charges: [charge({ amount: '30.00', allocated: ['30.00'], creditAllocated: ['30.00'] })],
      otherIncomes: [],
      expenses: [],
    });
    expect(r.charged).toBe('30.00');
    expect(r.collected).toBe('0.00');
    expect(r.netCash).toBe('0.00');
  });

  it('charge ที่จ่ายด้วยโอน 100 แล้วถูกยกเลิก-ย้ายเข้าเครดิต (credit −100 + credit_return +100): เงินยังอยู่ในบัญชี netCash = 100 · ไม่ค้าง/ไม่ต้องคืนคู่เครดิต', () => {
    const r = calculateFinanceReport({
      charges: [charge({ amount: '100.00', allocated: ['100.00'], adjustments: ['-100.00', '100.00'] })],
      otherIncomes: [],
      expenses: [],
    });
    expect(r.collected).toBe('100.00');
    expect(r.outstanding).toBe('0.00');
    expect(r.credit).toBe('0.00'); // ไม่ซ้ำกับเครดิตสมาชิกใน credit_ledger
    expect(r.netCash).toBe('100.00');
  });

  it('ทศนิยมสตางค์ไม่เพี้ยน (ไม่มี float)', () => {
    const r = calculateFinanceReport({
      charges: [charge({ amount: '0.30', allocated: ['0.30'], creditAllocated: ['0.10'] })],
      otherIncomes: [],
      expenses: [],
      overpayments: ['0.10', '0.20'],
      memberPayouts: ['0.10'],
    });
    expect(r.collected).toBe('0.20');
    expect(r.overpaymentIn).toBe('0.30');
    expect(r.memberPayouts).toBe('0.10');
    expect(r.netCash).toBe('0.40');
  });
});
