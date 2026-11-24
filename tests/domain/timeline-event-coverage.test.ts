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
 * 🔴 [QA source review, 3246e9b] v1 of this scanner found `event_type`'s
 * COLUMN INDEX (`idx`) but never actually used it to navigate to the Nth
 * VALUE in the tuple — it just grabbed the FIRST quoted literal within a
 * fixed 1200-char window after the `insert into ... (` match, assuming
 * event_type was always first. That's a real blind spot: a decoy literal in
 * a SQL comment before the real tuple, a literal belonging to a DIFFERENT
 * (earlier) column, a multi-row `VALUES (...), (...), (...)` where only the
 * first row's literal was ever read, or a `CASE` expression on a NEIGHBOUR
 * column (not event_type's own) all silently produce a wrong-but-plausible
 * "found" event_type instead of failing loudly or being skipped correctly.
 *
 * v2 below does genuine positional parsing: strip comments first (kills the
 * decoy-comment class entirely), split the VALUES clause into real
 * paren/quote-aware tuples (handles multi-row inserts), split each tuple
 * into top-level comma-separated positions (handles nested `(...)` and
 * `CASE...END` without splitting on their internal commas), then extract
 * the literal(s) ONLY from the slot at `event_type`'s own column index —
 * either a plain `'literal'` or every `THEN`/`ELSE` literal inside that
 * slot's own `CASE` expression (never a neighbouring column's CASE).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(root, 'supabase/migrations');

/** ลบ `-- ...` และ `/* ... *\/` ทิ้งทั้งหมด โดยไม่ไปแตะอะไรที่อยู่ในสตริง `'...'` (กัน decoy literal ในคอมเมนต์) */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
        inString = false;
      }
      i++;
      continue;
    }
    if (c === "'") { inString = true; out += c; i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** แยกด้วย `sep` เฉพาะระดับบนสุด (ข้าม `(...)` ที่ซ้อนอยู่และสตริง `'...'`) — ใช้แยก tuple เป็นแต่ละตำแหน่งคอลัมน์ */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      cur += c;
      if (c === "'") {
        if (s[i + 1] === "'") { cur += s[i + 1]; i++; continue; }
        inString = false;
      }
      continue;
    }
    if (c === "'") { inString = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** หา tuple ของ VALUES ทุกแถว (`(...), (...), ...`) เริ่มจาก startIdx — เข้าใจ paren ซ้อน/สตริงข้างใน */
function extractValuesTuples(text: string, startIdx: number): string[] {
  const tuples: string[] = [];
  let i = startIdx;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '(') break;
    i++;
    let depth = 1;
    let inString = false;
    let interior = '';
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (inString) {
        interior += c;
        if (c === "'") {
          if (text[i + 1] === "'") { interior += text[i + 1]; i += 2; continue; }
          inString = false;
        }
        i++;
        continue;
      }
      if (c === "'") { inString = true; interior += c; i++; continue; }
      if (c === '(') { depth++; interior += c; i++; continue; }
      if (c === ')') {
        depth--;
        i++;
        if (depth === 0) break;
        interior += c;
        continue;
      }
      interior += c;
      i++;
    }
    tuples.push(interior);
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === ',') { i++; continue; }
    break;
  }
  return tuples;
}

/** จากค่าที่ตำแหน่ง event_type ใน tuple เดียว — คืน literal ทั้งหมดที่ "เป็นไปได้จริง" ของตำแหน่งนี้เท่านั้น
 *  (literal ตรงๆ หรือ THEN/ELSE ของ CASE ที่ตำแหน่งนี้เองเท่านั้น ไม่ใช่ CASE ของคอลัมน์ข้างเคียง) */
function literalsAtThisPosition(valueExpr: string): string[] {
  const trimmed = valueExpr.trim();
  const simple = /^'([^']*)'$/.exec(trimmed);
  if (simple) return [simple[1]];
  if (/^case\b/i.test(trimmed)) {
    const literals: string[] = [];
    const re = /\b(?:then|else)\s*'([^']*)'/gi;
    for (let m = re.exec(trimmed); m; m = re.exec(trimmed)) literals.push(m[1]);
    return literals;
  }
  return []; // bind param / column ref / function call ที่ตำแหน่งนี้ — ไม่ใช่ literal ข้าม
}

