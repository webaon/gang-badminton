/**
 * เวลาพักของคนในคิว (hi-fi 27) — pure
 *
 * 🔴 ที่นี่ **ไม่จัดคิว/ไม่จัดคู่** — ลำดับคิวมาจาก server ตามเดิม (`session_console_queue()`)
 *    และการจับคู่อยู่ `domain/matching` · ไฟล์นี้แค่แปลง `waiting_since` (เวลาจบเกมล่าสุด หรือเวลาเช็คอิน
 *    ถ้ายังไม่เคยเล่น) เป็นนาทีที่พักมาแล้ว เพื่อแสดงผลและเน้นคนที่พักนานสุด
 *
 * ไม่อ่านนาฬิกาเอง — รับ `now` เข้ามาเสมอ (server ส่งเวลา render มาให้ ⇒ SSR/hydrate ตรงกัน เทสต์ได้)
 */

/** พักตั้งแต่กี่นาทีถือว่า "พักนาน" — ใช้ทั้งป้ายและสีแถบ (hi-fi 27 ใช้ 20 นาที) */
export const REST_LONG_MINUTES = 20;

/** แถบความยาวเต็มที่กี่นาที (hi-fi: นาที × 3.4% ⇒ เต็มที่ ~30 นาที) */
const REST_BAR_FULL_MINUTES = 30;

export type RestRow = { registrationId: string; waitingSince: string };

/** นาทีที่พักมาแล้ว (ปัดลง · ไม่ติดลบ · เวลาเสีย/ว่าง = 0) */
export function restMinutes(waitingSince: string | null | undefined, now: string): number {
  if (!waitingSince) return 0;
  const since = Date.parse(waitingSince);
  const current = Date.parse(now);
  if (Number.isNaN(since) || Number.isNaN(current)) return 0;
  return Math.max(0, Math.floor((current - since) / 60_000));
}

export function isLongRest(minutes: number): boolean {
  return minutes >= REST_LONG_MINUTES;
}

/** ข้อความไทย — "พักมา 5 นาที" · ไม่ถึงนาที = "เพิ่งพัก" · เกิน 1 ชม. = "พักมา 1 ชม. 5 นาที" */
export function formatRest(minutes: number): string {
  if (minutes < 1) return 'เพิ่งพัก';
  if (minutes < 60) return `พักมา ${minutes} นาที`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `พักมา ${hours} ชม.` : `พักมา ${hours} ชม. ${rest} นาที`;
}

/** ความยาวแถบ 0–100 (เต็มที่ ~30 นาที) */
export function restBarPercent(minutes: number): number {
  return Math.min(100, Math.round((minutes / REST_BAR_FULL_MINUTES) * 100));
}

/**
 * คนที่พักนานสุด (ตามเวลาที่เลยมา) — null ถ้าไม่มีใคร หรือทุกคนเพิ่งพัก (0 นาที)
 * เสมอกัน = คนแรกตามลำดับที่ server ส่ง (ไม่สลับลำดับคิว)
 */
export function longestRest(rows: readonly RestRow[], now: string): { registrationId: string; minutes: number } | null {
  let best: { registrationId: string; minutes: number } | null = null;
  for (const row of rows) {
    const minutes = restMinutes(row.waitingSince, now);
    if (minutes >= 1 && (!best || minutes > best.minutes)) best = { registrationId: row.registrationId, minutes };
  }
  return best;
}

export type CourtSlot<G> = { courtNo: number; game: G | null };

/** คอร์ท 1..N พร้อมเกมที่กำลังเล่น (หรือ null = ว่าง) — เกมที่เลขคอร์ทเกินจำนวนคอร์ทไม่ถูกทิ้ง */
export function courtSlots<G extends { courtNo: number }>(courtCount: number, games: readonly G[]): CourtSlot<G>[] {
  const byCourt = new Map<number, G>(games.map((g) => [g.courtNo, g]));
  const numbers = new Set<number>(Array.from({ length: Math.max(0, courtCount) }, (_, i) => i + 1));
  for (const g of games) numbers.add(g.courtNo);
  return [...numbers].sort((a, b) => a - b).map((courtNo) => ({ courtNo, game: byCourt.get(courtNo) ?? null }));
}
