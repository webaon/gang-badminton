/**
 * ตัดสินใจว่าจะ sync หน้าจอด้วย realtime หรือ polling
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 baseline: "opt-in เฉพาะหน้า game day console + waitlist,
 *    degrade เป็น polling ทุก 10 วิอัตโนมัติ"
 *
 * เหตุผลที่ต้องมี fallback: realtime ของ Supabase free tier มีเพดาน connection
 * และถูกปิดได้ในบาง environment ⇒ ถ้าหน้าจอพึ่ง realtime อย่างเดียว
 * กระดานคิวจะค้างโดยไม่มีใครรู้ ซึ่งแย่กว่าอัปเดตช้า
 *
 * แยกเป็น pure function เพื่อ **พิสูจน์ด้วย unit test ได้ว่า fallback ทำงานจริง**
 * — DoD ของ WO-2.5 บังคับข้อนี้ ("ไม่ใช่เขียนไว้เฉยๆ")
 */

export const POLL_INTERVAL_MS = 10_000;

/** เวลารอ realtime ก่อนยอมแพ้แล้วหันไป polling */
export const REALTIME_GRACE_MS = 5_000;

/** สถานะที่ Supabase realtime channel รายงานกลับมา */
export type RealtimeState = 'connecting' | 'subscribed' | 'closed' | 'error' | 'disabled';

export type SyncMode = 'realtime' | 'polling';

/**
 * โหมดที่ควรใช้ ณ ขณะนั้น
 *
 * @param state       สถานะล่าสุดของ channel
 * @param elapsedMs   เวลาที่ผ่านไปตั้งแต่เริ่มพยายามต่อ
 */
export function syncMode(state: RealtimeState, elapsedMs: number): SyncMode {
  // ต่อติดแล้ว = ใช้ realtime ล้วน ไม่ต้อง poll ซ้ำซ้อน
  if (state === 'subscribed') return 'realtime';

  // ปิดไว้ / ต่อไม่ได้ / หลุด = polling ทันที ไม่ต้องรอ
  if (state === 'disabled' || state === 'error' || state === 'closed') return 'polling';

  // ยังต่ออยู่ — ให้เวลาพอสมควรก่อนยอมแพ้ เพื่อไม่ให้ยิง request ถี่โดยไม่จำเป็น
  return elapsedMs >= REALTIME_GRACE_MS ? 'polling' : 'realtime';
}

/** ควรยิง request ซ้ำหรือยัง — คืน interval (ms) หรือ null ถ้าไม่ต้อง poll */
export function pollIntervalFor(mode: SyncMode): number | null {
  return mode === 'polling' ? POLL_INTERVAL_MS : null;
}
