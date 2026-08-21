import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Table, proportional, pixel } from '@astryxdesign/core/Table';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { billingMonthOf } from '@/domain/billing/membership';
import { monthlyFromJson } from '@/domain/policies/pricing';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import { GenerateMonthlyFeesButton } from '@/features/billing/GenerateMonthlyFeesButton';

export const dynamic = 'force-dynamic';

/**
 * รอบบิลรายเดือน — **[WO-2.5-C]**
 *
 * แสดงว่าเดือนนี้ออกบิลให้ใครไปแล้ว และใครที่เป็นสมาชิกรายเดือนแต่ยัง**ไม่มีบิล**
 * (เกิดได้ถ้าเพิ่งสมัครหลัง cron รันรอบล่าสุด — กดปุ่มออกบิลได้ทันที)
 */
export default async function MembershipPage({
  params,
  searchParams,
}: {
  params: Promise<{ gangId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { gangId } = await params;
  const { month } = await searchParams;

  const user = await requireUser(`/gangs/${gangId}/membership`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, timezone')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  // ยอดเงินของทั้งก๊วน — สมาชิกทั่วไปไม่ควรเห็นว่าใครจ่ายเท่าไหร่
  if (!can({ role }, 'gang.finance.view')) {
    redirect(`/gangs/${gangId}/sessions`);
  }

  const billingMonth =
    month && /^\d{4}-\d{2}-01$/.test(month)
      ? month
      : billingMonthOf(utcToZonedWallClock(new Date(), gang.timezone));

  const admin = supabaseAdmin();

  const { data: plan } = await admin
    .from('gang_pricing_plans')
    .select('id, params')
    .eq('gang_id', gangId)
    .eq('type', 'monthly')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: members } = await admin
    .from('gang_members')
    .select('id, monthly_member_since, profiles!gang_members_user_id_fkey!inner(display_name)')
    .eq('gang_id', gangId)
    .eq('is_monthly_member', true)
    .is('deleted_at', null);

  const { data: charges } = await admin
    .from('session_charges')
    .select('id, gang_member_id, amount')
    .eq('gang_id', gangId)
    .eq('type', 'monthly_fee')
    .eq('billing_month', billingMonth);

  type MemberRow = {
    id: string;
    monthly_member_since: string | null;
    profiles: { display_name: string };
  };

  const billed = new Map((charges ?? []).map((c) => [c.gang_member_id, c.amount]));

  const rows = ((members ?? []) as unknown as MemberRow[]).map((m) => ({
    name: m.profiles.display_name,
    since: m.monthly_member_since ?? '—',
    status: billed.has(m.id) ? `${billed.get(m.id)} ฿` : 'ยังไม่ออกบิล',
  }));

  const missing = rows.filter((r) => r.status === 'ยังไม่ออกบิล').length;
  const monthLabel = billingMonth.slice(0, 7);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">บิลรายเดือน · {gang.name}</h1>
        <Link href={`/gangs/${gangId}/members`} className="underline">
          สมาชิก
        </Link>
      </div>

      {!plan ? (
        <Banner
          status="warning"
          title="ยังไม่ได้ตั้งค่าสมาชิกรายเดือน"
          description="ตั้งค่าในหน้าตั้งค่าก๊วนก่อน แล้วระบบจะออกบิลให้อัตโนมัติต้นเดือน"
        />
      ) : (
        <Card padding={4}>
          <p className="mb-1 text-sm">
            รอบเดือน <strong>{monthLabel}</strong> · ค่าสมาชิก{' '}
            {monthlyFromJson(plan.params).monthlyFee} บาท/เดือน
          </p>
          <p className="mb-3 text-sm opacity-70">
            สมาชิกรายเดือน {rows.length} คน · ออกบิลแล้ว {rows.length - missing} คน
            {missing > 0 ? ` · ยังไม่ออกบิล ${missing} คน` : ''}
          </p>

          {rows.length === 0 ? (
            <p className="text-sm">
              ยังไม่มีสมาชิกรายเดือน — ติ๊ก “รายเดือน” ให้สมาชิกในหน้าสมาชิกก่อน
            </p>
          ) : (
            <Table
              data={rows}
              idKey={(row) => row.name}
              density="compact"
              columns={[
                { key: 'name', header: 'ชื่อ', width: proportional(1) },
                { key: 'since', header: 'เริ่มเป็นสมาชิก', width: pixel(140) },
                { key: 'status', header: 'บิลเดือนนี้', width: pixel(120), align: 'end' },
              ]}
            />
          )}

          {can({ role }, 'billing.close') ? (
            <div className="mt-4">
              <GenerateMonthlyFeesButton gangId={gangId} billingMonth={billingMonth} />
            </div>
          ) : null}
        </Card>
      )}

      <p className="mt-3 text-sm opacity-70">
        ระบบออกบิลให้อัตโนมัติ · กดออกบิลซ้ำได้ ไม่สร้างใบซ้ำ (หนึ่งใบต่อสมาชิกต่อเดือน)
      </p>
    </main>
  );
}
