import { expect, test, type Page } from '@playwright/test';

import { createGang, signUp, uniqueSuffix, watchConsole } from './helpers';

/**
 * WO-6.3 — หน้าจ่ายเงินฝั่งสมาชิก: ปิดรอบ → ขอ QR → ตรวจไฟล์สลิป → ส่งสลิป → แอดมินยืนยัน → verified
 * (เคส "2 นัดค้าง หน้าจ่ายนัดเก่าต้องโชว์ยอดนัดเก่า" + H29 รอ WO-R3)
 */

function localDateTime(hoursFromNow: number): string {
  const at = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// PNG 1x1 จริง (ผ่านการตรวจชนิดไฟล์ของ bucket)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function closedSessionWithPromptPay(page: Page) {
  const owner = await signUp(page);
  const { gangId } = await createGang(page);

  await page.goto(`/gangs/${gangId}/settings`);
  await page.getByLabel('พร้อมเพย์').fill('0812345678');
  await page.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click();
  await expect(page.getByText('บันทึกแล้ว').first()).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('ชื่อแผน').fill('เหมาจ่าย');
  await page.getByLabel('ราคาต่อคน (บาท)').fill('150');
  await page.getByRole('button', { name: 'บันทึกแผนราคา' }).click();
  await page.waitForLoadState('networkidle');

  const title = `นัดจ่ายเงิน ${uniqueSuffix()}`;
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
  const sessionPath = new URL(page.url()).pathname;

  await page.goto(`${sessionPath}/console`);
  await page.getByRole('button', { name: 'เช็คอินทุกคน' }).click();
  await expect(page.getByText('มาแล้ว 1/1 คน')).toBeVisible({ timeout: 15_000 });

  await page.goto(`${sessionPath}/close`);
  await page.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน' }).click();
  await page.waitForURL((url) => url.pathname === sessionPath, { timeout: 20_000 });

  return { gangId, title, owner, sessionPath };
}

test.describe('จ่ายเงินฝั่งสมาชิก (หน้า pay)', () => {
  test('ขอ QR → ตรวจไฟล์ → ส่งสลิป → แอดมินยืนยัน → verified', async ({ page }) => {
    test.setTimeout(150_000);
    const watcher = watchConsole(page);
    const { gangId, title, sessionPath } = await closedSessionWithPromptPay(page);

    await page.goto(`${sessionPath}/pay`);
    await expect(page.getByRole('heading', { level: 1, name: 'จ่ายเงิน' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(title).first()).toBeVisible();
    await expect(page.getByText('฿150.00').first()).toBeVisible();

    // ขอ QR → QR + คัดลอกเลข + บันทึกรูป + ขั้นสถานะ
    await page.getByRole('button', { name: 'ขอ QR จ่ายเงิน' }).click();
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('0812345678')).toBeVisible();
    await expect(page.getByRole('button', { name: 'บันทึกรูป QR' })).toBeVisible();
    await expect(page.getByRole('button', { name: /คัดลอกเลขพร้อมเพย์/ })).toBeVisible();
    await expect(page.getByText('ส่งสลิป', { exact: true }).first()).toBeVisible();
    const send = page.getByRole('button', { name: 'ส่งสลิป' });
    await expect(send).toBeDisabled();

    // ไฟล์ >5MB ถูกปฏิเสธก่อนอัป (ข้อความไทย ตัวเลขตรงกับ bucket) · HEIC ถูกปฏิเสธ
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await expect(page.getByText('ไฟล์ใหญ่กว่า 5MB').first()).toBeVisible();
    await expect(send).toBeDisabled();
    await fileInput.setInputFiles({ name: 'IMG_4402.heic', mimeType: 'image/heic', buffer: Buffer.alloc(100) });
    await expect(page.getByText(/ชนิดไฟล์ไม่รองรับ/).first()).toBeVisible();
    await expect(send).toBeDisabled();

    // ไฟล์ถูกต้อง → preview + ปุ่มส่งเปิด → ส่ง → รอแอดมินยืนยัน
    await fileInput.setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await expect(page.getByRole('img', { name: 'ตัวอย่างสลิป' })).toBeVisible();
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByText('รอแอดมินยืนยัน').first()).toBeVisible({ timeout: 20_000 });

    // แอดมิน (เจ้าของก๊วน) ยืนยัน → หน้าจ่ายขึ้นยืนยันแล้ว ไม่มีปุ่มส่งสลิป
    await page.goto(`/gangs/${gangId}/payments`);
    await page.getByRole('button', { name: 'ยืนยันการจ่าย' }).first().click();
    await expect(page.getByText('ยืนยันแล้ว').first()).toBeVisible({ timeout: 15_000 });

    await page.goto(`${sessionPath}/pay`);
    await expect(page.getByText('ยืนยันการจ่ายแล้ว')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'ส่งสลิป' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toHaveCount(0);

    expect(watcher.cspViolations).toEqual([]);
  });

  test('ส่งสลิปล้ม (network abort) → ขึ้นข้อความ ปุ่มกดใหม่ได้ ไม่ค้างที่ "กำลังอัปโหลด"', async ({ page }) => {
    test.setTimeout(150_000);
    const { sessionPath } = await closedSessionWithPromptPay(page);

    await page.goto(`${sessionPath}/pay`);
    await page.getByRole('button', { name: 'ขอ QR จ่ายเงิน' }).click();
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toBeVisible({ timeout: 15_000 });

    let aborted = false;
    await page.route(`**${sessionPath}/pay`, async (route) => {
      const req = route.request();
      if (!aborted && req.method() === 'POST' && req.headers()['next-action']) {
        aborted = true;
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });

    await page.locator('input[type="file"]').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: PNG_1X1 });
    const send = page.getByRole('button', { name: /^ส่งสลิป$/ });
    await send.click();
    await expect(page.getByText('ส่งสลิปไม่สำเร็จ')).toBeVisible({ timeout: 15_000 });
    expect(aborted).toBe(true);
    await expect(send).toBeEnabled();
  });

  test('390px: หน้าจ่ายเงินไม่มี horizontal scroll', async ({ page }) => {
    test.setTimeout(150_000);
    const { sessionPath } = await closedSessionWithPromptPay(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${sessionPath}/pay`);
    await page.getByRole('button', { name: 'ขอ QR จ่ายเงิน' }).click();
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
