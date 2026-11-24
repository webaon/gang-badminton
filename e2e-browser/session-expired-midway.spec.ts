import { expect, test } from '@playwright/test';

import { signUp } from './helpers';

/**
 * เซสชันหมดอายุ "กลางคัน" — ผู้ใช้อยู่หน้าเดิมแล้วกดบันทึก
 * requireUser() ใน server action เรียก redirect('/sign-in') → runAction ตอบ UNAUTHENTICATED
 * → actionError() พาไป /session-expired?next=<หน้าเดิม> (ไม่ใช่ "ระบบขัดข้อง")
 */
test('กดบันทึกที่ /profile หลังเซสชันหมด → /session-expired?next=/profile และมีปุ่มกลับเข้าสู่ระบบพร้อม next เดิม', async ({
  page,
  context,
}) => {
  await signUp(page);
  await page.goto('/profile');
  await expect(page.getByLabel('ชื่อที่ใช้แสดง')).toBeVisible();

  await context.clearCookies();
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();

  await page.waitForURL((url) => url.pathname === '/session-expired');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/profile');
  await expect(page.getByText('ระบบขัดข้อง')).toBeHidden();

  const signIn = page.getByRole('link', { name: 'เข้าสู่ระบบ' });
  await expect(signIn).toHaveAttribute('href', `/sign-in?next=${encodeURIComponent('/profile')}`);
});
