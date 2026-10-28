import { expect, test, type Browser, type Page } from '@playwright/test';

import { createGang, signUp, uniqueSuffix } from './helpers';

/**
 * WO-6.2 — เส้นหลักของสมาชิกบนหน้านัด: ลงชื่อ → ยกเลิก · นัดเต็ม → ได้ลำดับคิว · guest ต้องผ่านขั้นยืนยัน
 * ทุกเทสต์สมัครผู้ใช้ใหม่/สร้างก๊วนของตัวเอง ไม่แตะข้อมูลจริง
 */

function localDateTime(hoursFromNow: number): string {
  const at = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** เจ้าของก๊วนสมัคร → สร้างก๊วน → ตั้งราคา → สร้างนัด → เปิดรับ ⇒ คืน url หน้านัด */
async function setupOpenSession(page: Page, maxPlayers: number) {
  const owner = await signUp(page);
  const { gangId } = await createGang(page);

  await page.goto(`/gangs/${gangId}/settings`);
  await page.getByLabel('ชื่อแผน').fill('เหมาจ่าย');
  await page.getByLabel('ราคาต่อคน (บาท)').fill('150');
  await page.getByRole('button', { name: 'บันทึกแผนราคา' }).click();
  await page.waitForLoadState('networkidle');

  const title = `นัดสโมค ${uniqueSuffix()}`;
  await page.goto(`/gangs/${gangId}/sessions`);
  await expect(page.getByLabel('ชื่อนัด')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('ชื่อนัด').fill(title);
  await page.getByLabel(/^เริ่ม \(/).fill(localDateTime(30));
  await page.getByLabel(/^จบ \(/).fill(localDateTime(33));
  await page.getByLabel('รับสูงสุด (คน)').fill(String(maxPlayers));
  await page.getByRole('button', { name: 'สร้างนัด (ยังไม่เปิดรับ)' }).click();

  await expect(page.getByRole('link', { name: title }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'เปิดรับสมัคร' }).first().click();
  await expect(page.getByRole('button', { name: 'เปิดรับสมัคร' })).toBeHidden({ timeout: 15_000 });

  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });

  return { gangId, title, owner, sessionUrl: page.url() };
}

test.describe('หน้านัดฝั่งสมาชิก', () => {
  test('ลงชื่อ → เห็นสถานะ + ปุ่มยกเลิก → ยกเลิกต้องผ่านขั้นยืนยัน → กลับมาลงชื่อได้', async ({ page }) => {
    const { gangId } = await setupOpenSession(page, 8);

    // ปุ่มหลักเดียว: ยังไม่ได้ลง ⇒ มี "ลงชื่อเข้านัด" และยังไม่มี "ยกเลิกการลงชื่อ"
    await expect(page.getByRole('button', { name: 'ลงชื่อเข้านัด' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ยกเลิกการลงชื่อ' })).toBeHidden();

    await page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
    await expect(page.getByText(/คุณลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'ลงชื่อเข้านัด' })).toBeHidden();

    // ยกเลิก: กดแล้วต้องมี dialog ยืนยันก่อน (ยังไม่ยกเลิกจริง)
    await page.getByRole('button', { name: 'ยกเลิกการลงชื่อ' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // ผลก่อนยกเลิกมาจาก server (cancelPreview): นัดอยู่ห่าง 30 ชม. > cutoff ⇒ ยกเลิกฟรี พร้อมเวลา
    await expect(dialog).toContainText('ยกเลิกฟรีถึง', { timeout: 15_000 });
    await expect(dialog).not.toContainText(/฿|บาท/);
    await dialog.getByRole('button', { name: 'ไม่ยกเลิก' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/คุณลงชื่อแล้ว/)).toBeVisible();

    await page.getByRole('button', { name: 'ยกเลิกการลงชื่อ' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันยกเลิก' }).click();
    await expect(page.getByRole('button', { name: 'ลงชื่อเข้านัด' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/คุณลงชื่อแล้ว/)).toBeHidden();

    // ลิสต์นัดเห็นสถานะ + ไม่มี horizontal scroll ที่ 390px
    await page.goto(`/gangs/${gangId}/sessions`);
    await expect(page.getByRole('button', { name: 'ลงชื่อ', exact: true }).or(page.getByRole('link', { name: 'ลงชื่อ', exact: true })).first()).toBeVisible();
  });

  test('นัดเต็ม → สมาชิกคนที่สองเห็น "นัดนี้เต็มแล้ว" และเข้าคิวได้ลำดับที่ 1', async ({ page, browser }) => {
    const { gangId, sessionUrl } = await setupOpenSession(page, 1);

    // เจ้าของลงชื่อเป็นคนเดียวที่นั่งได้
    await page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
    await expect(page.getByText(/คุณลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });

    // สมาชิกคนที่สอง: สมัครใน context แยก แล้วเจ้าของเพิ่มด้วยอีเมล
    const second = await browser.newContext();
    const page2 = await second.newPage();
    const member = await signUp(page2);

    await page.goto(`/gangs/${gangId}/members`);
    await page.getByLabel('เพิ่มสมาชิกด้วยอีเมล').fill(member.email);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(page.getByText('เพิ่มสมาชิกแล้ว')).toBeVisible({ timeout: 15_000 });

    await page2.goto(sessionUrl);
    await expect(page2.getByText('นัดนี้เต็มแล้ว')).toBeVisible({ timeout: 15_000 });
    await page2.getByRole('button', { name: /เข้าคิวรอ \(ลำดับที่ 1\)/ }).click();

    await expect(page2.getByText('คุณอยู่ในคิวรอ · ลำดับที่ 1')).toBeVisible({ timeout: 15_000 });
    await expect(page2.getByRole('button', { name: 'ยกเลิกการลงชื่อ' })).toBeVisible();
    await expect(page2.getByText('คิวรอ', { exact: true })).toBeVisible();

    // คนที่อยู่ในคิวกดยกเลิก → server บอกว่าออกจากคิวได้ไม่เสียค่าปรับ
    await page2.getByRole('button', { name: 'ยกเลิกการลงชื่อ' }).click();
    await expect(page2.getByRole('alertdialog')).toContainText('คิวรอ', { timeout: 15_000 });
    await page2.getByRole('alertdialog').getByRole('button', { name: 'ไม่ยกเลิก' }).click();

    // สมาชิกคนที่สามเข้าคิวต่อท้าย → ลำดับที่ 2 (ลำดับถูกต้อง ไม่ซ้ำกับคนแรก)
    const third = await browser.newContext();
    const page3 = await third.newPage();
    const member3 = await signUp(page3);
    await page.goto(`/gangs/${gangId}/members`);
    await page.getByLabel('เพิ่มสมาชิกด้วยอีเมล').fill(member3.email);
    await page.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
    await expect(page.getByText('เพิ่มสมาชิกแล้ว')).toBeVisible({ timeout: 15_000 });

    await page3.goto(sessionUrl);
    await page3.getByRole('button', { name: /เข้าคิวรอ \(ลำดับที่ 2\)/ }).click();
    await expect(page3.getByText('คุณอยู่ในคิวรอ · ลำดับที่ 2')).toBeVisible({ timeout: 15_000 });

    // คนแรกในคิวยังเป็นลำดับที่ 1
    await page2.reload();
    await expect(page2.getByText('คุณอยู่ในคิวรอ · ลำดับที่ 1')).toBeVisible({ timeout: 15_000 });

    await third.close();
    await second.close();
  });
});

test.describe('guest: ต้องผ่านขั้นยืนยันเมื่อเปิดลิงก์ขณะล็อกอินเป็นสมาชิก', () => {
  async function createInvite(page: Page, sessionUrl: string): Promise<string> {
    await page.goto(sessionUrl);
    await page.getByRole('button', { name: 'สร้างลิงก์เชิญ' }).click();
    const code = page.locator('code, [class*="code"]').filter({ hasText: '/join/' }).first();
    await expect(code).toBeVisible({ timeout: 15_000 });
    return (await code.innerText()).trim();
  }

  async function newAnonymous(browser: Browser) {
    const context = await browser.newContext();
    return { context, page: await context.newPage() };
  }

  test('ลิงก์เชิญ: ผู้ไม่ล็อกอินลงชื่อได้ตรงๆ · สมาชิกที่ล็อกอินต้องติ๊กยืนยันว่าลงให้คนอื่น', async ({ page, browser }) => {
    const { sessionUrl } = await setupOpenSession(page, 8);
    const joinUrl = await createInvite(page, sessionUrl);
    expect(joinUrl).toContain('/join/');

    // (1) สมาชิกที่ล็อกอินอยู่เปิดลิงก์ guest ⇒ มีคำเตือน + ปุ่มส่งปิดจนกว่าจะติ๊ก
    await page.goto(joinUrl);
    await expect(page.getByText('คุณล็อกอินอยู่ในบัญชีสมาชิก')).toBeVisible();
    await page.getByLabel('ชื่อที่ให้เรียก').fill('Ford');
    const submit = page.getByRole('button', { name: 'ลงชื่อเข้านัด' });
    await expect(submit).toBeDisabled();
    await page.getByLabel('ฉันกำลังลงชื่อให้คนอื่น (ไม่ใช่ตัวฉันเอง)').check();
    await expect(submit).toBeEnabled();

    // (2) ผู้ไม่ล็อกอิน (เพื่อนจริง) ไม่เห็นคำเตือน และลงชื่อได้
    const anon = await newAnonymous(browser);
    await anon.page.goto(joinUrl);
    await expect(anon.page.getByText('คุณล็อกอินอยู่ในบัญชีสมาชิก')).toBeHidden();
    await anon.page.getByLabel('ชื่อที่ให้เรียก').fill('Ford');
    await anon.page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
    await expect(anon.page.getByText(/ลงชื่อเรียบร้อย|ลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });
    // ฟอร์มถูกซ่อนหลังสำเร็จ ⇒ กดซ้ำไม่ได้
    await expect(anon.page.getByRole('button', { name: 'ลงชื่อเข้านัด' })).toBeHidden();
    await anon.context.close();

    // (3) หน้านัดของสมาชิก: guest โผล่ในรายชื่อพร้อมป้าย guest
    await page.goto(sessionUrl);
    await expect(page.getByText('Ford')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('guest', { exact: true })).toBeVisible();
  });

  test('guest ชื่อซ้ำกันสองแถว → รายชื่อขึ้นป้าย "ชื่อซ้ำ" ทั้งคู่ (เตือนเฉยๆ ไม่บล็อก)', async ({ page, browser }) => {
    const { sessionUrl } = await setupOpenSession(page, 8);
    const joinUrl = await createInvite(page, sessionUrl);

    for (let i = 0; i < 2; i++) {
      const anon = await newAnonymous(browser);
      await anon.page.goto(joinUrl);
      await anon.page.getByLabel('ชื่อที่ให้เรียก').fill('Ford');
      await anon.page.getByRole('button', { name: 'ลงชื่อเข้านัด' }).click();
      await expect(anon.page.getByText(/ลงชื่อเรียบร้อย|ลงชื่อแล้ว/)).toBeVisible({ timeout: 15_000 });
      await anon.context.close();
    }

    await page.goto(sessionUrl);
    await expect(page.getByText('ชื่อซ้ำ')).toHaveCount(2, { timeout: 15_000 });
  });
});

test('390px: หน้าลิสต์นัดและหน้านัดไม่มี horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { gangId } = await setupOpenSession(page, 8);

  for (const url of [`/gangs/${gangId}/sessions`, page.url()]) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
});
