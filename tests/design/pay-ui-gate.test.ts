/**
 * WO-6.3 grep gate — หน้าจ่ายเงินฝั่งสมาชิก:
 *   1. UI ไม่คิดเงิน: ไม่มี Number()/parseFloat/toFixed/reduce/Intl กับยอด · ไม่มีเลขคณิตกับ amount
 *   2. component/page ไม่ import `domain/billing` ตรงๆ ยกเว้น page เดิมที่รอ loader ของ WO-R3 (ledger)
 *   3. ไม่มี `<div` / `style={{` / hex ดิบ · ไม่ตัดสินสิทธิ์ด้วย role
 *   4. error ของ action แสดงผ่าน actionError() — ไม่เอา .message ตรงๆ
 *   5. ข้อความขนาดไฟล์ในหน้าจอตรงกับ bucket จริง (5MB)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const COMPONENTS = [
  'features/payments/PayView.tsx',
  'features/payments/PayQr.tsx',
  'features/payments/PayStatusSteps.tsx',
  'features/payments/PaySlipForm.tsx',
  'features/payments/CreateMyPaymentButton.tsx',
];
const UI_FILES = [...COMPONENTS, 'app/gangs/[gangId]/sessions/[sessionId]/pay/page.tsx'];
const ALL_FILES = [...UI_FILES, 'domain/payments/pay-view.ts'];

function code(path: string): string {
  const src = readFileSync(join(ROOT, path), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('grep gate: หน้าจ่ายเงินสมาชิก (WO-6.3)', () => {
  it('ไฟล์ที่ตรวจมีอยู่จริงทุกไฟล์', () => {
    for (const f of ALL_FILES) expect(() => code(f), f).not.toThrow();
  });

  it('ไม่แปลง/รวมยอดเองใน UI (Number, parseFloat, toFixed, reduce, Intl)', () => {
    const forbidden = [/\bNumber\(/, /parseFloat\(/, /parseInt\(/, /toFixed\(/, /\.reduce\(/, /Intl\.NumberFormat/, /toLocaleString\(/];
    const offenders = ALL_FILES.flatMap((f) => forbidden.filter((re) => re.test(code(f))).map((re) => `${f}: ${re}`));
    expect(offenders).toEqual([]);
  });

  it('component ไม่ import domain/billing (เงินมาจาก server/loader เท่านั้น)', () => {
    const offenders = COMPONENTS.filter((f) => /from '@\/domain\/billing/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('ไม่มี `<div` / `style={{` / hex ดิบ / role ===', () => {
    const offenders = UI_FILES.flatMap((f) => {
      const src = code(f);
      const hits: string[] = [];
      if (/<div[\s>]/.test(src)) hits.push('<div');
      if (/style=\{\{/.test(src)) hits.push('style={{');
      if (/#[0-9a-fA-F]{6}\b/.test(src)) hits.push('hex');
      if (/\brole\s*[!=]==?\s*['"`]/.test(src)) hits.push('role ===');
      return hits.map((h) => `${f}: ${h}`);
    });
    expect(offenders).toEqual([]);
  });

  it('error ของ action ไปทาง actionError() ไม่ใช้ .message ตรงๆ', () => {
    for (const f of ['features/payments/PaySlipForm.tsx', 'features/payments/CreateMyPaymentButton.tsx']) {
      const src = code(f);
      expect(src, f).toContain('actionError(');
      expect(src, f).not.toMatch(/\.error\.message|error\?\.message/);
    }
  });

  it('ข้อความจำกัดขนาดไฟล์ตรงกับ bucket (5MB) ไม่ใช่ 8MB', () => {
    const view = code('domain/payments/pay-view.ts') + code('features/payments/PaySlipForm.tsx');
    expect(view).toContain('5MB');
    expect(view).not.toContain('8MB');
  });

  it('จัดการ network/5xx ในปุ่มที่เรียก server action (ไม่ค้าง pending)', () => {
    for (const f of ['features/payments/PaySlipForm.tsx', 'features/payments/CreateMyPaymentButton.tsx']) {
      expect(code(f), f).toMatch(/finally\s*\{[\s\S]*setPending\(false\)/);
    }
  });
});
