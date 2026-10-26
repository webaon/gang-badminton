import { expect, test } from '@playwright/test';

import { createGang, signUp, watchConsole } from './helpers';

/**
 * WO-6.1b — สถานะกลาง (404 / ลิงก์ใช้ไม่ได้ / offline / session หมดอายุ) + บั๊ก 390px ที่ QA 6.1a เจอ
 * ทุกเทสต์สร้างผู้ใช้/ก๊วนใหม่ของตัวเอง — ไม่แตะข้อมูลจริง
 */

const MOBILE = { width: 390, height: 844 };

test('404: route มั่ว → หน้า "ไม่พบหน้านี้" + status 404 + มีทางไปต่อ', async ({ page }) => {
  // ⚠️ ไม่ตรวจ CSP ในเคสนี้ — ของเดิมที่พบระหว่างทำ 6.1b (ไม่ใช่ของใบนี้ ไม่แตะ csp.ts):
  //    404 ของ path ที่ไม่มีจริงเสิร์ฟ HTML ที่ prerender (`/_not-found`) แต่ proxy ใส่ CSP แบบ nonce
  //    เพราะเทียบ pathname จริง (`/xyz`) กับ STATIC_ROUTES ไม่เจอ ⇒ สคริปต์ถูกบล็อก (หน้ายังใช้ได้เป็น HTML ล้วน:
  //    ลิงก์เป็น <a href>) · เคส notFound() จาก page ที่ dynamic (ด้านล่าง) ไม่เป็น — บันทึกใน BACKLOG ให้ planner ตัดสิน
  const response = await page.goto('/this-route-does-not-exist-xyz');
  expect(response?.status()).toBe(404);

  await expect(page.getByRole('heading', { name: 'ไม่พบหน้านี้' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ไปก๊วนของฉัน' })).toHaveAttribute('href', '/gangs');
  await expect(page.getByRole('link', { name: 'กลับหน้าแรก' })).toBeVisible();
});

test('404: ก๊วนที่ไม่ใช่ของเรา (id ถูกต้องแต่ไม่ใช่สมาชิก) ได้หน้าเดียวกัน ไม่บอกว่ามีอยู่จริงไหม', async ({ page }) => {
  const watcher = watchConsole(page);
  await signUp(page);
  const response = await page.goto('/gangs/00000000-0000-4000-8000-000000000000/sessions');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'ไม่พบหน้านี้' })).toBeVisible();
  expect(watcher.cspViolations).toEqual([]);
});

