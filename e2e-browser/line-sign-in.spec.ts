import { expect, test } from '@playwright/test';

import { watchConsole } from './helpers';

/**
 * WO-B1.a — ปุ่ม "เข้าสู่ระบบด้วย LINE" (ADR-013) ในเบราว์เซอร์จริง
 *
 * 🔴 ไม่ยิง LINE จริง และไม่ต้องมี provider ใน Supabase: ดักคำขอไป `/auth/v1/authorize` ของ Supabase local
 *    ไว้ตอบเอง แล้วดูว่าเบราว์เซอร์ **พาไปถึงที่นั่น** โดยไม่มี CSP violation
 *    (ถ้าใครเปลี่ยนปุ่มเป็น `<form action>` — `form-action 'self'` จะบล็อก หรือ `connect-src` ผิด — เทสต์นี้ต้องแดง)
 *
 * ต้องการ `LINE_PLATFORM_LOGIN_ENABLED=true` + `APP_BASE_URL` ที่ webServer ใน `playwright.config.ts`
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';

test.describe('WO-B1.a — LINE sign-in บน /sign-in', () => {
  test('มีปุ่ม LINE บนสุด และปุ่มอีเมลเดิมยังอยู่ (เป็นทางสำรอง)', async ({ page }) => {
    await page.goto('/sign-in');

    await expect(page.getByRole('button', { name: 'เข้าสู่ระบบด้วย LINE' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ส่งลิงก์เข้าอีเมลแทน' })).toBeVisible();
  });

  test('🔴 กดปุ่ม → เบราว์เซอร์ไปที่ authorize ของ Supabase (provider=custom:line, PKCE) โดยไม่มี CSP violation', async ({
    page,
    context,
  }) => {
    const consoleWatch = watchConsole(page);
    let authorizeUrl: URL | null = null;

    await page.route(`${SUPABASE_URL}/auth/v1/authorize**`, async (route) => {
      authorizeUrl = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stub authorize</h1>' });
    });

    await page.goto('/sign-in?next=%2Fgangs');
    await page.getByRole('button', { name: 'เข้าสู่ระบบด้วย LINE' }).click();
    await page.waitForURL(`${SUPABASE_URL}/auth/v1/authorize**`);

    expect(authorizeUrl).not.toBeNull();
    const url = authorizeUrl as unknown as URL;
    expect(url.searchParams.get('provider')).toBe('custom:line');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('redirect_to')).toMatch(/\/auth\/callback\?next=%2Fgangs$/);

    // code verifier ของ PKCE ต้องอยู่ใน cookie (ไม่ใช่ใน URL)
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name.endsWith('-auth-token-code-verifier'))).toBe(true);

    expect(consoleWatch.cspViolations).toEqual([]);
  });

  test('?error=line_denied แสดงข้อความตายตัว', async ({ page }) => {
    await page.goto('/sign-in?error=line_denied');
    await expect(page.getByText('ยกเลิกการเข้าสู่ระบบด้วย LINE แล้ว')).toBeVisible();
  });

  test('🔴 ?error= ที่ไม่รู้จัก ไม่ถูก echo ลงหน้า', async ({ page }) => {
    const payload = '<img src=x onerror=alert(1)>EVIL-MARKER';
    await page.goto(`/sign-in?error=${encodeURIComponent(payload)}`);

    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
    await expect(page.getByText('EVIL-MARKER')).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
  });

  test('🔴 /auth/callback?error=access_denied → กลับ /sign-in พร้อมข้อความ ไม่ error 500', async ({ page }) => {
    await page.goto('/auth/callback?error=access_denied&error_description=EVIL-DESC');

    await page.waitForURL(/\/sign-in\?error=line_denied$/);
    await expect(page.getByText('ยกเลิกการเข้าสู่ระบบด้วย LINE แล้ว')).toBeVisible();
    await expect(page.getByText('EVIL-DESC')).toHaveCount(0);
  });
});
