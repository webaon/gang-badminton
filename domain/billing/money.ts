/**
 * เงิน — เก็บและคำนวณเป็น **จำนวนเต็มสตางค์** เสมอ
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ทำไมไม่ใช้ number บาท
 *
 * JS number เป็น IEEE-754 ⇒ `0.1 + 0.2 !== 0.3` และ `150.55 * 3` ได้ค่าที่มี
 * เศษหลงเหลือ การหารเงินแล้วปัดเศษด้วย float จะทำให้ยอดรวมไม่ตรงกับต้นทุนจริง
 * แบบสุ่มๆ ซึ่งเป็นสิ่งที่ invariant ของ baseline ห้ามไว้ตรงๆ
 *
 * ⇒ แปลงเป็นจำนวนเต็มสตางค์ตั้งแต่ขอบระบบ คำนวณด้วยเลขจำนวนเต็มล้วน
 *   แล้วค่อยแปลงกลับเป็น string ตอนเขียนลง `numeric(12,2)`
 *
 * CLAUDE.md §2.6: "เงินทุกคอลัมน์ DECIMAL — ห้าม float"
 */

/** จำนวนเต็มสตางค์ (100 สตางค์ = 1 บาท) */
export type Satang = number;

const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;

/**
 * `'150.50'` → `15050`
 *
 * รับเฉพาะรูปแบบที่ตรงกับ `numeric(12,2)` — ทศนิยมไม่เกิน 2 ตำแหน่ง
 * ⚠️ ห้ามรับ number เข้ามา เพราะค่าที่ผ่าน float มาแล้วอาจเพี้ยนตั้งแต่ต้นทาง
 */
export function toSatang(amount: string): Satang {
  const raw = amount.trim();

  if (!MONEY_RE.test(raw)) {
    throw new Error(`จำนวนเงินไม่ถูกต้อง: "${amount}" (ต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง)`);
  }

  const negative = raw.startsWith('-');
  const [baht, fraction = ''] = raw.replace('-', '').split('.');
  const satang = Number(baht) * 100 + Number(fraction.padEnd(2, '0'));

  return negative ? -satang : satang;
}

/** `15050` → `'150.50'` — รูปแบบที่เขียนลง `numeric(12,2)` ได้ตรงๆ */
export function fromSatang(satang: Satang): string {
  if (!Number.isInteger(satang)) {
    throw new Error(`สตางค์ต้องเป็นจำนวนเต็ม: ${satang}`);
  }

  const negative = satang < 0;
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');

  return `${negative ? '-' : ''}${baht}.${fraction}`;
}

/** รวมยอด — มีไว้ให้อ่านง่ายและกันเผลอ reduce ผิด */
export function sumSatang(amounts: readonly Satang[]): Satang {
  return amounts.reduce((total, amount) => total + amount, 0);
}
