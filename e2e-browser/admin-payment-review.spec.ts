import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { POOLED_URL, serviceClient } from '../tests/helpers/db';

// Own the pool lifecycle: Playwright reuses workers across spec files.
const pool = new Pool({ connectionString: POOLED_URL });
import { paymentSlipPath } from '../lib/storage/paths';
import { mkdir } from 'node:fs/promises';
import { expectReadableControl } from './finance-contrast';
import { signUp, uniqueSuffix, watchConsole } from './helpers';

test.afterAll(async () => { await pool.end(); });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function fixture(page: Page) {
  const user = await signUp(page);
  const { rows: [owner] } = await pool.query('select id from auth.users where email=$1', [user.email]);
  const { rows: [gang] } = await pool.query('select id from public.create_gang($1,$2)', [owner.id, `ตรวจสลิป ${uniqueSuffix()}`]);
  const snapshot = { snapshot_version: 1, pricing_plan: { type: 'flat_rate', params: { amount_per_person: '150.00' } }, rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' }, promptpay_id: '0812345678', cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' }, skill_levels: [] };
  const { rows: [session] } = await pool.query(`insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,court_count,snapshot,created_by)
    values($1,'สลิปแอดมิน',now()+interval '1 day',now()+interval '1 day 2 hours',8,1,$2::jsonb,$3) returning id`, [gang.id, JSON.stringify(snapshot), owner.id]);
  await pool.query("select public.transition_session($1,'open',$2)", [session.id, owner.id]);
  const { rows: [reg] } = await pool.query('select id from public.register_to_session($1,$2)', [session.id, owner.id]);
  await pool.query('select public.check_in_registration($1,$2)', [reg.id, owner.id]);
  const sessionPath = `/gangs/${gang.id}/sessions/${session.id}`;
  await page.goto(`${sessionPath}/close`);
  await page.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน' }).click();
  await page.waitForURL((url) => url.pathname === sessionPath);
  const { rows: [charge] } = await pool.query('select id from public.session_charges where session_id=$1', [session.id]);
  const { rows: [payment] } = await pool.query('select id from public.create_payment_for_charges($1,$2,$3::uuid[],$4)', [gang.id, owner.id, [charge.id], owner.id]);
  const slipPath = paymentSlipPath(gang.id, payment.id, 'slip.png');
  const uploaded = await serviceClient().storage.from('payment-slips').upload(slipPath, PNG, { contentType: 'image/png' });
  expect(uploaded.error).toBeNull();
  await pool.query('update public.payments set slip_url=$1 where id=$2', [slipPath, payment.id]);
  await pool.query("select public.transition_payment($1,'submitted',$2)", [payment.id, owner.id]);
  return { gangId: gang.id, ownerId: owner.id, chargeId: charge.id, paymentId: payment.id, path: `/gangs/${gang.id}/payments/${payment.id}` };
}

