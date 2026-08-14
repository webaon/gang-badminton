/**
 * WO-2.5-D — ledger: ยอดสุทธิต่อคน = charge − allocations + adjustments
 *
 * 🔴 baseline §การตัดสินใจสะสม: "Allocated / Adjusted / Refunded **ไม่ใช่ state**"
 *    ⇒ ยอดค้างต้องคำนวณสดจาก ledger ทุกครั้ง ห้ามอ่านจาก `payments.status`
 *
 * pure unit test — ไม่แตะ DB
 */
import { describe, it, expect } from 'vitest';
import { ledgerLineOf, summarize, validateAdjustment } from '@/domain/billing/ledger';

describe('WO-2.5-D — ยอดสุทธิของหนี้ก้อนเดียว', () => {
  it('ยังไม่จ่ายอะไรเลย → ค้างเต็มจำนวน', () => {
    const line = ledgerLineOf({
      chargeId: 'c1',
      amount: '200.00',
      allocated: [],
      adjustments: [],
    });

    expect(line.outstanding).toBe('200.00');
  });

  it('จ่ายบางส่วน → ค้างส่วนที่เหลือ', () => {
    const line = ledgerLineOf({
      chargeId: 'c1',
      amount: '200.00',
      allocated: ['120.00'],
      adjustments: [],
    });

    expect(line.allocated).toBe('120.00');
    expect(line.outstanding).toBe('80.00');
  });

  it('refund หลังจ่ายครบ → ยอดติดลบ = ก๊วนเป็นหนี้ผู้เล่น', () => {
    const line = ledgerLineOf({
      chargeId: 'c1',
      amount: '200.00',
      allocated: ['200.00'],
      adjustments: ['-50.00'],
    });

    expect(line.outstanding).toBe('-50.00');
  });

  it('correction เพิ่มหนี้ · credit ลดหนี้ — บวกกันตามเครื่องหมาย', () => {
    const line = ledgerLineOf({
      chargeId: 'c1',
      amount: '200.00',
      allocated: [],
      adjustments: ['30.00', '-20.00'],
    });

    expect(line.adjusted).toBe('10.00');
    expect(line.outstanding).toBe('210.00');
  });

  it('🔴 เงินไม่ผ่าน float — สตางค์ยังตรงหลังบวกลบหลายชั้น', () => {
    const line = ledgerLineOf({
      chargeId: 'c1',
      amount: '333.33',
      allocated: ['111.11', '111.11'],
      adjustments: ['0.10', '-0.03'],
    });

    // 333.33 − 222.22 + 0.07
    expect(line.outstanding).toBe('111.18');
  });
});

describe('WO-2.5-D — สรุปทั้งก๊วน', () => {
  const entries = [
    { chargeId: 'a', amount: '200.00', allocated: ['200.00'], adjustments: [] },
    { chargeId: 'b', amount: '200.00', allocated: [], adjustments: [] },
    { chargeId: 'c', amount: '200.00', allocated: ['200.00'], adjustments: ['-50.00'] },
  ];

  it('🔴 ค้างจ่ายกับเงินที่ต้องคืน **ไม่หักกลบกัน**', () => {
    const summary = summarize(entries);

    expect(summary.outstanding).toBe('200.00'); // b
    expect(summary.credit).toBe('-50.00'); // c
    expect(summary.charged).toBe('600.00');
    expect(summary.allocated).toBe('400.00');
    expect(summary.adjusted).toBe('-50.00');
  });

  it('ไม่มีอะไรเลย → ทุกยอดเป็น 0.00 ไม่ใช่ค่าว่าง', () => {
    const summary = summarize([]);
    expect(summary).toMatchObject({
      charged: '0.00',
      allocated: '0.00',
      adjusted: '0.00',
      outstanding: '0.00',
      credit: '0.00',
    });
  });
});

describe('WO-2.5-D — ตรวจรายการปรับยอดก่อนเขียน', () => {
  const base = { reason: 'มาไม่ทัน', allocated: '200.00', existingAdjustments: [] as string[] };

  it('refund ปกติผ่าน', () => {
    expect(validateAdjustment({ ...base, type: 'refund', amount: '-50.00' })).toEqual([]);
  });

  it('🔴 refund/credit ที่เป็นยอดบวก → ไม่ผ่าน (ตั้งใจคืนแต่หนี้เพิ่ม)', () => {
    expect(validateAdjustment({ ...base, type: 'refund', amount: '50.00' })).toHaveLength(1);
    expect(validateAdjustment({ ...base, type: 'credit', amount: '50.00' })).toHaveLength(1);
  });

  it('correction เป็นบวกหรือลบก็ได้', () => {
    expect(validateAdjustment({ ...base, type: 'correction', amount: '30.00' })).toEqual([]);
    expect(validateAdjustment({ ...base, type: 'correction', amount: '-30.00' })).toEqual([]);
  });

  it('🔴 คืนเงินเกินยอดที่จ่ายมาแล้ว → ไม่ผ่าน', () => {
    expect(validateAdjustment({ ...base, type: 'refund', amount: '-250.00' })).toHaveLength(1);

    // รวมกับที่เคยคืนไปแล้วต้องไม่เกินเช่นกัน
    expect(
      validateAdjustment({
        ...base,
        type: 'refund',
        amount: '-100.00',
        existingAdjustments: ['-150.00'],
      }),
    ).toHaveLength(1);
  });

  it('ยอด 0 หรือไม่มีเหตุผล → ไม่ผ่าน', () => {
    expect(validateAdjustment({ ...base, type: 'refund', amount: '0.00' })).toHaveLength(1);
    expect(
      validateAdjustment({ ...base, type: 'refund', amount: '-10.00', reason: '  ' }),
    ).toHaveLength(1);
  });
});