/** pure function หลัก — รับสตริง SQL ตรงๆ (ทดสอบด้วย fixture สังเคราะห์ได้โดยไม่ต้องอ่านไฟล์จริง) */
export function extractEventTypesFromSql(rawSql: string): Set<string> {
  const found = new Set<string>();
  const text = stripSqlComments(rawSql);
  const insertRe = /insert into public\.event_logs\s*\(([^)]*)\)\s*values\b/gi;
  for (let m = insertRe.exec(text); m; m = insertRe.exec(text)) {
    const cols = m[1].split(',').map((c) => c.trim());
    const idx = cols.indexOf('event_type');
    if (idx < 0) continue;

    const tuples = extractValuesTuples(text, m.index + m[0].length);
    for (const tuple of tuples) {
      const positions = splitTopLevel(tuple, ',');
      if (idx >= positions.length) continue;
      for (const lit of literalsAtThisPosition(positions[idx])) found.add(lit);
    }
  }
  return found;
}

function allRealEventTypes(): Set<string> {
  const found = new Set<string>();
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  for (const file of files) {
    const raw = readFileSync(join(migrationsDir, file), 'utf8');
    for (const t of extractEventTypesFromSql(raw)) found.add(t);
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

describe('🔴 [QA source review, 3246e9b] scratch-fixture tests ของ extractEventTypesFromSql() เอง — SQL สังเคราะห์ ไม่ใช่ migration จริง', () => {
  it('literal ตรงๆ ตำแหน่ง event_type ตัวเดียว', () => {
    const sql = `insert into public.event_logs (gang_id, event_type, payload) values ($1, 'foo.bar_baz', '{}'::jsonb);`;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['foo.bar_baz']));
  });

  it('event_type ที่มีเลขหรือหลายจุดต้องจับได้ครบ — positional แล้ว ไม่ถูกจำกัดด้วยรูปร่างของ literal อีกต่อไป', () => {
    const sql = `insert into public.event_logs (event_type) values ('v2.foo.bar_1');`;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['v2.foo.bar_1']));
  });

  it('🔴 decoy comment ก่อน VALUES จริง ต้องไม่ถูกหยิบมาเป็น event_type', () => {
    const sql = `
      -- ตัวอย่างเก่า: event_type เคยเป็น 'decoy.wrong_one' ห้ามจับตัวนี้
      /* อีกคอมเมนต์ที่มี 'another.decoy' ซ้อนอยู่ */
      insert into public.event_logs (gang_id, event_type) values ($1, 'real.event_type');
    `;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['real.event_type']));
  });

  it('🔴 ตำแหน่ง event_type ไม่ใช่ literal แรกในวงเล็บ — คอลัมน์ก่อนหน้ามี literal ของตัวเอง ต้องไม่จับผิดตัว', () => {
    const sql = `insert into public.event_logs (gang_id, aggregate_type, event_type) values ($1, 'gang', 'real.one');`;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['real.one']));
  });

  it('multi-row VALUES (หลายแถวใน insert เดียว) ต้องจับได้ทุกแถว ไม่ใช่แค่แถวแรก', () => {
    const sql = `
      insert into public.event_logs (gang_id, event_type) values
        ($1, 'first.one'),
        ($1, 'second.one'),
        ($1, 'third.one');
    `;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['first.one', 'second.one', 'third.one']));
  });

  it('CASE ที่ตำแหน่ง event_type เอง — จับ THEN/ELSE ทุกแขนงของ CASE ตัวนี้', () => {
    const sql = `
      insert into public.event_logs (event_type) values
        (case when x then 'branch.a' else 'branch.b' end);
    `;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['branch.a', 'branch.b']));
  });

  it('🔴 CASE ของคอลัมน์ข้างเคียง (ไม่ใช่ event_type) ต้องไม่ถูกจับผสมกับ CASE ของ event_type', () => {
    const sql = `
      insert into public.event_logs (actor_label, event_type) values
        (case when y then 'neighbour.a' else 'neighbour.b' end, case when x then 'own.a' else 'own.b' end);
    `;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set(['own.a', 'own.b']));
  });

  it('bind parameter ($1) ที่ตำแหน่ง event_type ไม่ใช่ literal — ไม่เพิ่มอะไรเข้า set (ไม่ใช่ error แค่ไม่มี literal ให้จับ)', () => {
    const sql = `insert into public.event_logs (event_type, payload) values ($2, '{}'::jsonb);`;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set());
  });

  it('ไม่มีคอลัมน์ event_type เลย — ข้าม ไม่ error', () => {
    const sql = `insert into public.event_logs (gang_id, payload) values ($1, '{}'::jsonb);`;
    expect(extractEventTypesFromSql(sql)).toEqual(new Set());
  });

  it('🔴 ถ้า DESCRIPTORS ไม่มี entry ของ event_type จริงที่สแกนเจอ ต้องทำให้การเช็ค "missing" ไม่ใช่ [] — พิสูจน์ว่า assertion ตัวจริงจับได้จริง ไม่ใช่ pass มั่วๆ', () => {
    const real = extractEventTypesFromSql(
      `insert into public.event_logs (event_type) values ('unmanifested.totally_new');`,
    );
    const fakeDescriptors = { 'something.else': {} }; // สมมติ DESCRIPTORS ไม่มี key นี้
    const missing = Array.from(real).filter((t) => !(t in fakeDescriptors));
    expect(missing).toEqual(['unmanifested.totally_new']);
  });
});

