import { expect, test, type Browser, type Page } from '@playwright/test';

import { createGang, signUp, uniqueSuffix } from './helpers';

/**
 * WO-6.4b — ปิดรอบ: console → ปิดรอบ → เห็นสรุปยอด (KPI + ตารางต่อคน) → ยืนยัน → นัดเข้าสถานะเก็บเงิน
 * + สมาชิกทั่วไปเปิด /close ไม่เห็นยอด · ด่าน "ไม่มีใครเช็คอิน" ยังอยู่ · 390px
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

  const title = `นัดปิดรอบ ${uniqueSuffix()}`;
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
  await page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
  await expect(page.getByText(/คุณลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });

  const sessionUrl = page.url();
  return { gangId, title, owner, sessionUrl, sessionPath: new URL(sessionUrl).pathname };
}

async function newContext(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe('ปิดรอบ (หน้า close)', () => {
  test('console → ปิดรอบ → เห็น KPI + ตารางต่อคน → ยืนยัน → เก็บเงิน · สมาชิกทั่วไปเปิดไม่เห็นยอด', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const { gangId, owner, sessionPath } = await setupOpenSession(page);

    // เช็คอินที่คอนโซล แล้วไปปิดรอบจากลิงก์บนคอนโซล
    await page.goto(`${sessionPath}/console`);
    await page.getByRole('button', { name: 'เช็คอินทุกคน' }).click();
    await expect(page.getByText('มาแล้ว 1/1 คน')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: 'ปิดรอบ', exact: true }).click();
    await page.waitForURL(/\/close$/);

    // KPI + ตารางต่อคน (ตัวเลขทุกตัวมาจาก preview ของ server)
    await expect(page.getByRole('heading', { level: 1, name: /^ปิดรอบ · / })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('เก็บรวม', { exact: true })).toBeVisible();
    await expect(page.getByText('฿150.00').first()).toBeVisible();
    await expect(page.getByText('1 คน').first()).toBeVisible();
    const table = page.getByRole('table');
    await expect(table).toContainText(owner.displayName);
    await expect(table).toContainText('มาเล่น (เช็คอินแล้ว)');
    // [B12] คอลัมน์แยกยอดต่อคน + KPI ค่าคอร์ท มาจาก preview (150 = ค่าคอร์ท เหมาจ่าย)
    await expect(table).toContainText('ค่าคอร์ท');
    await expect(page.getByText('ค่าคอร์ท', { exact: true }).first()).toBeVisible();
    // ไม่มีรหัสเหตุผลดิบหลุดขึ้นจอ
    await expect(page.getByText(/attended|no_show|late_cancel/)).toHaveCount(0);

    // สมาชิกทั่วไป: เปิด /close ไม่ได้ ⇒ กลับหน้านัด และไม่เห็นยอด
    const second = await newContext(browser);
    const member = await signUp(second.page);
    await page.goto(`/gangs/${gangId}/members`);
    await page.getByLabel('เพิ่มสมาชิกด้วยอีเมล').fill(member.email);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(page.getByText('เพิ่มสมาชิกแล้ว')).toBeVisible({ timeout: 15_000 });
    await second.page.goto(`${sessionPath}/close`);
    await second.page.waitForURL((url) => !url.pathname.endsWith('/close'), { timeout: 15_000 });
    expect(new URL(second.page.url()).pathname).toBe(sessionPath);
    await expect(second.page.getByText('เก็บรวม', { exact: true })).toHaveCount(0);
    // และคอนโซลของสมาชิกทั่วไปก็ไม่มีลิงก์ปิดรอบ (ถูกพากลับหน้านัดอยู่แล้ว)
    await second.page.goto(`${sessionPath}/console`);
    await second.page.waitForURL((url) => !url.pathname.endsWith('/console'), { timeout: 15_000 });
    await expect(second.page.getByRole('link', { name: 'ปิดรอบ', exact: true })).toHaveCount(0);
    await second.context.close();

    // ยืนยันปิดรอบ → กลับหน้านัด สถานะเก็บเงิน · เข้า /close อีกไม่ได้ (ปิดแล้ว)
    await page.goto(`${sessionPath}/close`);
    await page.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน' }).click();
    await page.waitForURL((url) => url.pathname === sessionPath, { timeout: 20_000 });
    await expect(page.getByText('กำลังเก็บเงิน').first()).toBeVisible({ timeout: 15_000 });

    await page.goto(`${sessionPath}/close`);
    await page.waitForURL((url) => url.pathname === sessionPath, { timeout: 15_000 });
  });

  test('ไม่มีใครเช็คอิน → เตือน + ต้องติ๊กยืนยันก่อนปุ่มปิดรอบกดได้ (ด่านเดิมยังอยู่)', async ({ page }) => {
    test.setTimeout(90_000);
    const { sessionPath } = await setupOpenSession(page);

    await page.goto(`${sessionPath}/close`);
    await expect(page.getByText('ตรวจก่อนยืนยัน').first()).toBeVisible({ timeout: 15_000 });
    const confirm = page.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน' });
    await expect(confirm).toBeDisabled();
    await page.getByRole('checkbox', { name: 'เข้าใจแล้ว — ยืนยันปิดรอบทั้งที่ไม่มีใครเช็คอิน' }).check();
    await expect(confirm).toBeEnabled();
  });

  test('390px: หน้าปิดรอบไม่มี horizontal scroll', async ({ page }) => {
    test.setTimeout(90_000);
    const { sessionPath } = await setupOpenSession(page);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [`${sessionPath}/close`, `${sessionPath}/console`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test('preview ปิดรอบล้ม (network abort ตอนกดยืนยัน) → ขึ้นข้อความ ปุ่มกดใหม่ได้ ไม่ค้าง', async ({ page }) => {
    test.setTimeout(90_000);
    const { sessionPath } = await setupOpenSession(page);

    await page.goto(`${sessionPath}/close`);
    await page.getByRole('checkbox', { name: 'เข้าใจแล้ว — ยืนยันปิดรอบทั้งที่ไม่มีใครเช็คอิน' }).check();

    let aborted = false;
    await page.route(`**${sessionPath}/close`, async (route) => {
      const req = route.request();
      if (!aborted && req.method() === 'POST' && req.headers()['next-action']) {
        aborted = true;
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });

    const confirm = page.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน' });
    await confirm.click();
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
    expect(aborted).toBe(true);
    await expect(confirm).toBeEnabled();
  });

  // WO-6.4b.1 — ชื่อกับยอดต้องอยู่ใน viewport พร้อมกันทั้งมือถือ (การ์ด) และจอใหญ่ (ตาราง ยอดถัดชื่อ)
  for (const viewport of [
    { name: '390', width: 390, height: 844, mobile: true },
    { name: '1280', width: 1280, height: 800, mobile: false },
  ]) {
    test(`${viewport.name}px: ชื่อ + ยอดต่อคนเห็นพร้อมกัน · ป้าย "ในรายการ N คน" · ${viewport.mobile ? 'การ์ด' : 'ตาราง'}`, async ({ page }) => {
      test.setTimeout(120_000);
      const { owner, sessionPath } = await setupOpenSession(page);
      await page.goto(`${sessionPath}/console`);
      await page.getByRole('button', { name: 'เช็คอินทุกคน' }).click();
      await expect(page.getByText('มาแล้ว 1/1 คน')).toBeVisible({ timeout: 15_000 });

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${sessionPath}/close`);
      await expect(page.getByText('ในรายการ 1 คน').first()).toBeVisible({ timeout: 15_000 });

      const container = viewport.mobile ? page.getByLabel('การ์ดยอดต่อคน').first() : page.getByRole('table');
      await expect(container).toBeVisible();
      // อีกรูปแบบต้องซ่อน (สลับด้วย CSS)
      await expect(viewport.mobile ? page.getByRole('table') : page.getByLabel('การ์ดยอดต่อคน').first()).toBeHidden();

      const name = container.getByText(owner.displayName);
      const amount = container.getByText('฿150.00').first();
      await expect(name).toBeInViewport();
      await expect(amount).toBeInViewport();

      const nameBox = await name.boundingBox();
      const amountBox = await amount.boundingBox();
      expect(nameBox && amountBox).toBeTruthy();
      // ยอดอยู่ถัดชื่อ: ไม่เกิน 1 หน้าจอห่างกัน และไม่มี horizontal scroll ของหน้า
      expect(Math.abs((amountBox!.x ?? 0) - (nameBox!.x ?? 0))).toBeLessThan(viewport.width);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