test('ลิงก์เชิญที่ใช้ไม่ได้ → ข้อความเดียวกัน (ไม่แยกผิด/หมดอายุ/ใช้ครบ) + ไม่ต้องล็อกอิน', async ({ page }) => {
  const watcher = watchConsole(page);
  await page.goto('/join/token-that-does-not-exist');

  await expect(page.getByRole('heading', { name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
  await expect(page.getByText('ไม่ถูกต้อง หมดอายุ หรือถูกใช้ครบจำนวนแล้ว')).toBeVisible();
  await expect(page.getByRole('link', { name: 'หาก๊วนอื่นแถวนี้' })).toHaveAttribute('href', '/discover');
  expect(watcher.cspViolations).toEqual([]);
});

test('guest: เปิดหน้าสถานะโดยไม่มี cookie → ลิงก์ใช้ไม่ได้ (ข้อความเดียวกัน)', async ({ page }) => {
  await page.goto('/guest/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('heading', { name: 'ลิงก์นี้ใช้ไม่ได้แล้ว' })).toBeVisible();
});

test('session หมดอายุ: พาไป sign-in พร้อม next ที่ผ่าน safeNext · next ภายนอกถูกทิ้ง', async ({ page }) => {
  await page.goto('/session-expired?next=%2Fgangs%2Fabc%2Fsessions%3Fx%3D1');
  await expect(page.getByRole('heading', { name: 'เซสชันหมดอายุ' })).toBeVisible();
  const href = await page.getByRole('link', { name: 'เข้าสู่ระบบ' }).getAttribute('href');
  expect(href).toBe(`/sign-in?next=${encodeURIComponent('/gangs/abc/sessions?x=1')}`);

  await page.goto('/session-expired?next=https%3A%2F%2Fevil.example%2F');
  const bad = await page.getByRole('link', { name: 'เข้าสู่ระบบ' }).getAttribute('href');
  expect(bad).toBe(`/sign-in?next=${encodeURIComponent('/profile')}`);
  expect(bad).not.toContain('evil');
});

test('offline: ออฟไลน์แล้วมีแถบแจ้ง · กลับออนไลน์แล้วแถบหาย', async ({ page, context }) => {
  await page.goto('/sign-up');
  await expect(page.getByText('ไม่มีอินเทอร์เน็ต')).toBeHidden();

  await context.setOffline(true);
  await expect(page.getByText('ไม่มีอินเทอร์เน็ต — ข้อมูลอาจไม่ล่าสุด')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ลองใหม่' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText('ไม่มีอินเทอร์เน็ต')).toBeHidden();
});

test.describe('มือถือ 390×844 (บั๊กเดิมจาก QA 6.1a ข้อ c)', () => {
  test.use({ viewport: MOBILE });

  test('หน้าสมาชิก: เห็นชื่อสมาชิกทุกแถว (กว้างพอ ไม่ถูกบีบเป็น 0) และไม่มี scroll แนวนอน', async ({ page, browser }) => {
    // ผู้ใช้คนที่ 2 (สมัครใน context แยก) แล้วให้เจ้าของก๊วนเพิ่มด้วยอีเมล
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    const user2 = await signUp(secondPage);
    await second.close();

    const owner = await signUp(page);
    const { gangId } = await createGang(page);

    await page.goto(`/gangs/${gangId}/members`);
    await page.getByLabel('เพิ่มสมาชิกด้วยอีเมล').fill(user2.email);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(page.getByText('เพิ่มสมาชิกแล้ว')).toBeVisible();

    for (const name of [owner.displayName, user2.displayName]) {
      const cell = page.getByText(name, { exact: true });
      await expect(cell, name).toBeVisible();
      const box = await cell.boundingBox();
      expect(box?.width ?? 0, `${name} กว้างพอ`).toBeGreaterThan(80);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'ไม่มี scroll แนวนอน').toBeLessThanOrEqual(0);
  });

  test('หน้ารายงาน: ฟอร์มรายการเงิน ช่อง "วันที่" ไม่ล้นขอบ', async ({ page }) => {
    await signUp(page);
    const { gangId } = await createGang(page);
    await page.goto(`/gangs/${gangId}/reports`);

    const date = page.getByLabel('วันที่');
    await expect(date).toBeVisible();
    const box = await date.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0), 'ขอบขวาของช่องอยู่ในจอ').toBeLessThanOrEqual(MOBILE.width);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('ข้อความ error ภาษาไทยผ่าน errorText (ไม่มีอังกฤษของ Supabase หลุดออกจอ)', () => {
  test('ล็อกอินรหัสผิด → "อีเมลหรือรหัสผ่านไม่ถูกต้อง" (ไม่ใช่ "เซสชันหมดอายุ") และไม่ถูกพาไป /session-expired', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('อีเมล').fill('nobody-here@example.com');
    await page.getByLabel('รหัสผ่าน').fill('wrong-password-123');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

    await expect(page.getByText('อีเมลหรือรหัสผ่านไม่ถูกต้อง')).toBeVisible();
    expect(page.url()).toContain('/sign-in');
    await expect(page.getByText('เซสชันหมดอายุ')).toBeHidden();
  });

  test('สมัครด้วยรหัสผ่านสั้นเกิน (Supabase ตอบอังกฤษ) → ข้อความไทยตายตัว ไม่เห็นอังกฤษ', async ({ page }) => {
    await page.goto('/sign-up');
    await page.getByLabel('ชื่อที่ใช้แสดง').fill('ทดสอบ');
    await page.getByLabel('อีเมล').fill(`e2e-short-${Date.now()}@example.com`);
    await page.getByLabel('รหัสผ่าน').fill('abc');
    await page.getByRole('button', { name: 'สมัครสมาชิก' }).click();

    await expect(page.getByText('ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/password should|at least|characters/i);
  });

  test('เพิ่มสมาชิกด้วยอีเมลที่ไม่มีในระบบ → ข้อความไทย ไม่โชว์ข้อความดิบจาก server', async ({ page }) => {
    await signUp(page);
    const { gangId } = await createGang(page);
    await page.goto(`/gangs/${gangId}/members`);
    await page.getByLabel('เพิ่มสมาชิกด้วยอีเมล').fill(`ghost-${Date.now()}@example.com`);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();

    const banner = page.locator('[data-status="error"]').first();
    await expect(banner).toBeVisible();
    const text = (await banner.innerText()).trim();
    expect(text).toMatch(/[\u0E00-\u0E7F]/);
    expect(text).not.toMatch(/[A-Za-z]{4,}/); // ไม่มีคำอังกฤษยาวๆ หลุดมา
  });
});
