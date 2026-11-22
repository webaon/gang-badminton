/**
 * Unit tests for `buildFinanceReportCsv()` / `csvTextField()` / `csvMoneyField()` — pure,
 * no DB. **[WO-6.8, #38, planner อนุมัติ]**
 */
import { describe, expect, it } from 'vitest';
import { buildFinanceReportCsv, csvMoneyField, csvTextField } from '@/domain/reports/finance-csv';

const baseSummary = {
  from: '2026-07-01',
  to: '2026-07-31',
  charged: '14820.00',
  actualCost: '14734.00',
  collected: '13380.00',
  outstanding: '1440.00',
  transferIn: '13380.00',
  refunds: '0.00',
  overpaymentIn: '0.00',
  otherIncome: '0.00',
  expense: '2950.00',
  memberPayouts: '0.00',
  netCash: '10430.00',
  roundingSurplus: '86.00',
};

describe('csvTextField()', () => {
  it('🔴 ครอบด้วย "..." เสมอ', () => {
    expect(csvTextField('นัดทดสอบ')).toBe('"นัดทดสอบ"');
  });

  it('🔴 escape " เป็น "" ภายใน field', () => {
    expect(csvTextField('บอก "ยกเลิก" แล้ว')).toBe('"บอก ""ยกเลิก"" แล้ว"');
  });

  it('🔴 null/undefined → ""', () => {
    expect(csvTextField(null)).toBe('""');
    expect(csvTextField(undefined)).toBe('""');
  });

  it.each(['=cmd|/C calc', '+1+1', '-2+3+cmd', '@SUM(A1)', '\ttab-prefixed', '\rcr-prefixed'])(
    '🔴 [planner] formula injection guard — ค่าที่ขึ้นต้นด้วยอักขระเสี่ยง (%s) ต้องเติม \' นำหน้าก่อน escape',
    (dangerous) => {
      expect(csvTextField(dangerous)).toBe(`"'${dangerous.replace(/"/g, '""')}"`);
    },
  );

  it('🔴 ข้อความปกติที่ไม่ขึ้นต้นด้วยอักขระเสี่ยง ต้องไม่ถูกเติม \' โดยไม่จำเป็น', () => {
    expect(csvTextField('ค่าสนาม')).toBe('"ค่าสนาม"');
  });
});

describe('csvMoneyField()', () => {
  it('🔴 [planner] ห้ามเติม \' แม้ค่าขึ้นต้นด้วย - (เงินติดลบจริงจาก DB)', () => {
    expect(csvMoneyField('-150.00')).toBe('"-150.00"');
  });

  it('🔴 escape " เท่านั้น ไม่แตะเครื่องหมาย/ตัวเลขอื่น', () => {
    expect(csvMoneyField('1,702.00')).toBe('"1,702.00"');
  });

  it('🔴 string ตรงจาก DB เป๊ะ — ไม่มี parseFloat/toFixed แปลงรูปแบบ', () => {
    expect(csvMoneyField('99999999999999999.01')).toBe('"99999999999999999.01"');
  });
});

describe('buildFinanceReportCsv()', () => {
  const csv = buildFinanceReportCsv(baseSummary, [
    { sessionTitle: 'นัดทดสอบ 30 ก.ค.', sessionDate: '2026-07-30T12:00:00Z', amount: '1702.00' },
  ], [
    { kind: 'expense', category: 'ลูกแบด', note: 'ยกโหล x3', occurredOn: '2026-07-12', amount: '2100.00' },
  ]);

  it('🔴 [planner] ต้องนำหน้าด้วย BOM (\\uFEFF)', () => {
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('🔴 [planner] ทุกบรรทัดคั่นด้วย CRLF ไม่ใช่ LF เดี่ยว', () => {
    const withoutBom = csv.slice(1);
    expect(withoutBom).toContain('\r\n');
    // ไม่มี \n ที่ไม่มี \r นำหน้า (ไม่ใช่ LF เดี่ยวหลุดมา)
    expect(withoutBom.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('🔴 [planner] เงินในรายงานต้องตรงกับ string จาก financeReport() ทุกตัว เป๊ะๆ ไม่แปลง', () => {
    expect(csv).toContain('"14820.00"'); // charged
    expect(csv).toContain('"14734.00"'); // actualCost
    expect(csv).toContain('"10430.00"'); // netCash
    expect(csv).toContain('"1702.00"'); // cashInBySession
    expect(csv).toContain('"2100.00"'); // entries
  });

  it('🔴 [planner] หัวคอลัมน์ต้องไม่มีคำว่า "กำไร" เลยทั้งไฟล์ — ใช้ "เงินสดสุทธิ" แทน', () => {
    expect(csv).not.toContain('กำไร');
    expect(csv).toContain('เงินสดสุทธิ');
  });

  it('🔴 มี 3 ส่วนคั่นด้วยบรรทัดว่าง — สรุป / เงินเข้าแยกตามนัด / รายรับ-รายจ่ายอื่น', () => {
    expect(csv).toContain('นัด');
    expect(csv).toContain('วันที่เกิดรายการ');
    expect(csv).toContain('นัดทดสอบ 30 ก.ค.');
    expect(csv).toContain('ลูกแบด');
  });

  it('🔴 ก๊วนที่ไม่มีรายการ session/entry เลย ต้องไม่ throw — คืน CSV ที่มีแค่หัวคอลัมน์ 2 ส่วนหลัง', () => {
    const empty = buildFinanceReportCsv(baseSummary, [], []);
    expect(empty.startsWith('\uFEFF')).toBe(true);
    expect(empty).toContain('เงินเข้า');
  });
});
