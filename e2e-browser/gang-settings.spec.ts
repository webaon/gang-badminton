import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createGang, signUp, uniqueSuffix, watchConsole } from './helpers';

async function capture(page: Page, screen: string, anchor?: string) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      if (anchor) await page.locator(`#${anchor}`).scrollIntoViewIfNeeded();
      else await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.SHOT_DIR) {
        await mkdir(process.env.SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.SHOT_DIR}/${screen}-${width}-${colorScheme}.png` });
      }
    }
  }
}

test('gang settings: supported fields persist; members and outsiders retain their access boundaries', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const watcher = watchConsole(page);
  await signUp(page);
  const { gangId } = await createGang(page);
  const memberContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    const member = await signUp(memberPage);
    const outsiderPage = await outsiderContext.newPage();
    await signUp(outsiderPage);
    for (const route of ['members', 'settings']) {
      const response = await outsiderPage.goto(`/gangs/${gangId}/${route}`);
      expect(response?.status()).toBe(404);
      await expect(outsiderPage.getByRole('heading', { name: 'ไม่พบหน้านี้' })).toBeVisible();
    }

    await page.goto(`/gangs/${gangId}/settings`);
    await expect(page.getByRole('heading', { name: 'ตั้งค่าก๊วน', exact: true })).toBeVisible();
    const newName = `ก๊วนตั้งค่า ${uniqueSuffix()}`;
    await page.getByRole('textbox', { name: /^ชื่อก๊วน\s*จำเป็น$/ }).fill(newName);
    await page.getByRole('textbox', { name: /^พื้นที่(?:\s*ไม่บังคับ)?$/ }).fill('กรุงเทพ');
    await page.getByRole('textbox', { name: 'ยกเลิกฟรีก่อนเริ่มนัด (ชั่วโมง)', exact: true }).fill('8');
    await page.getByRole('button', { name: 'บันทึกการตั้งค่า', exact: true }).click();
    await expect(page.getByText('บันทึกแล้ว', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('textbox', { name: /^ชื่อก๊วน\s*จำเป็น$/ })).toHaveValue(newName);
    await expect(page.getByRole('textbox', { name: 'ยกเลิกฟรีก่อนเริ่มนัด (ชั่วโมง)', exact: true })).toHaveValue('8');

    await page.getByRole('textbox', { name: /^ชื่อแผน\s*จำเป็น$/ }).fill('เหมาจ่ายทดสอบ');
    await page.getByRole('textbox', { name: /^ราคาต่อคน \(บาท\)\s*จำเป็น$/ }).fill('175.00');
    await page.getByRole('button', { name: 'บันทึกแผนราคา', exact: true }).click();
    await expect(page.getByText('บันทึกแผนราคาแล้ว', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('textbox', { name: /^ชื่อแผน\s*จำเป็น$/ })).toHaveValue('เหมาจ่ายทดสอบ');
    await expect(page.getByRole('textbox', { name: /^ราคาต่อคน \(บาท\)\s*จำเป็น$/ })).toHaveValue('175.00');

    const skill = `ระดับทดสอบ ${uniqueSuffix()}`;
    const skillSection = page.locator('#skills-settings');
    await skillSection.getByRole('textbox', { name: 'เพิ่มระดับฝีมือ', exact: true }).fill(skill);
    await skillSection.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(skillSection.getByText(new RegExp(skill))).toBeVisible();
    await page.reload();
    await expect(page.locator('#skills-settings').getByText(new RegExp(skill))).toBeVisible();
    for (const id of ['general-settings', 'cancellation-settings', 'pricing-settings', 'skills-settings', 'monthly-settings', 'line-settings']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    for (const [screen, anchor] of [['h14', 'pricing-settings'], ['h15', 'cancellation-settings'], ['h16', 'general-settings']]) {
      await capture(page, screen, anchor);
    }

    await page.goto(`/gangs/${gangId}/members`);
    await page.getByRole('textbox', { name: 'เพิ่มสมาชิกด้วยอีเมล', exact: true }).fill(member.email);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(page.getByText(member.displayName, { exact: true })).toBeVisible();
    await capture(page, 'h11');
    for (const button of await page.getByRole('button').all()) {
      if (!await button.isVisible()) continue;
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await memberPage.goto(`/gangs/${gangId}/members`);
    await expect(memberPage.getByText(`${member.displayName} (คุณ)`, { exact: true })).toBeVisible();
    await expect(memberPage.getByText(/\(คุณ\)$/)).toHaveCount(1);
    await expect(memberPage.getByRole('textbox', { name: 'เพิ่มสมาชิกด้วยอีเมล', exact: true })).toHaveCount(0);
    await memberPage.goto(`/gangs/${gangId}/settings`);
    await expect(memberPage.getByText('เฉพาะแอดมินของก๊วนเท่านั้นที่แก้ตั้งค่าได้', { exact: true })).toBeVisible();
    await expect(memberPage.getByRole('button', { name: 'บันทึกการตั้งค่า', exact: true })).toHaveCount(0);
    expect(watcher.cspViolations).toEqual([]);
    expect(watcher.messages.filter(message => /pageerror:|hydration/i.test(message))).toEqual([]);
  } finally {
    await memberContext.close();
    await outsiderContext.close();
  }
});
