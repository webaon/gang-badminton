import { expect, test, type Browser, type Page } from '@playwright/test';

import { createGang, signUp, uniqueSuffix } from './helpers';

/**
 * WO-6.4a — วันเล่นของแอดมิน: เช็คอิน 4 คน → จัดคู่ → จบเกมใส่ลูก 2 → แก้เป็น 3 → กระดานคิวสดตรงกับคอนโซล
 * + สมาชิกทั่วไป/ผู้ไม่ล็อกอินเปิดคอนโซลและกระดานไม่ได้ · 390px ไม่มี horizontal scroll
 * ทุกเทสต์สมัครผู้ใช้ใหม่/สร้างก๊วนของตัวเอง ไม่แตะข้อมูลจริง
 */

function localDateTime(hoursFromNow: number): string {
  const at = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

async function setupOpenSession(page: Page) {
  const owner = await signUp(page);
  const { gangId } = await createGang(page);

  await page.goto(`/gangs/${gangId}/settings`);
  await page.getByLabel('ชื่อแผน').fill('เหมาจ่าย');
  await page.getByLabel('ราคาต่อคน (บาท)').fill('150');
  await page.getByRole('button', { name: 'บันทึกแผนราคา' }).click();
  await page.waitForLoadState('networkidle');

  const title = `นัดวันเล่น ${uniqueSuffix()}`;
  await page.goto(`/gangs/${gangId}/sessions`);
  await expect(page.getByLabel('ชื่อนัด')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('ชื่อนัด').fill(title);
  await page.getByLabel(/^เริ่ม \(/).fill(localDateTime(30));
  await page.getByLabel(/^จบ \(/).fill(localDateTime(33));
  await page.getByLabel('รับสูงสุด (คน)').fill('8');
  await page.getByRole('button', { name: 'สร้างนัด (ยังไม่เปิดรับ)' }).click();

  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'เปิดรับสมัคร' }).first().click();
  await expect(page.getByRole('button', { name: 'เปิดรับสมัคร' })).toBeHidden({ timeout: 15_000 });

  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });

  return { gangId, title, owner, sessionUrl: page.url() };
}

