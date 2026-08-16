import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import {
  summarizePlatformMetrics,
  type DailyMetricRow,
  type PlatformHighlights,
} from '@/domain/reports/platform';

/**
 * ตัวเลขหน้าแรก — **[WO-3.F]**
 *
 * 🔴 อ่าน `daily_metrics` อย่างเดียว (rollup ของ WO-3.A) — ❌ ไม่แตะตารางธุรกรรมสด
 *
 * ใช้ `supabaseAdmin()` เพราะ `daily_metrics` เป็นตาราง **server-only**
 * (grant matrix: anon/authenticated ไม่มีสิทธิ์อะไรเลย) และหน้าแรกเป็น static/ISR
 * ⇒ ทำงานตอน build / ตอน revalidate บน server เท่านั้น ไม่มีทางหลุดไป browser
 */

export const HIGHLIGHT_DAYS = 30;

/** วันเริ่มช่วง (นาฬิกาไทย เหมือน `metric_date` ที่ WO-3.A ตรึงไว้) */
export function highlightRangeStart(now: Date, days = HIGHLIGHT_DAYS): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return utcToZonedWallClock(start, 'Asia/Bangkok').slice(0, 10);
}

/**
 * คืน `null` เมื่ออ่านไม่ได้ — **ตั้งใจให้หน้าแรกยังขึ้นได้**
 *
 * หน้าแรกถูก prerender ตอน `npm run build` ซึ่งเป็นสภาพแวดล้อมที่อาจไม่มี env ของ
 * Supabase หรือต่อฐานข้อมูลไม่ได้เลย ⇒ ถ้าปล่อย throw จะ build ไม่ผ่านทั้งแอป
 * เพราะตัวเลขประดับหน้าแรกอ่านไม่ได้ ซึ่งไม่คุ้มกันเลย
 *
 * ⚠️ ไม่ได้กลืนเงียบ — log ไว้พร้อมสาเหตุตาม CLAUDE.md §5
 */
export async function platformHighlights(now = new Date()): Promise<PlatformHighlights | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('daily_metrics')
      .select('metric_date, new_members, games_played, sessions_held')
      .gte('metric_date', highlightRangeStart(now))
      .order('metric_date', { ascending: false })
      .limit(HIGHLIGHT_DAYS + 1);

    if (error) throw error;

    type Row = {
      metric_date: string;
      new_members: number;
      games_played: number;
      sessions_held: number;
    };

    const rows: DailyMetricRow[] = ((data ?? []) as Row[]).map((row) => ({
      metricDate: row.metric_date,
      newMembers: row.new_members,
      gamesPlayed: row.games_played,
      sessionsHeld: row.sessions_held,
    }));

    return summarizePlatformMetrics(rows);
  } catch (err) {
    console.warn('[landing] อ่าน daily_metrics ไม่ได้ — แสดงหน้าแรกโดยไม่มีตัวเลข', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