test('H32/H34: actual received → verify → overpayment; aborted request recovers; resumable charge return', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const f = await fixture(page);
  const watcher = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(f.path);
  await expect(page.getByRole('img', { name: 'สลิปการโอน' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยืนยันการจ่าย', exact: true })).toBeDisabled();
  await page.getByLabel('ยอดที่โอนจริง (บาท)').fill('175.00');
  await page.getByRole('button', { name: 'ตรวจทานยอดที่โอนจริง' }).click();
  let aborted = false;
  await page.route(`**${f.path}`, async (route) => {
    if (!aborted && route.request().method() === 'POST' && route.request().headers()['next-action']) { aborted = true; await route.abort(); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'ยืนยันขั้นตอนนี้' }).click();
  await expect(page.getByText('โหลดสถานะล่าสุดก่อนทำต่อ').first()).toBeVisible();
  expect(aborted).toBe(true);
  await page.getByRole('button', { name: 'โหลดข้อมูลและลิงก์สลิปใหม่' }).click();
  await expect(page.getByText('โหลดสถานะล่าสุดก่อนทำต่อ').first()).toBeHidden({ timeout: 15_000 });
  await page.getByLabel('ยอดที่โอนจริง (บาท)').fill('175.00');
  await expect(page.getByRole('button', { name: 'ตรวจทานยอดที่โอนจริง' })).toBeEnabled();
  await page.getByRole('button', { name: 'ตรวจทานยอดที่โอนจริง' }).click();
  await page.getByRole('button', { name: 'ยืนยันขั้นตอนนี้' }).click();
  await expect(page.getByText('ส่วนเกิน ฿25.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'ยืนยันการจ่าย', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันขั้นตอนนี้' }).click();
  await expect(page.getByRole('button', { name: 'บันทึกโอนเกินเข้าเครดิต', exact: true })).toBeVisible();
  await page.getByLabel('เหตุผล', { exact: true }).fill('ทดสอบยอดโอนจริง');
  await page.getByRole('button', { name: 'บันทึกโอนเกินเข้าเครดิต', exact: true }).click();
  await page.getByRole('button', { name: 'ยืนยันขั้นตอนนี้' }).click();
  await expect(page.getByText('บันทึกโอนเกินเข้าเครดิตแล้ว ฿25.00').first()).toBeVisible();
  const { rows: [payment] } = await pool.query('select status,received_amount::text from public.payments where id=$1', [f.paymentId]);
  expect(payment).toEqual({ status: 'verified', received_amount: '175.00' });
  const { rows: [wallet] } = await pool.query('select balance::text from public.credit_balances where gang_id=$1 and user_id=$2', [f.gangId, f.ownerId]);
  expect(wallet.balance).toBe('25.00');
  await page.reload();
  await expect(page.getByRole('button', { name: 'บันทึกโอนเกินเข้าเครดิต', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The first step happened earlier. Visiting history must resume step 2 without repeating step 1.
  await pool.query("select public.add_payment_adjustment(p_charge_id := $1,p_type := 'credit',p_amount := -50,p_reason := 'ลดหนี้แล้วทิ้งช่วง',p_actor_id := $2)", [f.chargeId, f.ownerId]);
  await page.goto(`/gangs/${f.gangId}/payments/charges/${f.chargeId}`);
  await expect(page.getByText('มียอดรอคืนเข้าเครดิต').first()).toBeVisible();
  await page.getByLabel('เหตุผลที่คืนเข้าเครดิต').fill('กลับมาทำขั้นที่สอง');
  await page.getByRole('button', { name: 'ตรวจทานการคืนเข้าเครดิต' }).click();
  await page.getByRole('button', { name: 'ยืนยันคืนเข้าเครดิต', exact: true }).click();
  await expect(page.getByText('คืนเข้าเครดิตแล้ว ฿50.00').first()).toBeVisible();
  const { rows: [counts] } = await pool.query("select count(*) filter(where type='credit')::int as reductions,count(*) filter(where type='credit_return')::int as returns from public.payment_adjustments where session_charge_id=$1", [f.chargeId]);
  expect(counts).toEqual({ reductions: 1, returns: 1 });
  await pool.query('select public.credit_cash_payout($1,$2,$3,$4,$5)', [f.gangId, f.ownerId, '10.00', 'ทดสอบเงินคืนในรายงาน', f.ownerId]);
  await page.goto(`/gangs/${f.gangId}/reports?from=2020-01-01&to=2099-12-31`);
  await expect(page.getByRole('group', { name: 'เงินโอนรับชำระก่อนคืนเงิน', exact: true })).toContainText('฿150.00');
  await expect(page.getByRole('group', { name: 'โอนเกินเข้าเครดิต', exact: true })).toContainText('฿25.00');
  await expect(page.getByRole('group', { name: 'เงินคืนสมาชิก', exact: true })).toContainText('฿10.00');
  await expect(page.getByRole('group', { name: 'เงินสดสุทธิ', exact: true })).toContainText('฿165.00');
  await expect(page.getByText(/^ยอดค้าง ณ/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'สลิปแอดมิน', exact: true })).toBeVisible();
  await listEvidence(page, 'reports');
  expect(watcher.cspViolations).toEqual([]);

  const stranger = await browser.newContext();
  try {
    const other = await stranger.newPage(); await signUp(other);
    await other.goto(f.path);
    await expect(other.getByRole('heading', { name: 'เปิดรายการจ่ายไม่ได้' })).toBeVisible();
    await expect(other.getByRole('img', { name: 'สลิปการโอน' })).toHaveCount(0);
  } finally { await stranger.close(); }
});

async function listEvidence(page: Page, screen: string) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      if (screen === 'reports') await expectReadableControl(page.getByRole('link', { name: 'ดูรายงานช่วงนี้', exact: true }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.SHOT_DIR) {
        await mkdir(process.env.SHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.SHOT_DIR}/${screen}-${width}-${colorScheme}.png` });
      }
    }
  }
}

test('H32 queue/H33: server counts across pages, opaque cursor, filters, history navigation and responsive lists', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await fixture(page);
  for (let i = 0; i < 26; i++) {
    const { rows: [payment] } = await pool.query('insert into public.payments(gang_id,payer_user_id,amount,created_by) values($1,$2,150,$2) returning id', [f.gangId, f.ownerId]);
    await pool.query('insert into public.payment_allocations(payment_id,session_charge_id,amount) values($1,$2,150)', [payment.id, f.chargeId]);
    await pool.query("select public.transition_payment($1,'submitted',$2)", [payment.id, f.ownerId]);
  }
  const queue = `/gangs/${f.gangId}/payments/review`;
  await page.goto(queue);
  await expect(page.getByRole('link', { name: 'รอตรวจ (27)', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'เปิดตรวจสลิป', exact: true })).toHaveCount(25);
  await expect(page.getByRole('link', { name: 'เปิดตรวจสลิป', exact: true }).first()).toHaveAttribute('href', f.path);
  await listEvidence(page, 'h32-queue');
  await page.getByRole('link', { name: 'หน้าถัดไป', exact: true }).click();
  await expect(page.getByRole('link', { name: 'เปิดตรวจสลิป', exact: true })).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'รอตรวจ (27)', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('cursor')).toBeTruthy();
  await page.getByRole('link', { name: 'รอโอน (0)', exact: true }).click();
  await expect(page.getByText('ไม่มีรายการในหน้านี้')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('cursor')).toBeNull();

  await page.getByRole('link', { name: 'ยอดค้างจ่าย', exact: true }).click();
  await expect(page.getByText('ค้างเก็บ ฿150.00 · ลูกหนี้ 1 คน')).toBeVisible();
  await expect(page.getByText('รับชำระด้วยเงินโอน ฿0.00')).toBeVisible();
  await expect(page.getByRole('link', { name: 'ดูประวัติรายการหนี้', exact: true })).toHaveCount(1);
  await listEvidence(page, 'h33-outstanding');
  await page.getByRole('link', { name: '0–7 วัน · 1 คน · ฿150.00', exact: true }).click();
  await expect(page.getByRole('link', { name: '✓ 0–7 วัน · 1 คน · ฿150.00', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'ทุกช่วงอายุหนี้', exact: true })).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('ค้างเก็บ ฿150.00 · ลูกหนี้ 1 คน')).toBeVisible();
  await page.getByRole('link', { name: 'ดูประวัติรายการหนี้', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ประวัติรายการหนี้', exact: true })).toBeVisible();

  await page.goto(`/gangs/${f.gangId}/payments/outstanding`);
  await page.getByRole('button', { name: 'ปรับยอด', exact: true }).click();
  await page.getByLabel('จำนวนเงินปรับยอด', { exact: true }).fill('-25.00');
  await expect(page.getByRole('button', { name: 'ตรวจทานการปรับยอด' })).toBeDisabled();
  await page.getByLabel('เหตุผลการปรับยอด', { exact: true }).fill('ลดหนี้จากบัญชีแอดมิน');
  await page.getByRole('button', { name: 'ตรวจทานการปรับยอด' }).click();
  const before = await pool.query('select count(*)::int as n from public.payment_adjustments where session_charge_id=$1', [f.chargeId]);
  expect(before.rows[0].n).toBe(0);
  await page.getByRole('button', { name: 'ยืนยันรายการ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ประวัติรายการหนี้', exact: true })).toBeVisible();
  const adjusted = await pool.query('select type,amount::text from public.payment_adjustments where session_charge_id=$1', [f.chargeId]);
  expect(adjusted.rows).toEqual([{ type: 'credit', amount: '-25.00' }]);
  await page.goto(`/gangs/${f.gangId}/payments/outstanding`);
  await expect(page.getByText('ค้างเก็บ ฿125.00 · ลูกหนี้ 1 คน')).toBeVisible();
});
