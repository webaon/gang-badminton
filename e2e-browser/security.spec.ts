import { expect, test } from '@playwright/test';

import { createGang, signUp, watchConsole } from './helpers';

/**
 * ปิด DoD ที่ค้างของ **WO-5.B** — **[WO-5.E]**
 *
 * "เดินครบทุกหน้าหลักแล้วไม่มี CSP violation ใน console"
 * ⇒ ข้อนี้พิสูจน์ด้วย header อย่างเดียวไม่ได้ ต้องมีเบราว์เซอร์จริงมาอ่าน console ให้
 *   (CSP ที่ตั้งผิดไม่ทำให้ server error เลย — หน้าจะขาวหรือปุ่มกดไม่ได้เฉยๆ)
 */

const PUBLIC_PAGES = ['/', '/discover', '/sign-in', '/sign-up'];

test.describe('WO-5.B (ปิดใน 5.E) — ไม่มี CSP violation ในเบราว์เซอร์จริง', () => {
  for (const path of PUBLIC_PAGES) {
    test(`หน้าสาธารณะ ${path} ไม่มี CSP violation`, async ({ page }) => {
      const console = watchConsole(page);

      await page.goto(path);
      await page.waitForLoadState('networkidle');

      expect(console.cspViolations, `CSP violation ที่ ${path}`).toEqual([]);
    });
  }

  test('หน้าหลังล็อกอิน (สร้างก๊วน → นัด → ตั้งค่า) ไม่มี CSP violation', async ({ page }) => {
    const console = watchConsole(page);

    await signUp(page);
    const { gangId } = await createGang(page);

    for (const path of [
      `/gangs/${gangId}/sessions`,
      `/gangs/${gangId}/members`,
      `/gangs/${gangId}/settings`,
      `/gangs/${gangId}/payments`,
      `/gangs/${gangId}/reports`,
      '/notifications',
      '/profile',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }

    expect(console.cspViolations).toEqual([]);
  });

  test('🔴 หน้าแรกเป็น static แต่สคริปต์ต้องรันได้จริง (ปุ่ม/ลิงก์ทำงาน)', async ({ page }) => {
    const console = watchConsole(page);

    await page.goto('/');
    // ลิงก์บนหน้าแรกใช้ next/link ผ่าน LinkProvider ⇒ ถ้า JS โดน CSP บล็อก การกดจะไม่พาไปไหน
    await page.getByRole('link', { name: 'ค้นหาก๊วนใกล้ตัว' }).click();
    await page.waitForURL(/\/discover/);

    expect(console.cspViolations).toEqual([]);
  });

  test('security header ครบทุกหน้า (ตรวจของจริงจาก response)', async ({ page }) => {
    const response = await page.goto('/discover');
    const headers = response!.headers();

    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("'strict-dynamic'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
