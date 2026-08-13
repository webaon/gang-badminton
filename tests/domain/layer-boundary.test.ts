/**
 * WO-2.1 DoD — พิสูจน์ว่า lint rule ที่กัน `domain/` แตะ framework **ทำงานจริง**
 *
 * baseline §Verification เรียกข้อนี้ว่า "Domain layer test" และบังคับให้มี
 *
 * ⚠️ ทำไมต้องเป็นเทสต์ ไม่ใช่แค่ตั้ง rule แล้วลองมือครั้งเดียว
 *    rule ที่ตั้งไว้เฉยๆ ถูกลบ/ถูก override ได้โดยไม่มีใครรู้ — เทสต์นี้รัน eslint
 *    จริงกับโค้ดตัวอย่าง แล้วยืนยันว่ามันยัง "แดง" อยู่ ⇒ ถ้าใครถอด rule ออก
 *    เทสต์จะพังทันทีแทนที่จะเงียบ
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

/** รัน eslint กับโค้ดสมมติ โดยแกล้งว่าไฟล์อยู่ที่ path ที่กำหนด */
async function lintAs(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: projectRoot });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => `${m.ruleId}: ${m.message}`);
}

const inDomain = (name: string) => `${projectRoot}domain/${name}`;
const inLib = (name: string) => `${projectRoot}lib/${name}`;

describe('domain/ ต้องเป็น pure TypeScript', () => {
  it('🔴 import @supabase/* ใน domain/ → lint แดง', async () => {
    const messages = await lintAs(
      inDomain('probe-supabase.ts'),
      `import { createClient } from '@supabase/supabase-js';\nexport { createClient };\n`,
    );
    expect(messages.some((m) => m.includes('no-restricted-imports'))).toBe(true);
  });

  it('🔴 import next ใน domain/ → lint แดง', async () => {
    const messages = await lintAs(
      inDomain('probe-next.ts'),
      `import { NextResponse } from 'next/server';\nexport { NextResponse };\n`,
    );
    expect(messages.some((m) => m.includes('no-restricted-imports'))).toBe(true);
  });

  it('🔴 import react ใน domain/ → lint แดง (รวม type-only import)', async () => {
    const value = await lintAs(
      inDomain('probe-react.ts'),
      `import { useState } from 'react';\nexport { useState };\n`,
    );
    expect(value.some((m) => m.includes('no-restricted-imports'))).toBe(true);

    // type import ก็ต้องโดน — ไม่งั้นจะแอบผูกกับ framework ผ่าน type ได้
    const typeOnly = await lintAs(
      inDomain('probe-react-type.ts'),
      `import type { ReactNode } from 'react';\nexport type { ReactNode };\n`,
    );
    expect(typeOnly.some((m) => m.includes('no-restricted-imports'))).toBe(true);
  });

  it('🔴 domain/ พึ่งชั้นนอก (lib/server/app) → lint แดง', async () => {
    const messages = await lintAs(
      inDomain('probe-layer.ts'),
      `import { supabaseAdmin } from '@/lib/supabase/admin';\nexport { supabaseAdmin };\n`,
    );
    expect(messages.some((m) => m.includes('no-restricted-imports'))).toBe(true);
  });

  it('โค้ด pure ใน domain/ ต้องผ่านสะอาด', async () => {
    const messages = await lintAs(
      inDomain('probe-pure.ts'),
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    expect(messages).toEqual([]);
  });

  it('ชั้นนอก (lib/) import supabase ได้ตามปกติ — rule ต้องไม่ล้นออกนอก domain/', async () => {
    const messages = await lintAs(
      inLib('probe-outside.ts'),
      `import { createClient } from '@supabase/supabase-js';\nexport { createClient };\n`,
    );
    expect(messages.some((m) => m.includes('no-restricted-imports'))).toBe(false);
  });
});
