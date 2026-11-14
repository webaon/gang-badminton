import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createGang, signUp, watchConsole } from './helpers';
import { seedDashboard } from './dashboard-fixture';

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

test('dashboard: populated real gang renders all twelve widgets and financial values', async ({ page }) => {
  test.setTimeout(180_000);
  const { gangId, nextId } = await seedDashboard(page);
  const watcher = watchConsole(page);
  await page.goto(`/gangs/${gangId}/dashboard`);
  const titles = ['สมาชิก', 'นัดเดือนนี้', 'ค้างจ่าย', 'สลิปรอตรวจ', 'เงินสดสุทธิเดือนนี้', 'เครดิตสมาชิกคงค้าง', 'นัดที่ยังไม่ปิดรอบ', 'คำขอเข้าก๊วน', 'นัดถัดไป', 'ผู้เล่นเฉลี่ยเดือนนี้', 'เงินเข้า / เงินออก · 6 เดือน', 'ความเคลื่อนไหวล่าสุด'];
  for (const title of titles) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(12);
  const metric = (title: string) => page.getByRole('heading', { name: title, exact: true }).locator('..');
  await expect(metric('สมาชิก')).toContainText('3 คน');
  await expect(metric('ค้างจ่าย')).toContainText('฿150.00');
  await expect(metric('สลิปรอตรวจ')).toContainText('1 รายการ');
  await expect(metric('เงินสดสุทธิเดือนนี้')).toContainText('฿130.00');
  await expect(metric('เครดิตสมาชิกคงค้าง')).toContainText('฿25.00');
  await expect(metric('คำขอเข้าก๊วน')).toContainText('1 คน');
  await expect(metric('นัดที่ยังไม่ปิดรอบ')).toContainText('1 นัด');
  await expect(metric('นัดถัดไป')).toContainText('ลงชื่อ 2 คน');
  await expect(metric('ผู้เล่นเฉลี่ยเดือนนี้')).not.toContainText('—');
  await expect(metric('ความเคลื่อนไหวล่าสุด')).not.toContainText('ยังไม่มีเหตุการณ์');
  await expect(page.getByRole('link', { name: 'ดูรายละเอียดนัด', exact: true })).toHaveAttribute('href', `/gangs/${gangId}/sessions/${nextId}`);
  await expect(page.getByRole('table')).toContainText('฿150.00');
  await expect(page.getByRole('table')).toContainText('฿20.00');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.SHOT_DIR) {
        await mkdir(process.env.SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.SHOT_DIR}/h10-populated-${width}-${colorScheme}.png`, fullPage: true });
      }
    }
  }
  expect(watcher.cspViolations).toEqual([]);
  expect(watcher.messages.filter(message => /pageerror:|hydration/i.test(message))).toEqual([]);
});
