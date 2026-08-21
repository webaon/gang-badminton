/**
 * ทุก `.select(...)` ในโค้ดแอปต้อง **PostgREST ยอมรับจริง**
 *
 * 🔴 ที่มา: หน้ารายชื่อของนัดว่างเปล่าบน production ทั้งที่ DB มีข้อมูลครบ
 *    `session_registrations` มี FK ชี้ `profiles` ถึง 5 เส้น (user_id, registered_by,
 *    updated_by, created_by, deleted_by) ⇒ เขียน `profiles(display_name)` เฉยๆ ได้
 *    **PGRST201 ambiguous embed** ⇒ query คืน error ทั้งก้อน
 *
 *    และเพราะ call site เขียนว่า `const { data } = await ...` แล้ว `?? []`
 *    error ถูกกลืนหมด — หน้าจอขึ้น "ยังไม่มีใครลงชื่อ" โดยไม่มีอะไรฟ้องเลย
 *    (เทสต์ชุดอื่นจับไม่ได้เพราะเดินผ่าน `pg` driver / DB function ตรงๆ ไม่ผ่าน PostgREST)
 *
 * ⚠️ เทสต์นี้ไม่สนใจว่ามี **ข้อมูล** หรือไม่ — สนใจแค่ว่า PostgREST **parse ได้**
 *    จึงใช้ `.limit(0)` ทุกครั้ง (ยังตรวจชื่อคอลัมน์/ชื่อ embed ครบเหมือนเดิม)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

import { serviceClient, pool, reloadPostgrestSchema } from '../helpers/db';

const ROOTS = ['app', 'server', 'features'];
const EXT = /\.tsx?$/;

/** จับคู่ `.from('table')` กับ `.select('...')` ที่ตามมาในสายเดียวกัน */
const QUERY = /\.from\(\s*'([a-z_]+)'\s*\)([\s\S]{0,800}?)\.select\(\s*'([^']*)'/g;

type Query = { file: string; table: string; select: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(entry)) out.push(full);
  }
  return out;
}

function collectQueries(): Query[] {
  const found: Query[] = [];

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(QUERY)) {
        const [, table, , select] = m;
        if (select.trim()) found.push({ file, table, select });
      }
    }
  }

  return found;
}

describe('PostgREST ยอมรับทุก .select() ที่แอปใช้จริง', () => {
  let queries: Query[] = [];
  let tables = new Set<string>();

  beforeAll(async () => {
    await reloadPostgrestSchema();
    queries = collectQueries();

    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    tables = new Set(rows.map((r) => r.table_name));
  }, 60_000);

  it('เจอ query ในโค้ดจริง (กันเทสต์ผ่านเพราะ regex ไม่แมตช์อะไรเลย)', () => {
    expect(queries.length).toBeGreaterThan(10);
  });

  it('ไม่มี select ไหนที่ PostgREST ปฏิเสธ', async () => {
    const client = serviceClient();
    const failures: string[] = [];

    for (const q of queries) {
      // ข้ามตารางที่ไม่ได้อยู่ใน public (เช่น storage) — ไม่ใช่ของที่เทสต์นี้ดูแล
      if (!tables.has(q.table)) continue;

      const { error } = await client.from(q.table).select(q.select).limit(0);

      if (error) {
        failures.push(
          `${q.file}\n    from('${q.table}').select('${q.select}')\n    → ${error.code}: ${error.message}`,
        );
      }
    }

    expect(failures.join('\n\n')).toBe('');
  }, 120_000);
});
