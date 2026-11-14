import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createGang, signUp, watchConsole } from './helpers';

test('dashboard: real loader, sidebar navigation, responsive states and outsider 404', async ({ page, browser }) => {
  const watcher = watchConsole(page);
  await signUp(page);
  const { gangId } = await createGang(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/gangs/${gangId}/sessions`);
  await page.getByRole('link', { name: 'แดชบอร์ด', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/gangs/${gangId}/dashboard$`));
  await expect(page.getByRole('heading', { name: 'แดชบอร์ด', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'เงินสดสุทธิเดือนนี้', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'เงินเข้า / เงินออก · 6 เดือน', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'นัดถัดไป', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ผู้เล่นเฉลี่ยเดือนนี้', exact: true })).toBeVisible();
  await expect(page.getByText('—', { exact: true })).toBeVisible();
  await expect(page.getByText(/กำไร/)).toHaveCount(0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.SHOT_DIR) {
        await mkdir(process.env.SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.SHOT_DIR}/h10-${width}-${colorScheme}.png`, fullPage: true });
      }
    }
  }
  const outsider = await browser.newContext();
  try {
    const otherPage = await outsider.newPage();
    await signUp(otherPage);
    const response = await otherPage.goto(`/gangs/${gangId}/dashboard`);
    expect(response?.status()).toBe(404);
  } finally {
    await outsider.close();
  }
  expect(watcher.cspViolations).toEqual([]);
  expect(watcher.messages.filter(message => /pageerror:|hydration/i.test(message))).toEqual([]);
});
