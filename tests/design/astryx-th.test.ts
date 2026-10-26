/**
 * WO-6.1b — ข้อความ Astryx ภาษาไทยต้องครบทุก key และคง placeholder ให้ตรงต้นฉบับ
 *
 * เทียบกับ `locales/en.json` ของ Astryx ที่ติดตั้งจริง ⇒ อัปเกรด Astryx แล้วมี key ใหม่ เทสต์นี้ล้ม
 * (ไม่งั้นข้อความอังกฤษจะหลุดเข้าแอป Thai-first เงียบๆ เหมือน "Required"/"Optional" ที่เคยเจอ)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { ASTRYX_TH_OVERRIDES } from '@/lib/i18n/astryx-th';

const en = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../node_modules/@astryxdesign/core/locales/en.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, { defaultMessage: string }>;

/** ชื่อ placeholder ระดับบนสุด เช่น `{count, number}` → count (ข้ามของที่อยู่ในวงเล็บ plural) */
function placeholders(msg: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let token = '';
  for (const ch of msg) {
    if (ch === '{') {
      depth += 1;
      token = '';
    } else if (ch === '}') {
      if (depth === 1 && token) names.add(token.split(',')[0].trim());
      depth -= 1;
      token = '';
    } else if (depth === 1) {
      token += ch;
    }
  }
  return [...names].sort();
}

describe('ASTRYX_TH_OVERRIDES ครบทุก key ของ Astryx', () => {
  const keys = Object.keys(en);

  it('มีครบทุก key ใน en.json (ไม่มีข้อความอังกฤษหลุด)', () => {
    const missing = keys.filter((k) => !(k in ASTRYX_TH_OVERRIDES));
    expect(missing).toEqual([]);
  });

  it('ไม่มี key แปลกปลอมที่ Astryx ไม่มี (พิมพ์ผิด = ไม่มีผลเงียบๆ)', () => {
    const extra = Object.keys(ASTRYX_TH_OVERRIDES).filter((k) => !(k in en));
    expect(extra).toEqual([]);
  });

  it('ทุกข้อความไม่ว่าง และมีตัวอักษรไทย (ยกเว้นข้อความที่เป็นสัญลักษณ์ล้วน เช่น "/ {total}")', () => {
    // ข้อความที่เป็นแม่แบบ placeholder/เครื่องหมายล้วน — ไม่มีคำให้แปล
    const SYMBOL_ONLY = new Set([
      '@astryx.pagination.ofTotalPages',
      '@astryx.avatar.nameWithStatus',
      '@astryx.fileInput.triggerWithFiles',
    ]);
    const bad = keys.filter((k) => {
      const t = ASTRYX_TH_OVERRIDES[k];
      if (typeof t !== 'string' || t.trim() === '') return true;
      return !SYMBOL_ONLY.has(k) && !/[\u0E00-\u0E7F]/.test(t);
    });
    expect(bad).toEqual([]);
  });

  it('placeholder ตรงกับต้นฉบับทุก key (ไม่ทำ {name}/{count} หาย)', () => {
    const mismatched = keys.filter(
      (k) => JSON.stringify(placeholders(en[k].defaultMessage)) !== JSON.stringify(placeholders(ASTRYX_TH_OVERRIDES[k] ?? '')),
    );
    expect(mismatched).toEqual([]);
  });

  it('Required / Optional ของฟอร์มเป็นไทย (QA 6.1a: ป้ายอังกฤษในฟอร์มสร้างนัด)', () => {
    expect(ASTRYX_TH_OVERRIDES['@astryx.field.required']).toBe('จำเป็น');
    expect(ASTRYX_TH_OVERRIDES['@astryx.field.optional']).toBe('ไม่บังคับ');
  });
});
