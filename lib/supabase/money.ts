import 'server-only';

/**
 * แปลงค่าเงินที่มาจาก PostgREST ให้เป็น string ของโดเมน
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ทำไมต้องมีตัวนี้
 *
 * `domain/billing/money.ts` **จงใจไม่รับ `number`** (ดูคอมเมนต์ในไฟล์นั้น)
 * แต่ PostgREST serialize คอลัมน์ `numeric` เป็น **JSON number** ไม่ใช่ string
 * ⇒ `supabase.from(...).select('amount')` คืน `200.5` ไม่ใช่ `'200.50'`
 *
 * (ต่างจาก `pg` driver ที่ใช้ในเทสต์ ซึ่งคืน `numeric` เป็น string —
 *  นี่คือเหตุผลที่บั๊กนี้รอดสายตาเทสต์ระดับ DB มาได้)
 *
 * ⇒ ต้องแปลงที่ **ขอบระบบ** ที่เดียว ไม่ใช่ผ่อนกฎของ domain
 *
 * ⚠️ ข้อจำกัดที่ยอมรับ: ค่าที่ผ่าน JSON number มาแล้วต้องอยู่ในช่วงที่ float
 *    แทนค่าได้แม่นยำ — `numeric(12,2)` สูงสุด 10 หลักหน้าจุด ยังห่างจาก
 *    `Number.MAX_SAFE_INTEGER` มาก จึงปลอดภัยสำหรับสเกลของแอปนี้
 */
export function moneyFromDb(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '0.00';
  if (typeof value === 'string') return value.trim();

  if (!Number.isFinite(value)) {
    throw new Error(`จำนวนเงินจากฐานข้อมูลไม่ถูกต้อง: ${value}`);
  }

  return value.toFixed(2);
}
