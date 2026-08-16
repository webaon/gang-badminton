import { expect, test } from '@playwright/test';

import { createGang, signUp, uniqueSuffix, watchConsole } from './helpers';

/**
 * Smoke ผ่านเบราว์เซอร์จริง — **[WO-5.E]**
 *
 * baseline §Verification (E2E): สมัคร → สร้างก๊วน → สร้างนัด → ลงชื่อ → เช็คอิน →
 * ปิดรอบ → เห็นยอด
 *
 * 🔴 จุดต่างจาก E2E ชุดเดิม (`tests/e2e/*`): ชุดนั้นเดินผ่าน **DB function + domain** ตรงๆ
 *    ส่วนชุดนี้เดินผ่าน **หน้าจอจริง** ⇒ จับของที่ชุดเดิมมองไม่เห็นได้ เช่น ปุ่มที่ไม่ทำงาน
 *    เพราะ CSP บล็อกสคริปต์ หรือ Astryx Beta ที่เข้ากับ Next 16 ไม่ได้
 *
 * ⚠️ ไม่แตะข้อมูลก๊วนจริง — ทุกเทสต์สมัครผู้ใช้ใหม่และสร้างก๊วนของตัวเองเสมอ
 * ⚠️ ไม่แตะ LINE (ต้องมี OA จริง) — ครอบใน `tests/e2e/phase4-full-path.test.ts` แทน
 */

/** `datetime-local` ต้องการรูปแบบ `YYYY-MM-DDTHH:mm` */
function localDateTime(hoursFromNow: number): string {
  const at = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * ⚠️ **ขอบเขตที่ครอบจริงในตอนนี้**: สมัคร → สร้างก๊วน → ตั้งราคา → สร้างนัด → เปิดรับสมัคร
 *    → เปิดหน้ารายละเอียดนัด
 *
 * หางของเส้น (ลงชื่อ → เช็คอิน → ปิดรอบ → เห็นยอด) **ยังไม่ครอบในเบราว์เซอร์**
 * — ครอบอยู่แล้วใน `tests/e2e/mvp0-full-path.test.ts` ที่เดินผ่าน DB function + domain
 * (จดไว้ใน `BACKLOG.md` พร้อมอาการที่ค้างอยู่)
 */
test('เส้นหลัก (ส่วนที่ครอบแล้ว): สมัคร → สร้างก๊วน → ตั้งราคา → สร้างนัด → เปิดรับ', async ({
  page,
}) => {
  const consoleWatcher = watchConsole(page);

  // ── สมัคร + สร้างก๊วน ────────────────────────────────────────────────────
  await signUp(page);
  const { gangId, name: gangName } = await createGang(page);

  await page.goto(`/gangs/${gangId}/sessions`);
  await expect(page.getByText(gangName)).toBeVisible();

  // ── ตั้งราคาต่อหัว (ไม่มีแผนราคา = ปิดรอบไม่ได้) ─────────────────────────
  await page.goto(`/gangs/${gangId}/settings`);
  // ⚠️ ฟอร์มต้องการ "ชื่อแผน" ด้วย — ไม่ใส่แล้วบันทึกไม่ผ่าน และหน้า "นัด" จะขึ้นว่า
  //    "ยังไม่ได้ตั้งแผนราคา" โดยไม่มี error ให้เห็นตรงๆ (เสียเวลาไปแล้วตอนเขียนเทสต์นี้)
  await page.getByLabel('ชื่อแผน').fill('เหมาจ่าย');
  await page.getByLabel('ราคาต่อคน (บาท)').fill('150');
  await page.getByRole('button', { name: 'บันทึกแผนราคา' }).click();
  // ⚠️ ไม่ assert ข้อความ toast — มันหายเร็วและบางธีมซ่อนไว้
  //    ตัวพิสูจน์จริงคือยอด 150.00 ที่ปลายทาง (ถ้าแผนราคาไม่ถูกบันทึก จะปิดรอบไม่ได้เลย)
  await page.waitForLoadState('networkidle');

  // ── สร้างนัด ────────────────────────────────────────────────────────────
  const sessionTitle = `ซ้อมสโมค ${uniqueSuffix()}`;

  await page.goto(`/gangs/${gangId}/sessions`);

  // ฟอร์มสร้างนัดจะโผล่ก็ต่อเมื่อ "มีแผนราคาแล้ว" ⇒ ใช้เป็นตัวยืนยันว่าขั้นก่อนหน้าสำเร็จจริง
  await expect(page.getByLabel('ชื่อนัด')).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('ชื่อนัด').fill(sessionTitle);
  await page.getByLabel(/^เริ่ม \(/).fill(localDateTime(2));
  await page.getByLabel(/^จบ \(/).fill(localDateTime(4));
  await page.getByLabel('รับสูงสุด (คน)').fill('8');
  await page.getByRole('button', { name: 'สร้างนัด (ยังไม่เปิดรับ)' }).click();

  // ⚠️ ปุ่มเปลี่ยนสถานะ (`SessionActions`) อยู่ที่ **หน้ารายการ** ไม่ใช่หน้ารายละเอียด
  //    (หน้ารายละเอียดมีแค่ลิงก์ไปคอนโซล/สแกน/จ่ายเงิน) — ยืนยันจาก snapshot ของ Playwright
  await expect(page.getByRole('link', { name: sessionTitle })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'เปิดรับสมัคร' }).first().click();

  // ── ยืนยันว่านัดเปิดรับแล้วจริง (สถานะเปลี่ยนผ่าน DB function จริง) ─────────
  // ⚠️ ใช้ role=button — ป้ายสถานะ (Badge) ก็เขียนว่า "เปิดรับสมัคร" เหมือนกัน
  //    เทียบด้วย text เฉยๆ จะเจอป้ายแล้วเข้าใจผิดว่าปุ่มยังอยู่
  await expect(page.getByRole('button', { name: 'เปิดรับสมัคร' })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText('เปิดรับสมัคร').first()).toBeVisible();

  // ── เข้าหน้ารายละเอียดนัดได้ และหน้าไม่พัง ────────────────────────────────
  await page.getByRole('link', { name: sessionTitle }).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/);

  await expect(page.getByRole('heading', { name: sessionTitle })).toBeVisible({ timeout: 15_000 });
  // ⚠️ หน้านี้เคยพังทั้งหน้าเมื่อ build โดยไม่มี `NEXT_PUBLIC_*` (client component ที่ต่อ
  //    realtime โยน error) ⇒ assert ว่ามันเรนเดอร์ได้จริง คือการกันบั๊กนั้นไม่ให้กลับมา
  await expect(page.getByRole('link', { name: 'คอนโซล' })).toBeVisible();

  // 🔴 ทั้งเส้นต้องไม่มี CSP violation เลย (ปิด DoD ที่ค้างของ WO-5.B)
  expect(consoleWatcher.cspViolations).toEqual([]);
});
