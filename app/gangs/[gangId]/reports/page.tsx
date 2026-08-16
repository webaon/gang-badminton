import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { moneyFromDb } from '@/lib/supabase/money';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { calculateFinanceReport, type ReportCharge } from '@/domain/reports/finance';
import { fromSatang, toSatang } from '@/domain/billing/money';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import { FinanceEntries, type FinanceEntryRow } from '@/features/reports/FinanceEntries';

export const dynamic = 'force-dynamic';

/**
 * รายงานรายรับ-รายจ่าย-กำไร — **[WO-3.B]**
 *
 * 🔴 รายรับนับจาก `session_charges` + ledger **เสมอ ไม่อิง `sessions.status`**
 *    (baseline v3.3) ⇒ นัดที่ยกเลิกกลางคันแต่มี charges ก็เข้ารายงาน
 *
 * 🔴 แยก "เรียกเก็บแล้ว" กับ "เก็บได้จริง" คนละบรรทัด — ปนกันเมื่อไหร่คือรายงานโกหก
 */
export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ gangId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { gangId } = await params;
  const { from, to } = await searchParams;

  const user = await requireUser(`/gangs/${gangId}/reports`);
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
  if (!can({ role }, 'gang.finance.view')) redirect(`/gangs/${gangId}/sessions`);

  // ช่วงเวลา — ค่าเริ่มต้นคือเดือนนี้ตามนาฬิกาของก๊วน
  const today = utcToZonedWallClock(new Date(), gang.timezone).slice(0, 10);
  const isDate = (v?: string) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const fromDate = isDate(from) ? from! : `${today.slice(0, 7)}-01`;
  const toDate = isDate(to) ? to! : today;

  const rangeStart = `${fromDate}T00:00:00`;
  const rangeEnd = `${toDate}T23:59:59.999`;

  const admin = supabaseAdmin();

  // ---------------------------------------------------------------------------
  // รายรับจากการเรียกเก็บ — ledger ของทุก charge ที่เกิดในช่วงนี้
  // ---------------------------------------------------------------------------
  const { data: chargeRows } = await admin
    .from('session_charges')
    .select(
      `id, amount, breakdown, created_at,
       payment_allocations(amount, payments(status)),
       payment_adjustments(amount, type)`,
    )
    .eq('gang_id', gangId)
    .gte('created_at', rangeStart)
    .lte('created_at', rangeEnd);

  type ChargeRow = {
    id: string;
    amount: string | number;
    breakdown: Record<string, unknown>;
    payment_allocations: { amount: string | number; payments: { status: string } | null }[];
    payment_adjustments: { amount: string | number; type: string }[];
  };

  const charges: ReportCharge[] = ((chargeRows ?? []) as unknown as ChargeRow[]).map((c) => ({
    chargeId: c.id,
    // ⚠️ PostgREST คืน numeric เป็น JSON number ⇒ แปลงที่ขอบก่อนเข้า domain
    amount: moneyFromDb(c.amount),
    allocated: c.payment_allocations
      .filter((a) => a.payments?.status === 'verified')
      .map((a) => moneyFromDb(a.amount)),
    adjustments: c.payment_adjustments.map((a) => moneyFromDb(a.amount)),
    refunds: c.payment_adjustments.filter((a) => a.type === 'refund').map((a) => moneyFromDb(a.amount)),
    roundingSurplus: moneyFromDb(
      (c.breakdown?.rounding_surplus as string | number | undefined) ?? '0.00',
    ),
  }));

  // ---------------------------------------------------------------------------
  // รายรับอื่น / รายจ่ายที่แอดมินบันทึกเอง
  // ---------------------------------------------------------------------------
  const entryColumns = 'id, category, amount, note, occurred_on, sessions(title)';

  const [{ data: expenseRows }, { data: incomeRows }] = await Promise.all([
    admin
      .from('gang_expenses')
      .select(entryColumns)
      .eq('gang_id', gangId)
      .gte('occurred_on', fromDate)
      .lte('occurred_on', toDate)
      .order('occurred_on', { ascending: false }),
    admin
      .from('gang_incomes')
      .select(entryColumns)
      .eq('gang_id', gangId)
      .gte('occurred_on', fromDate)
      .lte('occurred_on', toDate)
      .order('occurred_on', { ascending: false }),
  ]);

  type EntryRow = {
    id: string;
    category: string;
    amount: string | number;
    note: string | null;
    occurred_on: string;
    sessions: { title: string } | null;
  };

  const toEntry = (kind: 'expense' | 'income') => (r: EntryRow): FinanceEntryRow => ({
    id: r.id,
    kind,
    category: r.category,
    amount: moneyFromDb(r.amount),
    note: r.note,
    occurredOn: r.occurred_on,
    sessionTitle: r.sessions?.title ?? null,
  });

  const expenses = ((expenseRows ?? []) as unknown as EntryRow[]).map(toEntry('expense'));
  const incomes = ((incomeRows ?? []) as unknown as EntryRow[]).map(toEntry('income'));

  const report = calculateFinanceReport({
    charges,
    otherIncomes: incomes.map((i) => i.amount),
    expenses: expenses.map((e) => e.amount),
  });

  const entries = [...expenses, ...incomes].sort((a, b) =>
    a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0,
  );

  const canManage = can({ role }, 'gang.finance.manage');

  // ต้นทุนจริงของช่วงนี้ = เรียกเก็บแล้ว − เศษ
  // ⚠️ คิดเป็นจำนวนเต็มสตางค์ผ่าน helper ของ domain — ❌ ห้ามลบเงินด้วย float ในหน้าจอ
  const actualCost = fromSatang(toSatang(report.charged) - toSatang(report.roundingSurplus));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">รายงาน · {gang.name}</h1>
        <Link href={`/gangs/${gangId}/payments`} className="underline">
          เก็บเงิน
        </Link>
      </div>

      <Card padding={4} variant="muted">
        <p className="text-sm">
          ช่วง {fromDate} ถึง {toDate}
        </p>
        {/* เปลี่ยนช่วงด้วย query string — ยังไม่ทำ date picker (ไม่อยู่ใน scope ของใบนี้) */}
        <p className="mt-1 text-xs opacity-70">
          เปลี่ยนช่วงเวลาได้ที่ URL: <code>?from=YYYY-MM-DD&to=YYYY-MM-DD</code>
        </p>
      </Card>

      <div className="mt-4">
        <Card padding={4}>
          <h2 className="mb-3 text-base font-semibold">สรุป</h2>

          <dl className="flex flex-col gap-2 text-sm">
            <Row label="เรียกเก็บแล้ว" value={`${report.charged} บาท`} />
            <Row label="เก็บได้จริง (หัก refund)" value={`${report.collected} บาท`} strong />
            <Row label="ยังค้างเก็บ" value={`${report.outstanding} บาท`} />
            {report.credit !== '0.00' ? (
              <Row label="ต้องคืนผู้เล่น" value={`${report.credit.replace('-', '')} บาท`} />
            ) : null}
            <Row label="รายรับอื่น" value={`${report.otherIncome} บาท`} />
            <Row label="รายจ่าย" value={`${report.expense} บาท`} />
            <Row label="เหลือ (เงินสด)" value={`${report.netCash} บาท`} strong />
          </dl>

          {/*
            🔴 บรรทัดที่ทำให้ reconcile ได้ (baseline §Verification):
               sum(charges) − ต้นทุนจริง = rounding surplus
          */}
          <p className="mt-3 border-t pt-3 text-sm">
            เศษจากการปัดที่เข้าก๊วน <strong>{report.roundingSurplus} บาท</strong>
            <span className="block text-xs opacity-70">
              ต้นทุนจริงของช่วงนี้ = เรียกเก็บแล้ว − เศษ ={' '}
              {actualCost} บาท
            </span>
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card padding={4}>
          <h2 className="mb-1 text-base font-semibold">รายรับอื่น / รายจ่าย</h2>
          <p className="mb-3 text-xs opacity-70">
            ยอดที่เก็บจากผู้เล่นมาจากการปิดรอบอัตโนมัติ — ที่นี่ไว้บันทึกเงินนอกบิลเท่านั้น
          </p>

          {canManage ? (
            <FinanceEntries gangId={gangId} entries={entries} today={today} />
          ) : (
            <p className="text-sm">ดูได้อย่างเดียว — แก้ไขได้เฉพาะแอดมิน</p>
          )}
        </Card>
      </div>
    </main>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt>{label}</dt>
      <dd className={strong ? 'font-semibold' : undefined}>{value}</dd>
    </div>
  );
}