async function newAnonymous(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** ชื่อทั้ง 4 คนบนการ์ดคอร์ทของคอนโซล (ปุ่มชื่อผู้เล่น) */
async function consoleCourtNames(page: Page, courtNo: number): Promise<string[]> {
  const card = page.getByLabel(`คอร์ท ${courtNo}`).first();
  const names = await card.getByRole('button').allInnerTexts();
  // ปุ่มอื่นในการ์ด (ลูก/จบเกม) ไม่ใช่ชื่อคน
  return names.map((n) => n.trim()).filter((n) => n && !/ลูก|จบเกม/.test(n));
}

test.describe('วันเล่น: คอนโซล + กระดานคิวสด', () => {
  test('เช็คอิน 4 คน → จัดคู่ → จบเกมลูก 2 → แก้เป็น 3 → กระดานตรงกับคอนโซล · สมาชิกทั่วไปเข้าไม่ได้', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const { gangId, owner, sessionUrl } = await setupOpenSession(page);
    const consoleUrl = `/gangs/${gangId}/sessions/${sessionUrl.split('/').pop()}/console`;
    const boardUrl = `${consoleUrl}/board`;

    // เจ้าของลงชื่อ + guest 3 คนผ่านลิงก์เชิญ ⇒ 4 คน
    await page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
    await expect(page.getByText(/คุณลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'สร้างลิงก์เชิญ' }).click();
    const code = page.locator('code, [class*="code"]').filter({ hasText: '/join/' }).first();
    await expect(code).toBeVisible({ timeout: 15_000 });
    const joinUrl = (await code.innerText()).trim();

    for (const guest of ['อัลฟา', 'เบต้า', 'แกมมา']) {
      const anon = await newAnonymous(browser);
      await anon.page.goto(joinUrl);
      await anon.page.getByLabel('ชื่อที่ให้เรียก').fill(guest);
      await anon.page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
      await expect(anon.page.getByText(/ลงชื่อเรียบร้อย|ลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });
      await anon.context.close();
    }

    // ── 23 เช็คอิน ────────────────────────────────────────────────
    await page.goto(consoleUrl);
    await expect(page.getByRole('heading', { name: 'เช็คอิน' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('มาแล้ว 0/4 คน')).toBeVisible();
    await page.getByRole('button', { name: 'เช็คอินทุกคน' }).click();
    await expect(page.getByText('มาแล้ว 4/4 คน')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'เช็คอินทุกคน' })).toBeHidden();

    // ── 27 เวลาพัก: ทุกคนในคิวมี "เล่นแล้ว N เกม · พักมา/เพิ่งพัก" ──────────
    await expect(page.getByRole('heading', { name: 'คิวรอ (4)' })).toBeVisible();
    await expect(page.getByText(/เล่นแล้ว 0 เกม · (เพิ่งพัก|พักมา \d+ นาที)/)).toHaveCount(4);

    // ── 25 จัดคู่ ────────────────────────────────────────────────
    await page.getByRole('button', { name: 'จัดคู่รอบใหม่' }).click();
    await expect(page.getByRole('heading', { name: 'คิวรอ (0)' })).toBeVisible({ timeout: 15_000 });
    const court1 = page.getByLabel('คอร์ท 1').first();
    await expect(court1.getByText('กำลังเล่น')).toBeVisible();
    const consoleNames = await consoleCourtNames(page, 1);
    expect(consoleNames).toHaveLength(4);
    expect(consoleNames).toContain('อัลฟา');

    // ── 24 กระดานคิวสด: คอร์ท 1 กำลังเล่น ตรงกับคอนโซล · คิวว่าง ──────────
    await page.goto(boardUrl);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'คิวถัดไป · 0 คน' })).toBeVisible();
    const boardCourt1 = page.getByLabel('คอร์ท 1').first();
    await expect(boardCourt1.getByText('กำลังเล่น')).toBeVisible();
    for (const name of consoleNames) await expect(boardCourt1).toContainText(name);
    // อ่านอย่างเดียว: กระดานไม่มีปุ่มแก้ไข (มีแค่ "กลับคอนโซล")
    await expect(page.getByRole('button', { name: /จบเกม|จัดคู่|เช็คอิน|บันทึก/ })).toHaveCount(0);

    // ── 26 จบเกม ใส่ลูก 2 ────────────────────────────────────────
    await page.goto(consoleUrl);
    await page.getByLabel('คอร์ท 1').first().getByLabel('ลูกที่ใช้').fill('2');
    await page.getByLabel('คอร์ท 1').first().getByRole('button', { name: 'จบเกม' }).click();
    await expect(page.getByRole('heading', { name: 'เกมที่จบแล้ว (1)' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'คิวรอ (4)' })).toBeVisible();

    // ── แก้จำนวนลูกของเกมที่จบแล้ว 2 → 3 (ก่อนปิดรอบ) ─────────────────────
    const finished = page.getByRole('heading', { name: 'เกมที่จบแล้ว (1)' }).locator('xpath=ancestor::*[contains(@class,"astryx-card")][1]');
    const shuttleField = finished.getByLabel('ลูกที่ใช้');
    await expect(shuttleField).toHaveValue('2');
    await shuttleField.fill('3');
    await finished.getByRole('button', { name: 'บันทึก' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'เกมที่จบแล้ว (1)' })).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('heading', { name: 'เกมที่จบแล้ว (1)' }).locator('xpath=ancestor::*[contains(@class,"astryx-card")][1]').getByLabel('ลูกที่ใช้'),
    ).toHaveValue('3');

    // ── 24 กระดานหลังจบเกม: คอร์ท 1 ว่าง · คิว 4 คนตรงกับคอนโซล ────────────
    await page.goto(boardUrl);
    await expect(page.getByRole('heading', { name: 'คิวถัดไป · 4 คน' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('คอร์ท 1').first().getByText('ว่าง')).toBeVisible();
    for (const name of consoleNames) await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/เล่นแล้ว 1 เกม · (เพิ่งพัก|พักมา \d+ นาที)/)).toHaveCount(4);

    // ── สมาชิกทั่วไป (ไม่มี game.manage) เปิดคอนโซล/กระดานไม่ได้ ⇒ กลับหน้ารายละเอียดนัด ──
    const second = await browser.newContext();
    const page2 = await second.newPage();
    const member = await signUp(page2);
    await page.goto(`/gangs/${gangId}/members`);
    await page.getByLabel('เพิ่มสมาชิกด้วยอีเมล').fill(member.email);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(page.getByText('เพิ่มสมาชิกแล้ว')).toBeVisible({ timeout: 15_000 });

    for (const path of [consoleUrl, boardUrl]) {
      await page2.goto(path);
      await page2.waitForURL((url) => !url.pathname.includes('/console'), { timeout: 15_000 });
      expect(new URL(page2.url()).pathname).toBe(new URL(sessionUrl).pathname);
      await expect(page2.getByText('อัลฟา')).toBeVisible();
      await expect(page2.getByRole('heading', { name: /คิวถัดไป/ })).toHaveCount(0);
    }
    await second.close();

    // ── ผู้ไม่ล็อกอิน: กระดานไม่ใช่หน้า public ⇒ ส่งไป /sign-in ─────────────
    const anon = await newAnonymous(browser);
    await anon.page.goto(boardUrl);
    await anon.page.waitForURL(/\/sign-in/, { timeout: 15_000 });
    await expect(anon.page.getByText('อัลฟา')).toHaveCount(0);
    await anon.context.close();

    // ── 390px: คอนโซล + กระดาน + สแกน ไม่มี horizontal scroll ────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of [consoleUrl, boardUrl, `${consoleUrl.replace(/console$/, 'scan')}`]) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, url).toBeLessThanOrEqual(0);
    }

    expect(owner.displayName).toBeTruthy();
  });
});