describe('🔴 [planner F3] mutation test — migration สมมติที่มี event_type ใหม่ 1 ตัว ต้องทำให้ drift-check ตัวจริง (เทียบกับ DESCRIPTORS_FOR_TEST จริง ไม่ใช่ fake) fail จริง', () => {
  it('event_type ใหม่ที่แน่ชัดว่าไม่มีใน DESCRIPTORS จริง ต้องโผล่เป็น "missing" เมื่อเทียบกับ DESCRIPTORS_FOR_TEST ของจริง', async () => {
    const { DESCRIPTORS_FOR_TEST } = await import('@/domain/reports/timeline');

    // migration สมมติ — จำลองรูปแบบ SQL จริงของโปรเจกต์นี้ (multi-row + comment ปนอยู่) แต่มี event_type
    // ใหม่ 1 ตัวที่ไม่มีทางมีอยู่ใน DESCRIPTORS จริง (ชื่อ mutation-test เฉพาะ กันชนกับของจริงโดยบังเอิญ)
    const simulatedNewMigration = `
      -- migration สมมติสำหรับ mutation test เท่านั้น ไม่ได้ apply จริง
      insert into public.event_logs (gang_id, event_type, payload) values
        ($1, 'registration.confirmed', '{}'::jsonb), -- key ที่มี descriptor อยู่แล้ว ต้องไม่ติด missing
        ($1, 'mutation_test.unmanifested_future_event_zzz', '{}'::jsonb); -- key ใหม่ที่ไม่มี descriptor
    `;

    const extracted = extractEventTypesFromSql(simulatedNewMigration);
    expect(extracted).toEqual(new Set(['registration.confirmed', 'mutation_test.unmanifested_future_event_zzz']));

    // ใช้ "missing" filter ตัวเดียวกันเป๊ะกับที่ describe บนสุดใช้จริงกับ DESCRIPTORS_FOR_TEST จริง (ไม่ใช่ fake)
    const missing = Array.from(extracted).filter((t) => !(t in DESCRIPTORS_FOR_TEST));
    expect(missing).toEqual(['mutation_test.unmanifested_future_event_zzz']);
    // พิสูจน์ด้วยว่า assertion สไตล์ท็อปของจริง (toEqual([])) จะ "fail" กับ input นี้จริงๆ ไม่ใช่ผ่านมั่วๆ
    expect(missing).not.toEqual([]);
  });

  // [planner F3 fallback note] ถ้า parser ด้านบนแม่นยากเกินไปในอนาคต ให้เปลี่ยนไปอ่าน event_type จาก
  // DB catalog จริงของ local (`select pg_get_functiondef(oid) from pg_proc where proname = ...` หรือ
  // grep `distinct event_type` จาก `event_logs` ตารางจริงหลัง seed/migration up) แทนการ grep source —
  // ไม่ใช่เทสต์ที่ต้องรันตอนนี้เพราะ parser ผ่านครบ 10 scratch fixtures + mutation test ข้างบนแล้ว
});
