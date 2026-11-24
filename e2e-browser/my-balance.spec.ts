import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { pool } from '../tests/helpers/db';
import { promptPayQrDataUrl } from '../lib/promptpay/qr';
import { signUp, uniqueSuffix, watchConsole } from './helpers';

test.afterAll(async () => { await pool.end(); });

async function balanceEvidence(page: Page, state: 'outstanding' | 'paid') {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const contrast = await page.getByRole('link', { name: /^ดูยอดและจ่าย/ }).first().evaluate((link) => {
      const text = link.querySelector('.astryx-text') ?? link.lastElementChild ?? link;
      const foreground = getComputedStyle(text).color;
      // Secondary background is translucent: composite it over every ancestor before measuring.
      const layers: number[][] = [];
      for (let node: Element | null = link; node; node = node.parentElement) {
        layers.push(getComputedStyle(node).backgroundColor.match(/[\d.]+/g)!.map(Number));
      }
      const backgroundRgb = layers.reverse().reduce((under, layer) => {
        const alpha = layer[3] ?? 1;
        return layer.slice(0, 3).map((channel, i) => channel * alpha + under[i] * (1 - alpha));
      }, [255, 255, 255]);
      const background = `rgb(${backgroundRgb.join(', ')})`;
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
          const channel = v / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const f = luminance(foreground), b = luminance(background);
      return { foreground, background, ratio: (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05), disabled: link.getAttribute('aria-disabled') };
    });
    expect(contrast.disabled).not.toBe('true');
    expect(contrast.ratio, `${colorScheme}: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
    if (process.env.SHOT_DIR) {
      await mkdir(process.env.SHOT_DIR, { recursive: true });
      await page.setViewportSize({ width: 390, height: 1100 });
      await page.screenshot({ path: `${process.env.SHOT_DIR}/h29-${state}-390-${colorScheme}.png` });
      await page.setViewportSize({ width: 390, height: 844 });
    }
  }
}

async function userId(email: string): Promise<string> {
  const { rows } = await pool.query('select id from auth.users where email = $1', [email]);
  return rows[0].id;
}

// Seed only new fixture identities; all registrations, closing and payments use real transitions.
async function fixture(ownerPage: Page, memberPage: Page) {
  const owner = await signUp(ownerPage);
  const member = await signUp(memberPage);
  const ownerId = await userId(owner.email);
  const memberId = await userId(member.email);
  const { rows: [gang] } = await pool.query('select id from public.create_gang($1, $2)', [ownerId, `ยอดของฉัน ${uniqueSuffix()}`]);
  await pool.query("insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member')", [gang.id, memberId]);
  const sessions: { id: string; title: string; chargeId: string; amount: string }[] = [];
  for (const [title, amount, person] of [['นัดเก่าของฉัน', '150.00', memberId], ['นัดใหม่ของฉัน', '275.00', memberId], ['รายการเฉพาะเจ้าของ', '999.00', ownerId]]) {
    const snapshot = { snapshot_version: 1, pricing_plan: { type: 'flat_rate', params: { amount_per_person: amount } },
      rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' }, promptpay_id: '0812345678',
      cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' }, skill_levels: [] };
    const { rows: [session] } = await pool.query(`insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,court_count,snapshot,created_by)
      values($1,$2,now()+interval '1 day',now()+interval '1 day 2 hours',8,1,$3::jsonb,$4) returning id`,
    [gang.id, title, JSON.stringify(snapshot), ownerId]);
    await pool.query("select public.transition_session($1,'open',$2)", [session.id, ownerId]);
    const { rows: [reg] } = await pool.query('select id from public.register_to_session($1,$2)', [session.id, person]);
    await pool.query('select public.check_in_registration($1,$2)', [reg.id, ownerId]);
    const path = `/gangs/${gang.id}/sessions/${session.id}`;
    await ownerPage.goto(`${path}/close`);
    await ownerPage.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน' }).click();
    await ownerPage.waitForURL((url) => url.pathname === path);
    const { rows: [charge] } = await pool.query('select id from public.session_charges where session_id=$1 and registration_id=$2', [session.id, reg.id]);
    sessions.push({ id: session.id, title, chargeId: charge.id, amount });
  }
  return { gangId: gang.id as string, ownerId, memberId, sessions };
}

test('R3: member tab → H29 → correct session QR; privacy, 390px, overpayment wallet and combined payment', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  try {
    const watcher = watchConsole(page);
    const f = await fixture(ownerPage, page);
    const [old, recent, secret] = f.sessions;
    const balancePath = `/gangs/${f.gangId}/my-payments`;
    const payPath = (id: string) => `/gangs/${f.gangId}/sessions/${id}/pay`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/gangs/${f.gangId}/sessions`);
    await page.getByRole('link', { name: 'ยอดเงิน', exact: true }).last().click();
    await expect(page).toHaveURL(new RegExp(`${balancePath}$`));
    await expect(page.getByRole('heading', { name: 'ยอดของฉัน', exact: true })).toBeVisible();
    await expect(page.getByText('฿425.00', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: secret.title })).toHaveCount(0);
    await expect(page.getByText(/999\.00/)).toHaveCount(0);
    await expect(page.getByText(/เครดิตคงเหลือ/)).toHaveCount(0);

    await balanceEvidence(page, 'outstanding');
    // A newer payment exists in the SAME gang; old page must still pick the old payment, not limit(1).
    for (const session of [old, recent]) {
      await page.goto(balancePath);
      await page.getByRole('link', { name: `ดูยอดและจ่าย — ${session.title}`, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${payPath(session.id)}$`));
      await page.getByRole('button', { name: 'ขอ QR จ่ายเงิน' }).click();
      await expect(page.getByRole('img', { name: 'PromptPay QR' })).toHaveAttribute('src', await promptPayQrDataUrl('0812345678', session.amount));
    }
    await page.goto(payPath(old.id));
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toHaveAttribute('src', await promptPayQrDataUrl('0812345678', '150.00'));
    await expect(page.getByText('฿275.00', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'รายละเอียดยอดของฉัน' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Directly entering someone else's session pay URL cannot expose their charge/payment.
    await page.goto(payPath(secret.id));
    await expect(page.getByText('ยังไม่มียอดที่ต้องจ่ายในนัดนี้').first()).toBeVisible();
    await expect(page.getByText(/999\.00/)).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toHaveCount(0);

    // A combined payment deliberately covers both session charges; QR is the WHOLE amount.
    const { rows: [combined] } = await pool.query('select id from public.create_payment_for_charges($1,$2,$3::uuid[],$4)',
      [f.gangId, f.memberId, [old.chargeId, recent.chargeId], f.ownerId]);
    await page.goto(payPath(old.id));
    await expect(page.getByText('ใบจ่ายรวมหลายรายการ').first()).toBeVisible();
    await expect(page.getByText(/ครอบคลุมนัดนี้ ฿150.00 และรายการอื่น/).first()).toBeVisible();
    await expect(page.getByRole('img', { name: 'PromptPay QR' })).toHaveAttribute('src', await promptPayQrDataUrl('0812345678', '425.00'));

    // Real overpayment path: received 475 vs payment 425 => DB records wallet 50.
    await pool.query("select public.transition_payment($1,'submitted',$2)", [combined.id, f.memberId]);
    await pool.query("select public.transition_payment($1,'verified',$2)", [combined.id, f.ownerId]);
    await pool.query('select public.set_payment_received_amount($1,$2,$3)', [combined.id, '475.00', f.ownerId]);
    await pool.query('select public.record_overpayment($1,null,$2,$3)', [combined.id, 'โอนเกินสำหรับทดสอบ H29', f.ownerId]);
    const { rows: [wallet] } = await pool.query('select balance::text from public.credit_balances where gang_id=$1 and user_id=$2', [f.gangId, f.memberId]);
    expect(wallet.balance).toBe('50.00');
    await page.goto(balancePath);
    await expect(page.getByText('เครดิตคงเหลือ ฿50.00').first()).toBeVisible();
    await expect(page.getByText(/ระบบจะหักเครดิตอัตโนมัติเมื่อมีหนี้ใหม่/).first()).toBeVisible();
    await expect(page.getByText(/^ก๊วนต้องคืนให้/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await balanceEvidence(page, 'paid');
    expect(watcher.cspViolations).toEqual([]);
  } finally { await ownerContext.close(); }
});
