/**
 * HF-2 gate — Astryx `Table` ใน server component ห้ามรับ function (idKey/renderCell/width ที่สร้างจาก function)
 * ⇒ ใช้ `SimpleTable` (client) หรือ client component เฉพาะกิจ · `idKey` ต้องเป็น string
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return tsxFiles(rel);
    return rel.endsWith('.tsx') ? [rel] : [];
  });
}

const isClient = (src: string) => /^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(src);

describe('grep gate: Astryx Table (HF-2)', () => {
  const files = ['app', 'features', 'components'].flatMap(tsxFiles);

  it('ไม่มี idKey เป็น function ที่ไหนเลย (ใช้ idKey="id" แบบ string)', () => {
    const offenders = files.filter((f) => /idKey=\{\s*(\(|\w+\s*=>|function)/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('server component ไม่ใช้ <Table ของ Astryx ตรงๆ — ต้องผ่าน wrapper ที่เป็น client', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      return /from '@astryxdesign\/core\/Table'/.test(src) && !isClient(src);
    });
    expect(offenders).toEqual([]);
  });
});
