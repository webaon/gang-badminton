/**
 * Matching Engine — ชนิดข้อมูล
 *
 * 🔴 pure TypeScript — ห้าม import framework และ **ห้ามอ่าน DB จากใน engine**
 *    engine รับ data ล้วนเข้ามา แล้วคืนแผนออกไป (baseline §สถาปัตยกรรม)
 *    ⇒ unit test ได้เต็มโดยไม่ต้อง mock อะไรเลย
 *
 * ⚠️ baseline บรรทัด 65 เขียนว่า Matching Engine อยู่ที่ `lib/matching/` แต่
 *    §Folder Structure ของเอกสารเดียวกันเขียน `domain/matching/` — ใช้อันหลัง
 *    เพราะเป็น pure logic ที่ต้อง test ได้โดยไม่พึ่ง runtime (บันทึกใน WO-2.6)
 */

export type MatchPlayer = {
  /** อ้าง `session_registrations.id` ⇒ guest ลงเกมได้เหมือนสมาชิก */
  registrationId: string;
  /**
   * ระดับฝีมือจาก `gang_skill_levels.rank` (เลขน้อย = มือใหม่)
   * `null` = ก๊วนยังไม่จัดระดับให้คนนี้
   */
  skillRank: number | null;
  /** จำนวนเกมที่เล่นไปแล้วในนัดนี้ */
  gamesPlayed: number;
  /**
   * ลำดับการรอ — **เลขน้อย = รอนานกว่า**
   * ใช้เวลาที่จบเกมล่าสุด (epoch ms) หรือเวลาที่ลงชื่อสำหรับคนที่ยังไม่ได้เล่น
   */
  waitingSince: number;
};

/** สี่คนที่จะลงเล่นด้วยกัน — เรียงตามที่ engine จัด */
export type Foursome = readonly [string, string, string, string];

export type PlannedGame = {
  courtNo: number;
  players: Foursome;
};

export type MatchPlan = {
  games: PlannedGame[];
  /** คนที่ยังไม่ได้ลงรอบนี้ — รอบหน้าจะได้คิวก่อนเพราะ gamesPlayed น้อยกว่า */
  benched: string[];
};

export type MatchInput = {
  players: readonly MatchPlayer[];
  /** จำนวนคอร์ทที่ว่างอยู่ */
  availableCourts: number;
  /**
   * กลุ่มผู้เล่นของเกมล่าสุด (ใหม่สุดอยู่หน้า) — ใช้กันจับคู่ซ้ำชุดเดิม
   * ส่งมาเท่าที่อยากให้ engine จำ เช่น 10 เกมหลังสุด
   */
  recentGames?: readonly (readonly string[])[];
};
