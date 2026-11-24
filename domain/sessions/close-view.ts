/**
 * มุมมองหน้าปิดรอบ (hi-fi 28) — pure
 *
 * 🔴 ที่นี่ **ไม่คิดเงินเลย** — ตัวเลขทุกตัวมาจาก `previewSessionCharges()` (ซึ่งเรียก
 *    `calculateSessionCharges()` ตัวเดียวกับตอนปิดรอบจริง) เป็น string แล้ว · ไฟล์นี้ทำแค่
 *    "แปลงเหตุผลเป็นข้อความ/โทนสี" กับ "จัดรูปตัวเลขที่เป็น string" (คั่นหลักพัน) ด้วยการแก้ string เท่านั้น
 *    ไม่แปลงเป็น number ไม่บวก/ลบ/คูณ — กัน UI ตัดสินยอดต่างจาก server
 */

export type ReasonTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

type ReasonView = { label: string; tone: ReasonTone };

/** เหตุผลจาก `chargeReason()` / `reasonWhenFree()` — แปลเป็นภาษาคนที่จุดแสดงผลจุดเดียว */
const REASONS: Record<string, ReasonView> = {
  attended: { label: 'มาเล่น (เช็คอินแล้ว)', tone: 'success' },
  no_check_in: { label: 'ได้ที่แต่ไม่ได้เช็คอิน', tone: 'warning' },
  no_show: { label: 'ไม่มา', tone: 'error' },
  late_cancel: { label: 'ยกเลิกช้ากว่ากำหนด', tone: 'warning' },
  cancelled_in_time: { label: 'ยกเลิกทันกำหนด', tone: 'neutral' },
  waitlist: { label: 'อยู่ในคิวรอ', tone: 'neutral' },
  monthly_member: { label: 'สมาชิกรายเดือน', tone: 'info' },
  not_charged: { label: 'ไม่ถูกเก็บ', tone: 'neutral' },
};

/** เหตุผลที่ไม่รู้จัก (server เพิ่มใหม่ทีหลัง) ไม่โชว์รหัสดิบ — ใช้ข้อความกลาง */
export function reasonView(reason: string): ReasonView {
  return REASONS[reason] ?? { label: 'ตามเงื่อนไขของก๊วน', tone: 'neutral' };
}

/**
 * จัดรูป "1700.50" → "1,700.50" ด้วยการแก้ string — ไม่แปลงเป็นตัวเลข
 * ค่าที่ไม่ใช่รูปทศนิยมธรรมดา (เช่น "-5.00" รับ, "abc" ไม่รับ) คืนตามเดิม ไม่ขึ้น NaN
 */
export function groupAmount(amount: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(amount.trim());
  if (!match) return amount;
  const [, sign, whole, fraction = ''] = match;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`;
}

/** "฿1,700.00" — ใช้กับทุกที่ที่โชว์เงินบนหน้าปิดรอบ */
export function baht(amount: string): string {
  const grouped = groupAmount(amount);
  return grouped.startsWith('-') ? `-฿${grouped.slice(1)}` : `฿${grouped}`;
}

/** KPI ลูก/เศษปัดมีความหมายเฉพาะโมเดลที่หารค่าลูกจริง [WO-2.5-B] */
export function hasShuttleSplit(pricingType: string): boolean {
  return pricingType === 'court_plus_shuttle';
}

/** "0.00" / "-0.00" / "0" — เช็คว่าเป็นศูนย์ด้วย string (ไม่แปลงเป็น number) ใช้ตัดสินว่าจะโชว์คอลัมน์/KPI หมวดนั้นไหม */
export function isZeroAmount(amount: string): boolean {
  return /^-?0+(\.0+)?$/.test(amount.trim());
}
