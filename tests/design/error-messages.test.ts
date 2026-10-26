/**
 * WO-6.1b — ทุก code ใน `docs/errors.md` ต้องมีข้อความไทยที่ไม่ว่าง
 *
 * เทียบสามทาง: ตารางใน docs/errors.md ↔ `ERROR_CODES` (shared/errors.ts) ↔ `ERROR_MESSAGES_TH`
 * ขาดหรือเกินด้านใดด้านหนึ่งเทสต์ล้ม (catalog กับโค้ดห้ามเบี่ยงจากกัน — CLAUDE.md §4)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { ERROR_MESSAGES_TH } from '@/lib/i18n/error-messages';
import { ERROR_CODES } from '@/shared/errors';

const catalog = readFileSync(
  fileURLToPath(new URL('../../docs/errors.md', import.meta.url)),
  'utf8',
);

/** แถวตารางที่ขึ้นต้นด้วย | `CODE` | — code ซ้ำ (NOT_FOUND มี 2 แถว) ให้ถือเป็นตัวเดียว */
const documented = [...new Set([...catalog.matchAll(/^\|\s*`([A-Z_]+)`\s*\|/gm)].map((m) => m[1]))].sort();

describe('ข้อความ error ภาษาไทย', () => {
  it('docs/errors.md มี code ตรงกับ ERROR_CODES ทุกตัว (sanity: อ่านตารางได้จริง)', () => {
    expect(documented.length).toBeGreaterThanOrEqual(30);
    expect(documented).toEqual([...ERROR_CODES].sort());
  });

  it('ทุก code ใน docs/errors.md มีข้อความไทย', () => {
    const missing = documented.filter((c) => !(c in ERROR_MESSAGES_TH));
    expect(missing).toEqual([]);
  });

  it('ไม่มีข้อความเกิน code (ข้อความของ code ที่ถูกถอดแล้ว)', () => {
    const extra = Object.keys(ERROR_MESSAGES_TH).filter((c) => !documented.includes(c));
    expect(extra).toEqual([]);
  });

  it('ทุกข้อความไม่ว่าง มีตัวอักษรไทย และไม่ใช่ตัวโค้ดเอง', () => {
    for (const code of documented) {
      const text = (ERROR_MESSAGES_TH as Record<string, string>)[code];
      expect(text, code).toBeTypeOf('string');
      expect(text.trim(), code).not.toBe('');
      expect(text, code).toMatch(/[\u0E00-\u0E7F]/);
      expect(text, code).not.toContain(code);
    }
  });

  it('ข้อความที่ผู้ใช้เห็นไม่รั่วรายละเอียดภายใน (SQL/ชื่อตาราง/stack)', () => {
    for (const [code, text] of Object.entries(ERROR_MESSAGES_TH)) {
      expect(text, code).not.toMatch(/\b(select|insert|update|delete|rpc|supabase|postgres|stack)\b/i);
    }
  });
});
