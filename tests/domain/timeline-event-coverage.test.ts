/**
 * WO-6.5c — drift detector: every real `event_logs.event_type` literal ever
 * INSERTed by a migration must have a `DESCRIPTORS` entry in
 * `domain/reports/timeline.ts`, or it silently falls back to generic
 * "เหตุการณ์: xxx" text forever (not wrong, just not translated).
 *
 * Built because the planner-approved grep (31 ต.ค. 2026) found the existing
 * DESCRIPTORS had THREE stale keys that never matched any real event_type
 * at all ('registration.created', 'game.substituted',
 * 'session.charges_committed' — kept here deliberately, see timeline.ts) and
 * 23 real event types with zero descriptor. This test is the regression
 * guard so a FUTURE new event type doesn't silently join that list.
 *
 * Parses `insert into public.event_logs (<cols>) values (<tuple>)` blocks by
 * locating the `event_type` column's positional index, then reading the
 * following values tuple for literal(s) at that position — including the
 * `case when ... then 'a' else 'b' end` form (two literals). This is the
 * same style of "find real code, not an assumption" test as
 * tests/security/permission-context-coverage.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(root, 'supabase/migrations');

function allRealEventTypes(): Set<string> {
  const found = new Set<string>();
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

  for (const file of files) {
    const text = readFileSync(join(migrationsDir, file), 'utf8');
    const insertRe = /insert into public\.event_logs\s*\(([^)]*)\)\s*(?:select|values)\s*/gi;
    for (let m = insertRe.exec(text); m; m = insertRe.exec(text)) {
      const cols = m[1].split(',').map((c) => c.trim());
      const idx = cols.indexOf('event_type');
      if (idx < 0) continue;

      // อ่านหน้าต่างสั้นๆหลัง match เพื่อหา tuple ของค่าแรก — พอสำหรับโครงสร้าง SQL จริงของโปรเจกต์นี้
      const tail = text.slice(m.index, m.index + 1200);
      // รองรับทั้ง literal ตรงๆ และ `case when ... then 'a' else 'b' end`
      const caseMatch = /case\s+when[\s\S]*?then\s*'([a-z_]+\.[a-z_]+)'[\s\S]*?else\s*'([a-z_]+\.[a-z_]+)'\s+end/i.exec(tail);
      if (caseMatch) {
        found.add(caseMatch[1]);
        found.add(caseMatch[2]);
        continue;
      }
      // literal ตรงๆ: ไล่ tuple ตามลำดับคอลัมน์แบบหยาบๆ (คอลัมน์ก่อนหน้าทุกตัวในโปรเจกต์นี้เป็น
      // ตัวแปร/พารามิเตอร์ ไม่ใช่ string literal ⇒ literal แรกที่เจอในวงเล็บ = event_type เสมอ)
      const literalMatch = /\(\s*[\s\S]*?'([a-z_]+\.[a-z_]+)'/i.exec(tail);
      if (literalMatch) found.add(literalMatch[1]);
    }
  }
  return found;
}

describe('WO-6.5c — DESCRIPTORS covers every real event_logs.event_type (no DB)', () => {
  it('🔴 every event_type literal INSERTed anywhere in supabase/migrations/*.sql has a DESCRIPTORS entry', async () => {
    const { DESCRIPTORS_FOR_TEST } = await import('@/domain/reports/timeline');
    const real = allRealEventTypes();
    // sanity: กันกรณี regex พัง (match 0 แล้วเทสต์นี้ผ่านปลอมๆ)
    expect(real.size).toBeGreaterThan(30);

    const missing = Array.from(real).filter((t) => !(t in DESCRIPTORS_FOR_TEST));
    expect(
      missing,
      'event_type เหล่านี้ insert จริงใน DB แต่ไม่มี DESCRIPTORS เลย — เพิ่มใน domain/reports/timeline.ts',
    ).toEqual([]);
  });

  it('stale legacy keys (never matched any real event_type, kept intentionally) are still exactly these three', async () => {
    const { DESCRIPTORS_FOR_TEST } = await import('@/domain/reports/timeline');
    const real = allRealEventTypes();
    const staleKnown = ['registration.created', 'game.substituted', 'session.charges_committed'];
    const stale = Object.keys(DESCRIPTORS_FOR_TEST).filter((k) => !real.has(k));
    expect(stale.sort()).toEqual(staleKnown.sort());
  });
});
