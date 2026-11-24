import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { mkdir } from 'node:fs/promises';
import { POOLED_URL } from '../tests/helpers/db';
import { expectReadableControl } from './finance-contrast';
import { signUp, uniqueSuffix, watchConsole } from './helpers';
const pool = new Pool({ connectionString: POOLED_URL });
test.afterAll(async () => { await pool.end(); });

test('wallet: reason and confirmation, uncertain write recovery, signed history and former-member payout', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const user = await signUp(page);
  const { rows: [owner] } = await pool.query('select id from auth.users where email=$1', [user.email]);
  const { rows: [gang] } = await pool.query('select id from public.create_gang($1,$2)', [owner.id, `เครดิต ${uniqueSuffix()}`]);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    const member = await signUp(other);
    const { rows: [former] } = await pool.query('select id from auth.users where email=$1', [member.email]);
    await pool.query("insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member')", [gang.id, former.id]);
    await pool.query('select public.credit_topup($1,$2,$3,$4,$5)', [gang.id, former.id, '40.00', 'ยอดก่อนออกจากก๊วน', owner.id]);
    await pool.query('update public.gang_members set deleted_at=now() where gang_id=$1 and user_id=$2', [gang.id, former.id]);
    const activeContext = await browser.newContext();
    let activeEmail: string;
    try { activeEmail = (await signUp(await activeContext.newPage())).email; }
    finally { await activeContext.close(); }
    const { rows: [activeMember] } = await pool.query('select id from auth.users where email=$1', [activeEmail]);
    await pool.query("insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member')", [gang.id, activeMember.id]);
    const path = `/gangs/${gang.id}/payments/credits`;
    const watcher = watchConsole(page);
    await page.goto(`/gangs/${gang.id}/payments`);
    await page.getByRole('link', { name: 'กระเป๋าเครดิต', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'กระเป๋าเครดิตสมาชิก' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'สมาชิกที่เติมเครดิตได้' }).getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: `เลือกเติมเครดิต ${user.displayName}`, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^เลือกเติมเครดิต / }).click();
    await expect(page.getByText('เครดิตคงเหลือ ฿0.00', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'เติมเครดิต', exact: true }).click();
    await page.getByRole('textbox', { name: /^จำนวนเงิน \(บาท\)\s*จำเป็น$/ }).fill('25.00');
    await expect(page.getByRole('button', { name: 'ตรวจทานและไปหน้ายืนยัน' })).toBeDisabled();
    await page.getByRole('textbox', { name: /^เหตุผล\s*จำเป็น$/ }).fill('เครดิตทดสอบ');
    await page.getByRole('button', { name: 'ตรวจทานและไปหน้ายืนยัน' }).click();
    const before = await pool.query('select count(*)::int as n from public.credit_ledger where gang_id=$1 and user_id=$2', [gang.id, activeMember.id]);
    expect(before.rows[0].n).toBe(0);
    let aborted = false;
    await page.route(`**${path}`, async route => {
      if (!aborted && route.request().method() === 'POST' && route.request().headers()['next-action']) { aborted = true; await route.abort(); }
      else await route.continue();
    });
    await page.getByRole('button', { name: 'ยืนยันเติมเครดิต', exact: true }).click();
    await expect(page.getByText('ต้องอ่านประวัติล่าสุดก่อนทำรายการต่อ').first()).toBeVisible();
    expect(aborted).toBe(true);
    await expect(page.getByRole('button', { name: 'เติมเครดิต', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'โหลดประวัติและยอดล่าสุด' }).click();
    await expect(page.getByRole('button', { name: 'เติมเครดิต', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'ยืนยันเติมเครดิต', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'เติมเครดิต', exact: true }).click();
    await page.getByRole('textbox', { name: /^จำนวนเงิน \(บาท\)\s*จำเป็น$/ }).fill('25.00');
    await page.getByRole('textbox', { name: /^เหตุผล\s*จำเป็น$/ }).fill('เครดิตทดสอบ');
    await page.getByRole('button', { name: 'ตรวจทานและไปหน้ายืนยัน' }).click();
    await page.getByRole('button', { name: 'ยืนยันเติมเครดิต', exact: true }).click();
    await expect(page.getByText('เครดิตคงเหลือ ฿25.00', { exact: true })).toBeVisible();
    await expect(page.getByText('+฿25.00', { exact: true })).toBeVisible();
    const topups = await pool.query("select count(*)::int as n from public.credit_ledger where gang_id=$1 and user_id=$2 and type='admin_topup'", [gang.id, activeMember.id]);
    expect(topups.rows[0].n).toBe(1);

    // Former member remains visible for payout but is excluded from top-up.
    // Profile RLS hides former members' names; the loader supplies this fallback.
    // The DB assertion below proves payout targets the former user's ID.
    await page.getByRole('button', { name: 'ดูเครดิต ไม่ทราบชื่อ', exact: true }).click();
    await expect(page.getByText('เครดิตคงเหลือ ฿40.00', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'เติมเครดิต', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'จ่ายคืนเงินสด', exact: true }).click();
    await page.getByRole('textbox', { name: /^จำนวนเงิน \(บาท\)\s*จำเป็น$/ }).fill('10.00');
    await page.getByRole('textbox', { name: /^เหตุผล\s*จำเป็น$/ }).fill('คืนอดีตสมาชิก');
    await page.getByRole('button', { name: 'ตรวจทานและไปหน้ายืนยัน' }).click();
    await page.getByRole('button', { name: 'ยืนยันว่าจ่ายคืนเงินสดแล้ว' }).click();
    await expect(page.getByText('เครดิตคงเหลือ ฿30.00', { exact: true })).toBeVisible();
    await expect(page.getByText('-฿10.00', { exact: true })).toBeVisible();
    const payout = await pool.query('select balance::text from public.credit_balances where gang_id=$1 and user_id=$2', [gang.id, former.id]);
    expect(payout.rows[0].balance).toBe('30.00');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await expectReadableControl(page.getByRole('button', { name: 'จ่ายคืนเงินสด', exact: true }));
        await expectReadableControl(page.getByRole('button', { name: 'โหลดประวัติและยอดล่าสุด', exact: true }));
        await page.evaluate(() => window.scrollTo(0, 0));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.SHOT_DIR) {
          await mkdir(process.env.SHOT_DIR, { recursive: true });
          await page.screenshot({ path: `${process.env.SHOT_DIR}/wallet-${width}-${colorScheme}.png` });
        }
      }
    }
    expect(watcher.cspViolations).toEqual([]);
    await other.goto(path);
    await expect(other).toHaveURL(new RegExp(`/gangs/${gang.id}/sessions$`));
    await expect(other.getByRole('heading', { name: 'กระเป๋าเครดิตสมาชิก' })).toHaveCount(0);
  } finally { await otherContext.close(); }
});
