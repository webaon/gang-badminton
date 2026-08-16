/**
 * ตัวเลขระดับแพลตฟอร์มสำหรับหน้าแรก — **[WO-3.F]**
 *
 * 🔴 อ่านจาก `daily_metrics` (rollup ของ WO-3.A) **เท่านั้น**
 *    ❌ ห้าม query ตารางธุรกรรมสดมาบวกเองในหน้าแรก — สองแหล่งความจริงแล้วเลขไม่ตรงกับรายงาน
 *    (และหน้าแรกเป็น static/ISR ⇒ การนับสดจะกลายเป็นงานหนักที่รันตอน build ทุกครั้ง)
 *
 * ⚠️ **ไม่มี `revenue` ในสรุปนี้โดยตั้งใจ** — `daily_metrics.revenue` เป็นยอดเงินรวม
 *    ของทั้งแพลตฟอร์ม ซึ่งไม่ควรโชว์ให้คนนอกเห็นบนหน้าแรก (ตัวเลขนี้ยังอยู่ในตาราง
 *    ให้แดชบอร์ดภายในใช้ได้เหมือนเดิม)
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework
 */

/** หนึ่งแถวของ `daily_metrics` เท่าที่หน้าแรกต้องใช้ */
export type DailyMetricRow = {
  /** `metric_date` — วันตามนาฬิกาไทย (WO-3.A ตรึงไว้แล้ว) */
  metricDate: string;
  newMembers: number;
  gamesPlayed: number;
  sessionsHeld: number;
};

export type PlatformHighlights = {
  /** จำนวนวันที่มีข้อมูล (ไม่ใช่ช่วงที่ขอ — วันที่ยังไม่ rollup จะไม่มีแถว) */
  days: number;
  newMembers: number;
  gamesPlayed: number;
  sessionsHeld: number;
  /** วันล่าสุดที่มีข้อมูล — ใช้บอกผู้อ่านว่าตัวเลขสดแค่ไหน */
  latestDate: string | null;
};

/** ค่าที่ไม่ใช่จำนวนเต็มบวก = ข้อมูลเพี้ยน ⇒ นับเป็น 0 ดีกว่าโชว์เลขติดลบบนหน้าแรก */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function summarizePlatformMetrics(
  rows: readonly DailyMetricRow[],
): PlatformHighlights {
  let newMembers = 0;
  let gamesPlayed = 0;
  let sessionsHeld = 0;
  let latestDate: string | null = null;

  for (const row of rows) {
    newMembers += count(row.newMembers);
    gamesPlayed += count(row.gamesPlayed);
    sessionsHeld += count(row.sessionsHeld);

    if (latestDate === null || row.metricDate > latestDate) latestDate = row.metricDate;
  }

  return { days: rows.length, newMembers, gamesPlayed, sessionsHeld, latestDate };
}

/** มีอะไรให้โชว์จริงไหม — ทุกช่องเป็น 0 = ยังไม่ต้องขึ้นบล็อกตัวเลขบนหน้าแรก */
export function hasHighlights(highlights: PlatformHighlights): boolean {
  return highlights.newMembers > 0 || highlights.gamesPlayed > 0 || highlights.sessionsHeld > 0;
}
