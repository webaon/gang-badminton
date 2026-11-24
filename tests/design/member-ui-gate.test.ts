/**
 * WO-6.2 grep gate — หน้านัดฝั่งสมาชิก:
 *   1. ไม่ตัดสินสิทธิ์ด้วย role ตรงๆ (ต้องผ่าน `can()` เท่านั้น — CLAUDE.md)
 *   2. ไม่มีการคิดเงิน/ค่าปรับใน UI (ผู้ตัดสินคือ DB: preview_cancel_registration / billing)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const FILES = [
  'features/sessions/SessionsListPage.tsx',
  'features/sessions/SessionDetailPage.tsx',
  'features/sessions/SessionListCard.tsx',
  'features/sessions/SessionFilterTabs.tsx',
  'features/sessions/RegistrationActions.tsx',
  'features/sessions/RosterList.tsx',
  'features/sessions/GuestInviteCard.tsx',
  'features/sessions/GuestJoinForm.tsx',
  'features/sessions/GuestCancelButton.tsx',
  'app/gangs/[gangId]/sessions/page.tsx',
  'app/gangs/[gangId]/sessions/[sessionId]/page.tsx',
  'app/join/[token]/page.tsx',
  'app/guest/[registrationId]/page.tsx',
  'domain/sessions/member-view.ts',
  'domain/sessions/cancel-notice.ts',
];

/** ตัด comment ออกก่อน — คอมเมนต์ที่อธิบายกติกาไม่ควรทำให้เทสต์ล้ม */
function code(path: string): string {
  const src = readFileSync(join(ROOT, path), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('grep gate: หน้านัดฝั่งสมาชิก (WO-6.2)', () => {
  it('ไฟล์ที่ตรวจมีอยู่จริงทุกไฟล์', () => {
    for (const f of FILES) expect(() => code(f), f).not.toThrow();
  });

  it('ไม่มี `role ===` / `role ==` / `role !==` (ตัดสินสิทธิ์ด้วย can() เท่านั้น)', () => {
    const offenders = FILES.filter((f) => /\brole\s*[!=]==?\s*['"`]/.test(code(f)) || /['"`]\s*[!=]==?\s*role\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('ไม่มีการคิดเงิน/ค่าปรับใน UI (toFixed, ฿, penaltyValue, ราคา, คูณ/หารจำนวนเงิน)', () => {
    const forbidden = [/toFixed\(/, /฿/, /penalty_?[vV]alue/, /price_?(per|amount)/i, /\bamount\b/i];
    const offenders = FILES.flatMap((f) =>
      forbidden.filter((re) => re.test(code(f))).map((re) => `${f}: ${re}`),
    );
    expect(offenders).toEqual([]);
  });

  it('ไม่ render payload ดิบของ event_logs (ใช้ buildTimeline เท่านั้น)', () => {
    const src = code('features/sessions/SessionDetailPage.tsx');
    expect(src).toContain('buildTimeline(');
    expect(src).not.toMatch(/JSON\.stringify\(\s*e?\.?payload/);
  });
});
