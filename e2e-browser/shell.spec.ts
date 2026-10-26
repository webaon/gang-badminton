import { expect, test, type Page } from '@playwright/test';

import { createGang, signUp, watchConsole } from './helpers';

/**
 * WO-6.1a — app shell ใต้ `/gangs/[gangId]/*`
 *
 *   (ก) มือถือ 390×844: tab bar ล่าง กดแต่ละช่องไปถูก route · ไม่มี sidebar
 *   (ข) เดสก์ท็อป 1280×800: แอดมินเห็น sidebar · ไม่มี tab bar
 *   (ค) สลับก๊วนจากชื่อก๊วนใน header ได้
 *
 * ทุกเทสต์สมัครผู้ใช้ใหม่ + สร้างก๊วนของตัวเอง — ไม่แตะข้อมูลก๊วนจริง
 */

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function setupGang(page: Page) {
  const consoleWatcher = watchConsole(page);
  await signUp(page);
  const gang = await createGang(page);
  return { ...gang, consoleWatcher };
}

test.describe('มือถือ 390×844', () => {
  test.use({ viewport: MOBILE });

  test('tab bar ล่างมีช่อง นัด · ยอดเงิน · ฉัน และกดแล้วไปถูก route · ไม่มี sidebar', async ({ page }) => {
    const { gangId, consoleWatcher } = await setupGang(page);

    await page.goto(`/gangs/${gangId}/sessions`);

    // ชื่อก๊วนเป็นปุ่มใน header
    await expect(page.getByRole('button', { name: /^ก๊วนสโมค/ })).toBeVisible();

    // tab bar — เจ้าของก๊วนเห็น นัด/ยอดเงิน/ฉัน เสมอ (อันดับขึ้นกับ flag statistics)
    const tabs = page.getByRole('link', { name: /^(นัด|ยอดเงิน|อันดับ|ฉัน)$/ });
    await expect(page.getByRole('link', { name: 'นัด', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ยอดเงิน', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ฉัน', exact: true })).toBeVisible();
    expect(await tabs.count()).toBeGreaterThanOrEqual(3);

    // หน้าปัจจุบัน = "นัด" (aria-current)
    await expect(page.getByRole('link', { name: 'นัด', exact: true })).toHaveAttribute('aria-current', 'page');

    // แต่ละช่องพาไปถูก route
    await page.getByRole('link', { name: 'ยอดเงิน', exact: true }).click();
    await page.waitForURL(new RegExp(`/gangs/${gangId}/payments`));
    await expect(page.getByRole('link', { name: 'ยอดเงิน', exact: true })).toHaveAttribute('aria-current', 'page');

    const stats = page.getByRole('link', { name: 'อันดับ', exact: true });
    if (await stats.count()) {
      await stats.click();
      await page.waitForURL(new RegExp(`/gangs/${gangId}/stats`));
    }

    await page.getByRole('link', { name: 'นัด', exact: true }).click();
    await page.waitForURL(new RegExp(`/gangs/${gangId}/sessions`));

    await page.getByRole('link', { name: 'ฉัน', exact: true }).click();
    await page.waitForURL(/\/profile/);

    // sidebar ไม่โชว์บนมือถือ (เมนูแอดมินอยู่ใน drawer ที่ปิดอยู่)
    await page.goto(`/gangs/${gangId}/sessions`);
    await expect(page.getByRole('link', { name: 'แดชบอร์ด' })).toBeHidden();

    expect(consoleWatcher.cspViolations).toEqual([]);
  });

  test('ปุ่มเมนูเปิด drawer ที่มีเมนูแอดมินครบ', async ({ page }) => {
    const { gangId } = await setupGang(page);
    await page.goto(`/gangs/${gangId}/sessions`);

    await page.getByRole('button', { name: 'เปิดเมนู' }).click();
    await expect(page.getByRole('link', { name: 'สมาชิก', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'ตั้งค่า', exact: true })).toBeVisible();
  });
});

test.describe('เดสก์ท็อป 1280×800', () => {
  test.use({ viewport: DESKTOP });

  test('แอดมินเห็น sidebar ครบ · ไม่มี tab bar · active ตามหน้า', async ({ page }) => {
    const { gangId, consoleWatcher } = await setupGang(page);
    await page.goto(`/gangs/${gangId}/sessions`);

    for (const label of ['แดชบอร์ด', 'นัด', 'สมาชิก', 'เก็บเงิน', 'รายงาน', 'ประกาศ', 'ตั้งค่า', 'LINE']) {
      await expect(page.getByRole('link', { name: label, exact: true }), label).toBeVisible();
    }

    // ไม่มี tab bar ล่าง ("ยอดเงิน" เป็นชื่อแท็บมือถือ — sidebar ใช้ "เก็บเงิน")
    await expect(page.getByRole('link', { name: 'ยอดเงิน', exact: true })).toBeHidden();

    await expect(page.getByRole('link', { name: 'นัด', exact: true })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('link', { name: 'สมาชิก', exact: true }).click();
    await page.waitForURL(new RegExp(`/gangs/${gangId}/members`));
    await expect(page.getByRole('link', { name: 'สมาชิก', exact: true })).toHaveAttribute('aria-current', 'page');

    expect(consoleWatcher.cspViolations).toEqual([]);
  });
});

test('สลับก๊วนจากชื่อก๊วนใน header ได้ (#59)', async ({ page }) => {
  await page.setViewportSize(MOBILE);

  await signUp(page);
  const first = await createGang(page);
  const second = await createGang(page);
  expect(second.gangId).not.toBe(first.gangId);

  await page.goto(`/gangs/${first.gangId}/sessions`);
  await page.getByRole('button', { name: first.name }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('ก๊วนของฉัน')).toBeVisible();
  await expect(dialog.getByRole('link', { name: new RegExp(first.name) })).toBeVisible();

  await dialog.getByRole('link', { name: new RegExp(second.name) }).click();
  await page.waitForURL(new RegExp(`/gangs/${second.gangId}/sessions`));
  await expect(page.getByRole('button', { name: second.name })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
});
