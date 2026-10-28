import { expect, test } from '@playwright/test';

import { signUp } from './helpers';

/**
 * ปิด open redirect หลังล็อกอิน: `/sign-in?next=<ปลายทางนอกโดเมน>` ต้องไม่พาออกนอกเว็บ
 * (app/sign-in/page.tsx ส่ง `next` ผ่าน safeNext() ก่อนถึง client)
 * ไฟล์นี้ไม่พึ่ง spec อื่น — cherry-pick ลง main ได้เดี่ยวๆ
 */
const EVIL = [
  'https://evil.example/phish',
  '//evil.example',
  'javascript:alert(1)',
  '/\t/evil.example', // %2F%09%2Fevil.example — URL parser ตัด \t ทิ้งจนกลายเป็น //
  '/\n/evil.example',
  '/\r/evil.example',
  '/\\evil.example', // %5C — backslash ที่เบราว์เซอร์บางตัวตีความเป็น /
];

test.describe('sign-in ?next= ไม่ทำให้ออกนอกโดเมน', () => {
  for (const evil of EVIL) {
    test(`next=${JSON.stringify(evil)} → ล็อกอินเสร็จอยู่ในเว็บเรา (/profile)`, async ({ page, context }) => {
      const { email } = await signUp(page);
      await context.clearCookies();
      const origin = new URL(page.url()).origin;

      await page.goto(`/sign-in?next=${encodeURIComponent(evil)}`);
      await page.getByLabel('อีเมล').fill(email);
      await page.getByLabel('รหัสผ่าน').fill('e2e-password-1234');
      await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

      await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
      const here = new URL(page.url());
      expect(here.origin).toBe(origin);
      expect(here.pathname).toBe('/profile');
    });
  }

  test('next เป็น path ภายในที่ถูกต้อง ยังใช้ได้ (ไม่ over-block)', async ({ page, context }) => {
    const { email } = await signUp(page);
    await context.clearCookies();

    await page.goto(`/sign-in?next=${encodeURIComponent('/gangs')}`);
    await page.getByLabel('อีเมล').fill(email);
    await page.getByLabel('รหัสผ่าน').fill('e2e-password-1234');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

    await page.waitForURL((url) => url.pathname === '/gangs');
  });
});
