import { expect, test } from '@playwright/test';

import { createGang, signUp } from './helpers';

/**
 * HF-2 — Astryx Table ต้องไม่รับ function จาก server component:
 * เปิด /membership และ /stats ที่ "มีข้อมูลในตารางจริง" แล้วต้องไม่ขึ้นหน้า error
 * (/close ครอบคลุมใน close-flow.spec.ts เพราะต้องมีนัดที่เปิดอยู่)
 */
test.describe('หน้าที่มีตาราง render ได้ (HF-2)', () => {
  test('/membership และ /stats แสดงตารางที่มีแถวจริง', async ({ page }) => {
    test.setTimeout(90_000);
    const owner = await signUp(page);
    const { gangId } = await createGang(page);

    // ตั้งค่าสมาชิกรายเดือน
    await page.goto(`/gangs/${gangId}/settings`);
    await page.getByLabel('ค่าสมาชิกต่อเดือน (บาท)').fill('300');
    await page
      .locator('form')
      .filter({ hasText: 'ค่าสมาชิกรายเดือน' })
      .getByRole('button', { name: 'บันทึก', exact: true })
      .click();
    await expect(page.getByText('บันทึกค่าสมาชิกรายเดือนแล้ว')).toBeVisible({ timeout: 15_000 });

    // คำนวณสถิติ (ให้ตารางสถิติมีแถว)
    await page.getByRole('button', { name: 'คำนวณสถิติใหม่' }).click();
    await expect(page.getByText(/คำนวณสถิติของสมาชิก \d+ คนแล้ว/)).toBeVisible({ timeout: 15_000 });

    // ติ๊กตัวเองเป็นสมาชิกรายเดือน
    await page.goto(`/gangs/${gangId}/members`);
    const monthly = page.getByRole('checkbox', { name: 'รายเดือน' }).first();
    await expect(monthly).toBeVisible({ timeout: 15_000 });
    await monthly.click();
    await expect(monthly).toBeChecked({ timeout: 15_000 });
    await page.waitForLoadState('networkidle');

    for (const path of ['membership', 'stats']) {
      const res = await page.goto(`/gangs/${gangId}/${path}`);
      expect(res?.status(), path).toBeLessThan(400);
      const table = page.getByRole('table');
      await expect(table, path).toBeVisible({ timeout: 15_000 });
      await expect(table, path).toContainText(owner.displayName);
      await expect(page.getByText(/Application error|Something went wrong/i), path).toHaveCount(0);
    }
  });
});
