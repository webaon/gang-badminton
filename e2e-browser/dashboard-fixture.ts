import { expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { POOLED_URL, serviceClient } from '../tests/helpers/db';
import { paymentSlipPath } from '../lib/storage/paths';
import { signUp, uniqueSuffix } from './helpers';

/** Isolated real fixture only: no existing gang edits, no mocked dashboard responses. */
export async function seedDashboard(page: Page) {
  const pool = new Pool({ connectionString: POOLED_URL });
  try {
    const actor = await signUp(page);
    const { rows: [owner] } = await pool.query('select id from auth.users where email=$1', [actor.email]);
    const { rows: [gang] } = await pool.query('select id from public.create_gang($1,$2)', [owner.id, `ก๊วนแดชบอร์ด ${uniqueSuffix()}`]);
    const newUser = async (name: string, member: boolean) => {
      const { rows: [user] } = await pool.query('insert into auth.users(id,email) values(gen_random_uuid(),$1) returning id', [`dashboard-${crypto.randomUUID()}@example.com`]);
      await pool.query('update public.profiles set display_name=$1 where id=$2', [name, user.id]);
      if (member) await pool.query("insert into public.gang_members(gang_id,user_id,role) values($1,$2,'member')", [gang.id, user.id]);
      return user.id as string;
    };
    const debtor = await newUser('สมาชิกที่รอตรวจสลิป', true);
    const walletMember = await newUser('สมาชิกที่มีเครดิต', true);
    const applicant = await newUser('ผู้ขอเข้าก๊วน', false);
    await pool.query("update public.gangs set is_public=true,features=jsonb_set(features,'{discovery}','true') where id=$1", [gang.id]);
    await pool.query('select public.request_to_join_gang($1,$2,$3)', [gang.id, applicant, 'ขอร่วมตีแบด']);
    const snapshot = { snapshot_version: 1, pricing_plan: { type: 'flat_rate', params: { amount_per_person: '150.00' } }, rounding_policy: { mode: 'ceil_baht', surplus_to: 'gang' }, promptpay_id: '0812345678', cancellation_policy: { cutoff_hours: 12, allow_cancel_after_cutoff: true, penalty_type: 'full_share' }, skill_levels: [] };
    const session = async (title: string, start: string, end: string) => {
      const { rows: [row] } = await pool.query(`insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,court_count,snapshot,created_by)
        values($1,$2,$3,$4,8,2,$5::jsonb,$6) returning id`, [gang.id, title, start, end, JSON.stringify(snapshot), owner.id]);
      await pool.query("select public.transition_session($1,'open',$2)", [row.id, owner.id]);
      return row.id as string;
    };
    const { rows: [dates] } = await pool.query(`select
      (date_trunc('month',now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok') as month_start,
      now()+interval '2 hours' as next_start,now()+interval '4 hours' as next_end,
      now()-interval '2 days' as old_start,now()-interval '1 day' as old_end`);
    const billed = await session('นัดปิดรอบสำหรับรายงาน', dates.month_start, new Date(new Date(dates.month_start).getTime() + 3600_000).toISOString());
    for (const userId of [owner.id, debtor]) {
      const { rows: [reg] } = await pool.query('select id from public.register_to_session($1,$2)', [billed, userId]);
      await pool.query('select public.check_in_registration($1,$2)', [reg.id, owner.id]);
    }
    // Use the real close action/domain, never insert session charges or force a status.
    const sessionPath = `/gangs/${gang.id}/sessions/${billed}`;
    await page.goto(`${sessionPath}/close`);
    await page.getByRole('button', { name: 'ยืนยันปิดรอบ เก็บเงิน', exact: true }).click();
    await page.waitForURL(url => url.pathname === sessionPath);
    for (const userId of [owner.id, debtor]) {
      const { rows: [charge] } = await pool.query('select c.id,c.amount::text from public.session_charges c join public.session_registrations r on r.id=c.registration_id where c.session_id=$1 and r.user_id=$2', [billed, userId]);
      expect(charge.amount).toBe('150.00');
      const { rows: [payment] } = await pool.query('select id from public.create_payment_for_charges($1,$2,$3::uuid[],$4)', [gang.id, userId, [charge.id], owner.id]);
      const path = paymentSlipPath(gang.id, payment.id, 'dashboard-slip.png');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const uploaded = await serviceClient().storage.from('payment-slips').upload(path, png, { contentType: 'image/png' });
      expect(uploaded.error).toBeNull();
      await pool.query('update public.payments set slip_url=$1 where id=$2', [path, payment.id]);
      await pool.query("select public.transition_payment($1,'submitted',$2)", [payment.id, userId]);
      if (userId === owner.id) {
        await pool.query('select public.set_payment_received_amount($1,$2,$3)', [payment.id, '150.00', owner.id]);
        await pool.query("select public.transition_payment($1,'verified',$2)", [payment.id, owner.id]);
      }
    }
    await pool.query('select public.credit_topup($1,$2,$3,$4,$5)', [gang.id, walletMember, '25.00', 'เครดิตกิจกรรมก๊วน', owner.id]);
    await pool.query("insert into public.gang_expenses(gang_id,category,amount,note,occurred_on,created_by) values($1,'other',20,'ค่าอุปกรณ์ทดสอบ',(now() at time zone 'Asia/Bangkok')::date,$2)", [gang.id, owner.id]);
    await session('นัดค้างปิดรอบ', dates.old_start, dates.old_end);
    const nextId = await session('นัดถัดไปของก๊วน', dates.next_start, dates.next_end);
    await pool.query('select public.register_to_session($1,$2)', [nextId, owner.id]);
    await pool.query('select public.register_to_session($1,$2)', [nextId, debtor]);
    const { rows: [proof] } = await pool.query(`select
      (select count(*)::int from public.gang_members where gang_id=$1 and deleted_at is null) members,
      (select count(*)::int from public.payments where gang_id=$1 and status='submitted') pending,
      (select balance::text from public.credit_balances where gang_id=$1 and user_id=$2) credit,
      (select count(*)::int from public.event_logs where gang_id=$1) events`, [gang.id, walletMember]);
    expect(proof.members).toBe(3); expect(proof.pending).toBe(1); expect(proof.credit).toBe('25.00'); expect(proof.events).toBeGreaterThan(0);
    return { gangId: gang.id as string, nextId };
  } finally { await pool.end(); }
}
