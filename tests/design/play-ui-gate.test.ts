/**
 * WO-6.4a grep gate — วันเล่น (คอนโซล · กระดานคิวสด · สแกน):
 *   1. ไม่ตัดสินสิทธิ์ด้วย role ตรงๆ (ต้องผ่าน `can()` เท่านั้น)
 *   2. ไม่คิดเงินใน UI (เงินคิดตอนปิดรอบ — domain/billing)
 *   3. component ไม่ import `domain/matching` (การจับคู่อยู่ server action → engine)
 *   4. กระดานคิวสดไม่เปิด realtime channel ใหม่ และใช้ loader/สิทธิ์เดียวกับคอนโซล
 *   5. ไม่มี `<div` / `style={{` / hex ดิบ ในไฟล์หน้าจอใหม่ (Astryx = components, Tailwind = layout เท่านั้น)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const UI_FILES = [
  'features/sessions/GameConsole.tsx',
  'features/sessions/LiveBoard.tsx',
  'features/sessions/BoardSync.tsx',
  'features/sessions/BoardTheme.tsx',
  'features/sessions/ScanCheckin.tsx',
  'features/sessions/CheckinQrButton.tsx',
  'app/gangs/[gangId]/sessions/[sessionId]/console/page.tsx',
  'app/gangs/[gangId]/sessions/[sessionId]/console/board/page.tsx',
  'app/gangs/[gangId]/sessions/[sessionId]/scan/page.tsx',
];

const ALL_FILES = [...UI_FILES, 'domain/play/rest-time.ts', 'domain/play/shuttle-step.ts', 'server/sessions/console-loader.ts'];

/** ตัด comment ออกก่อน — คอมเมนต์ที่อธิบายกติกาไม่ควรทำให้เทสต์ล้ม */
function code(path: string): string {
  const src = readFileSync(join(ROOT, path), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('grep gate: วันเล่น (WO-6.4a)', () => {
  it('ไฟล์ที่ตรวจมีอยู่จริงทุกไฟล์', () => {
    for (const f of ALL_FILES) expect(() => code(f), f).not.toThrow();
  });

  it('ไม่มี `role ===` / `role !==` (ตัดสินสิทธิ์ด้วย can() เท่านั้น)', () => {
    const offenders = ALL_FILES.filter(
      (f) => /\brole\s*[!=]==?\s*['"`]/.test(code(f)) || /['"`]\s*[!=]==?\s*role\b/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('ไม่มีการคิดเงินใน UI (toFixed, ฿, penalty/price/amount)', () => {
    const forbidden = [/toFixed\(/, /฿/, /penalty_?[vV]alue/, /price_?(per|amount)/i, /\bamount\b/i, /บาท/];
    const offenders = ALL_FILES.flatMap((f) => forbidden.filter((re) => re.test(code(f))).map((re) => `${f}: ${re}`));
    expect(offenders).toEqual([]);
  });

  it('component ไม่ import domain/matching', () => {
    const offenders = UI_FILES.filter((f) => /domain\/matching/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('กระดานคิวสด: ไม่เปิด realtime channel ใหม่ + ใช้ loader เดียวกับคอนโซล (สิทธิ์ game.manage ใน loader)', () => {
    for (const f of ['features/sessions/BoardSync.tsx', 'features/sessions/LiveBoard.tsx', 'app/gangs/[gangId]/sessions/[sessionId]/console/board/page.tsx']) {
      expect(code(f), f).not.toMatch(/\.channel\(|supabaseBrowser|postgres_changes/);
    }
    const consolePage = code('app/gangs/[gangId]/sessions/[sessionId]/console/page.tsx');
    const boardPage = code('app/gangs/[gangId]/sessions/[sessionId]/console/board/page.tsx');
    expect(consolePage).toContain('loadConsole(');
    expect(boardPage).toContain('loadConsole(');
    // ด่านสิทธิ์อยู่ที่ loader ที่เดียว — ทั้งสองหน้าไม่มี query/สิทธิ์ของตัวเอง
    expect(boardPage).not.toMatch(/supabase|can\(/);
    expect(code('server/sessions/console-loader.ts')).toContain("'game.manage'");
  });

  it('ไม่มี `<div` / `style={{` / hex ดิบในไฟล์หน้าจอใหม่', () => {
    const offenders = UI_FILES.flatMap((f) => {
      const src = code(f);
      const hits: string[] = [];
      if (/<div[\s>]/.test(src)) hits.push('<div');
      if (/style=\{\{/.test(src)) hits.push('style={{');
      if (/#[0-9a-fA-F]{6}\b/.test(src)) hits.push('hex');
      return hits.map((h) => `${f}: ${h}`);
    });
    expect(offenders).toEqual([]);
  });

  it('error ของ action แสดงผ่าน actionError() — ไม่เอา error.message ตรงๆ ขึ้นจอ', () => {
    for (const f of ['features/sessions/GameConsole.tsx', 'features/sessions/ScanCheckin.tsx']) {
      expect(code(f), f).not.toMatch(/\.error\.message|error\?\.message/);
    }
  });
});
