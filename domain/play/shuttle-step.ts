/**
 * ปุ่ม − / + ของ "ลูกที่ใช้" (hi-fi 26) — pure
 *
 * 🔴 แค่ขยับตัวเลขในช่อง **ไม่คิดเงิน ไม่ตัดสินว่าลูกกี่ลูกถูก** — ค่าสุดท้ายถูก server ตรวจซ้ำ
 *    (`finishGame` / `updateGameShuttles`) · ค่าที่พิมพ์ไม่เป็นตัวเลข เริ่มนับจาก 0
 */

/** ค่าสูงสุดที่ปุ่ม + พาไปถึง — กันกดค้างจนค่าเพี้ยน (server ยังเป็นด่านจริง) */
export const SHUTTLE_STEP_MAX = 99;

export function stepShuttles(value: string, delta: number): string {
  const parsed = Number(value.trim().replace(',', '.'));
  const base = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const next = Math.min(SHUTTLE_STEP_MAX, Math.max(0, base + delta));
  // กัน 0.1+0.2 แบบ float · ตัดศูนย์ท้าย ("2" ไม่ใช่ "2.0")
  return String(Math.round(next * 100) / 100);
}
