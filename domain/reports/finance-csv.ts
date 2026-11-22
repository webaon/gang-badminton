/**
 * ตัวแปลงรายงานการเงินเป็น CSV — **[WO-6.8, #38, planner อนุมัติ]**
 *
 * pure function ล้วน — `domain/` ห้าม import next/react/supabase (CLAUDE.md) ⇒ แยกจาก
 * `server/actions/finance-report.ts` ที่เรียก `financeReport()` จริง เพื่อให้เทสต์ unit ได้
 * โดยไม่ต้องมี DB
 *
 * กฎ CSV (ตามที่ planner อนุมัติ):
 * 1. ทุก field ครอบด้วย `"..."` เสมอ (กันคอมม่าในข้อความ/ตัวเลขชนกับ delimiter)
 * 2. escape `"` เป็น `""` ภายใน field
 * 3. กัน CSV/formula injection: field **ข้อความ** (title/category/note/kind) ที่ค่าขึ้นต้นด้วย
 *    `= + - @ \t \r` ต้องเติม `'` นำหน้าก่อน escape — **field เงินห้ามแตะเด็ดขาด** เพราะเงินติดลบ
 *    ต้องขึ้นต้นด้วย `-` ตามจริงจาก DB (ไม่ใช่ความเสี่ยง เป็นตัวเลขที่คำนวณในระบบเราเอง ไม่ใช่ input ผู้ใช้)
 * 4. BOM (`\uFEFF`) นำหน้าทั้งไฟล์ + CRLF ทุกบรรทัด — Excel ภาษาไทยต้องการทั้งคู่ไม่งั้นอักขระมั่ว
 * 5. เงินทุกค่า = string ตรงจาก DB (`financeReport()` คืนมายังไงใส่ไปตรงนั้น) ห้าม parseFloat/toFixed
 *    ที่นี่เด็ดขาด — ไม่ใช่สูตรใหม่ แค่ serialize ของเดิม
 * 6. ห้ามมีคำว่า "กำไร" ในหัวคอลัมน์หรือที่ไหนในไฟล์เลย (กฎเดิมของทั้งระบบ) — ใช้ "เงินสดสุทธิ"
 */

const BOM = '\uFEFF';
const CRLF = '\r\n';

/** ขึ้นต้นด้วยอักขระที่ Excel/Sheets อาจตีความเป็นสูตร → ต้องเติม `'` กันก่อน escape เครื่องหมายคำพูด */
const INJECTION_PREFIX = /^[=+\-@\t\r]/;

/** field ข้อความทั่วไป (title/category/note/kind/หัวคอลัมน์) — กัน formula injection ก่อน escape */
export function csvTextField(value: string | null | undefined): string {
  const raw = value ?? '';
  const guarded = INJECTION_PREFIX.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** field เงิน/ตัวเลขดิบจาก DB — escape เครื่องหมายคำพูดเท่านั้น ห้ามเติม `'` แม้ขึ้นต้นด้วย `-` */
export function csvMoneyField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export type FinanceCsvSummary = {
  from: string;
  to: string;
  charged: string;
  actualCost: string;
  collected: string;
  outstanding: string;
  transferIn: string;
  refunds: string;
  overpaymentIn: string;
  otherIncome: string;
  expense: string;
  memberPayouts: string;
  netCash: string;
  roundingSurplus: string;
};

export type FinanceCsvSession = {
  sessionTitle: string;
  sessionDate: string | null;
  amount: string;
};

export type FinanceCsvEntry = {
  kind: 'income' | 'expense';
  category: string;
  note: string | null;
  occurredOn: string;
  amount: string;
};

const SUMMARY_HEADERS = [
  'ช่วงวันที่',
  'ยอดเรียกเก็บ',
  'ต้นทุนจริง',
  'เก็บได้แล้ว',
  'ค้างเก็บ',
  'เงินโอนเข้า',
  'เงินคืน',
  'โอนเกินเข้าเครดิต',
  'รายรับอื่น',
  'รายจ่าย',
  'จ่ายคืนสมาชิก',
  'เงินสดสุทธิ',
  'เศษจากปัดขึ้น',
] as const;

const SESSION_HEADERS = ['นัด', 'วันที่', 'เงินเข้า'] as const;
const ENTRY_HEADERS = ['ประเภท', 'หมวด', 'หมายเหตุ', 'วันที่เกิดรายการ', 'จำนวนเงิน'] as const;

/** รวมแปลงรายงานการเงิน 1 ช่วงเวลาเป็น CSV 3 ส่วน (คั่นด้วยบรรทัดว่าง) — ข้อมูลทั้งหมดมาจาก
 *  `financeReport()` เดิมที่เรียกไว้แล้ว ไม่มีการคำนวณใหม่ที่นี่เลย */
export function buildFinanceReportCsv(
  summary: FinanceCsvSummary,
  sessions: readonly FinanceCsvSession[],
  entries: readonly FinanceCsvEntry[],
): string {
  const lines: string[] = [];

  lines.push(SUMMARY_HEADERS.map(csvTextField).join(','));
  lines.push(
    [
      csvTextField(`${summary.from} ถึง ${summary.to}`),
      csvMoneyField(summary.charged),
      csvMoneyField(summary.actualCost),
      csvMoneyField(summary.collected),
      csvMoneyField(summary.outstanding),
      csvMoneyField(summary.transferIn),
      csvMoneyField(summary.refunds),
      csvMoneyField(summary.overpaymentIn),
      csvMoneyField(summary.otherIncome),
      csvMoneyField(summary.expense),
      csvMoneyField(summary.memberPayouts),
      csvMoneyField(summary.netCash),
      csvMoneyField(summary.roundingSurplus),
    ].join(','),
  );
  lines.push('');

  lines.push(SESSION_HEADERS.map(csvTextField).join(','));
  for (const s of sessions) {
    lines.push([csvTextField(s.sessionTitle), csvTextField(s.sessionDate ?? ''), csvMoneyField(s.amount)].join(','));
  }
  lines.push('');

  lines.push(ENTRY_HEADERS.map(csvTextField).join(','));
  for (const e of entries) {
    lines.push(
      [
        csvTextField(e.kind === 'income' ? 'รายรับอื่น' : 'รายจ่าย'),
        csvTextField(e.category),
        csvTextField(e.note ?? ''),
        csvTextField(e.occurredOn),
        csvMoneyField(e.amount),
      ].join(','),
    );
  }

  return BOM + lines.join(CRLF);
}
