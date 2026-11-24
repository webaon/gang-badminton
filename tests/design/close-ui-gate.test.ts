/**
 * WO-6.4b grep gate — หน้าปิดรอบ:
 *   1. ไม่คิดเงินใน UI: ไม่มี Number()/parseFloat/toFixed/reduce กับยอด · ไม่มีคำนวณ + − × ÷ กับ amount/total
 *   2. ไม่ตัดสินสิทธิ์ด้วย role ตรงๆ
 *   3. ไม่มี `<div` / `style={{` / hex ดิบ
 *   4. หน้า close ตรวจ `billing.close` ก่อนอ่านยอด และคงด่านเดิมของปุ่มยืนยัน
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const UI_FILES = [
  'features/billing/CloseSessionPage.tsx',
  'features/billing/CloseSummary.tsx',
  'features/billing/CloseTable.tsx',
  'features/billing/ConfirmCloseButton.tsx',
  'app/gangs/[gangId]/sessions/[sessionId]/close/page.tsx',
  'app/gangs/[gangId]/sessions/[sessionId]/close/loading.tsx',
];
const ALL_FILES = [...UI_FILES, 'domain/sessions/close-view.ts'];

/** ตัด comment ออกก่อน — คอมเมนต์ที่อธิบายกติกาไม่ควรทำให้เทสต์ล้ม */
function code(path: string): string {
  const src = readFileSync(join(ROOT, path), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('grep gate: หน้าปิดรอบ (WO-6.4b)', () => {
  it('ไฟล์ที่ตรวจมีอยู่จริงทุกไฟล์', () => {
    for (const f of ALL_FILES) expect(() => code(f), f).not.toThrow();
  });

  it('ไม่แปลงยอดเป็นตัวเลข / ไม่รวมยอดเอง (Number, parseFloat, toFixed, reduce)', () => {
    const forbidden = [/\bNumber\(/, /parseFloat\(/, /parseInt\(/, /toFixed\(/, /\.reduce\(/, /Intl\.NumberFormat/, /toLocaleString\(/];
    const offenders = ALL_FILES.flatMap((f) => forbidden.filter((re) => re.test(code(f))).map((re) => `${f}: ${re}`));
    expect(offenders).toEqual([]);
  });

  it('ไม่มีเลขคณิตกับ amount/total/roundingSurplus', () => {
    const arithmetic = /\b(amount|total|roundingSurplus|chargedCount)\b\s*[-+*/]\s*[\w(]|[\w)]\s*[-+*/]\s*\b(amount|total|roundingSurplus)\b/;
    const offenders = UI_FILES.filter((f) => arithmetic.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('ไม่มี `role ===` (ตัดสินสิทธิ์ด้วย can() เท่านั้น)', () => {
    const offenders = ALL_FILES.filter(
      (f) => /\brole\s*[!=]==?\s*['"`]/.test(code(f)) || /['"`]\s*[!=]==?\s*role\b/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('ไม่มี `<div` / `style={{` / hex ดิบ', () => {
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

  it('หน้า close ตรวจ billing.close ก่อน previewSessionCharges และคงด่านเดิม', () => {
    const page = code('features/billing/CloseSessionPage.tsx');
    expect(page.indexOf("'billing.close'")).toBeGreaterThan(-1);
    expect(page.indexOf("'billing.close'")).toBeLessThan(page.indexOf('previewSessionCharges('));
    const button = code('features/billing/ConfirmCloseButton.tsx');
    expect(button).toContain('needsCheckInConfirmation && !confirmed');
    expect(button).toContain('confirmNoCheckIn: confirmed');
  });

  it('error ของ action แสดงผ่าน actionError()/errorText() — ไม่เอา error.message ตรงๆ', () => {
    for (const f of UI_FILES) expect(code(f), f).not.toMatch(/\.error\.message|error\?\.message/);
  });
});
