import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { requireUser } from '@/lib/supabase/auth';
import { actionError } from '@/lib/i18n/error-text';
import { StatePanel } from '@/components/ui/StatePanel';
import { baht } from '@/domain/sessions/close-view';
import { adminLedger, type LedgerFilter } from '@/server/actions/payment-admin';
import { adminPaymentList } from '@/server/actions/payment-list';
import { listGangCredits } from '@/server/actions/credit';
import { financeReader } from '@/server/payments/admin-read';
import { can } from '@/domain/permissions/can';
import { LedgerPanel } from '@/features/payments/LedgerPanel';

type Search = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ gangId: string }>; searchParams: Promise<Search> };
const value = (q: Search, key: string) => typeof q[key] === 'string' ? q[key] : undefined;
const PAYMENT_STATUS = { submitted: 'รอตรวจ', verified: 'ยืนยันแล้ว', rejected: 'ปฏิเสธแล้ว', pending: 'รอโอน' } as const;
const LEDGER_STATUS = { outstanding: 'ค้างจ่าย', settled: 'ชำระครบ', credit: 'ต้องคืน' } as const;
const AGING = { '0-7': '0–7 วัน', '8-30': '8–30 วัน', '>30': 'เกิน 30 วัน' } as const;
function href(path: string, filters: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, item] of Object.entries(filters)) if (item) query.set(key, item);
  const suffix = query.toString();
  return `${path}${suffix ? `?${suffix}` : ''}`;
}
function Navigation({ gangId }: { gangId: string }) {
  return <HStack gap={2} wrap="wrap">
    <Button variant="ghost" label="คิวตรวจสลิป" href={`/gangs/${gangId}/payments/review`} />
    <Button variant="ghost" label="ยอดค้างจ่าย" href={`/gangs/${gangId}/payments/outstanding`} />
    <Button variant="ghost" label="กระเป๋าเครดิต" href={`/gangs/${gangId}/payments/credits`} />
    <Button variant="ghost" label="รายงานการเงิน" href={`/gangs/${gangId}/reports`} />
  </HStack>;
}

/** Counts are server-wide within the session scope; never count the current page as a tab total. */
export async function PaymentQueuePage({ params, searchParams }: Props) {
  const { gangId } = await params;
  const path = `/gangs/${gangId}/payments/review`;
  await requireUser(path);
  const q = await searchParams;
  const rawStatus = value(q, 'status');
  const status = rawStatus && Object.hasOwn(PAYMENT_STATUS, rawStatus) ? rawStatus as keyof typeof PAYMENT_STATUS : 'submitted';
  const sessionId = value(q, 'sessionId');
  const cursor = value(q, 'cursor');
  const result = await adminPaymentList(gangId, { pageSize: 25, cursor, filter: { status, sessionId } });
  if (!result.success) return <StatePanel fullPage={false} tone="error" title="โหลดคิวตรวจสลิปไม่ได้"
    description={actionError(result.error)} actions={[{ label: 'ลองใหม่จากหน้าแรก', href: href(path, { status, sessionId }) }, { label: 'กลับหน้านัด', href: `/gangs/${gangId}/sessions` }]} />;
  const { rows, counts, nextCursor } = result.data;
  return <VStack gap={4} className="mx-auto w-full max-w-4xl p-4">
    <Navigation gangId={gangId} />
    <Heading level={1}>คิวตรวจสลิป</Heading>
    <Text type="supporting">ตรวจทีละใบ เรียงรายการรอตรวจเก่าก่อน</Text>
    <HStack gap={2} wrap="wrap">
      {(Object.keys(PAYMENT_STATUS) as (keyof typeof PAYMENT_STATUS)[]).map((tab) => <Button key={tab}
        label={`${PAYMENT_STATUS[tab]} (${counts[tab]})`} variant={tab === status ? 'primary' : 'secondary'}
        href={href(path, { status: tab, sessionId })} />)}
    </HStack>
    {sessionId ? <Button variant="ghost" label="แสดงทุกนัด" href={href(path, { status })} /> : null}
    {rows.length === 0 ? <Text>ไม่มีรายการในหน้านี้</Text> : null}
    {rows.map((row) => <Card key={row.paymentId} padding={4}>
      <VStack gap={2}>
        <HStack justify="between" gap={2} wrap="wrap">
          <Heading level={2}>{row.payerDisplayName}</Heading>
          <Text hasTabularNumbers weight="semibold">{baht(row.amount)}</Text>
        </HStack>
        <Text>{PAYMENT_STATUS[row.status]} · {row.hasSlip ? 'มีสลิปแนบ' : 'ยังไม่มีสลิปแนบ'}</Text>
        <Text type="supporting">นัด / รายการ: {row.sessionTitles.join(' · ') || 'ยังไม่มีรายการหนี้'}</Text>
        <Text>ยอดที่โอนจริง: {row.receivedAmount === null ? 'ยังไม่บันทึก' : baht(row.receivedAmount)}</Text>
        <Button label="เปิดตรวจสลิป" href={`/gangs/${gangId}/payments/${row.paymentId}`} />
      </VStack>
    </Card>)}
    <HStack gap={2} wrap="wrap">
      {cursor ? <Button label="กลับหน้าแรกของรายการ" href={href(path, { status, sessionId })} /> : null}
      {nextCursor ? <Button label="หน้าถัดไป" href={href(path, { status, sessionId, cursor: nextCursor })} /> : null}
    </HStack>
  </VStack>;
}

/** Cursor changes rows only; every KPI is the loader's summary of the entire filtered scope. */
export async function OutstandingPage({ params, searchParams }: Props) {
  const { gangId } = await params;
  const path = `/gangs/${gangId}/payments/outstanding`;
  await requireUser(path);
  const q = await searchParams;
  const rawStatus = value(q, 'status');
  const rawAging = value(q, 'aging');
  const status = rawStatus && Object.hasOwn(LEDGER_STATUS, rawStatus) ? rawStatus as LedgerFilter['status'] : undefined;
  const aging = rawAging && Object.hasOwn(AGING, rawAging) ? rawAging as LedgerFilter['aging'] : undefined;
  const sessionId = value(q, 'sessionId');
  const cursor = value(q, 'cursor');
  const filter = { status, aging, sessionId };
  const result = await adminLedger(gangId, { pageSize: 25, cursor, filter });
  if (!result.success) return <StatePanel fullPage={false} tone="error" title="โหลดยอดค้างจ่ายไม่ได้"
    description={actionError(result.error)} actions={[{ label: 'ลองใหม่จากหน้าแรก', href: href(path, filter) }, { label: 'กลับหน้านัด', href: `/gangs/${gangId}/sessions` }]} />;
  const { rows, summary, nextCursor } = result.data;
  const { ctx } = await financeReader(gangId);
  const permissions = { combine: can(ctx, 'payment.verify') && can(ctx, 'payment.submit.self'), adjust: can(ctx, 'payment.verify') };
  const credits = permissions.combine ? await listGangCredits(gangId) : null;
  if (credits && !credits.success) return <StatePanel fullPage={false} tone="error" title="โหลดรายชื่อผู้จ่ายไม่ได้" description={actionError(credits.error)} actions={[{ label: 'ลองใหม่', href: path }]} />;
  const payers = new Map<string, { userId: string; displayName: string }>();
  if (credits?.success) for (const member of credits.data.eligibleMembers) payers.set(member.userId, member);
  for (const row of rows) if (row.userId) payers.set(row.userId, { userId: row.userId, displayName: row.displayName });
  return <VStack gap={4} className="mx-auto w-full max-w-4xl p-4">
    <Navigation gangId={gangId} />
    <Heading level={1}>ยอดค้างจ่าย</Heading>
    <Card padding={4} variant="muted"><VStack gap={2}>
      <Text>ค้างเก็บ {baht(summary.outstanding)} · ลูกหนี้ {summary.debtors} คน</Text>
      <Text>รับชำระด้วยเงินโอน {baht(summary.transferPaid)}</Text>
      <Text>ชำระด้วยเครดิต {baht(summary.creditPaid)}</Text>
      <Text>ต้องคืนสมาชิก {baht(summary.credit.replace(/^-/, ''))}</Text>
      <Text type="supporting" size="sm">ยอดรวมทุกหน้าในตัวกรองนี้ ไม่ใช่ยอดเฉพาะหน้าที่เปิด</Text>
    </VStack></Card>
    <HStack gap={2} wrap="wrap">
      <Button label="ทุกสถานะ" variant={!status ? 'primary' : 'secondary'} href={href(path, { aging, sessionId })} />
      {(Object.keys(LEDGER_STATUS) as (keyof typeof LEDGER_STATUS)[]).map((tab) => <Button key={tab}
        label={LEDGER_STATUS[tab]} variant={tab === status ? 'primary' : 'secondary'} href={href(path, { ...filter, status: tab })} />)}
    </HStack>
    <Heading level={2}>อายุหนี้</Heading>
    <Text type="supporting" size="sm">นับจากวันนัดตามเวลาไทย · ค่ารายเดือนนับจากวันที่สร้างรายการ</Text>
    <HStack gap={2} wrap="wrap">
      <Button variant="secondary" aria-current={!aging ? 'page' : undefined} label={`${!aging ? '✓ ' : ''}ทุกช่วงอายุหนี้`} href={href(path, { status, sessionId })} />
      {(Object.keys(AGING) as (keyof typeof AGING)[]).map((bucket) => <Button key={bucket} variant="secondary" aria-current={aging === bucket ? 'page' : undefined}
        label={`${aging === bucket ? '✓ ' : ''}${AGING[bucket]} · ${summary.aging[bucket].debtors} คน · ${baht(summary.aging[bucket].outstanding)}`}
        href={href(path, { ...filter, aging: bucket })} />)}
    </HStack>
    {sessionId ? <Button variant="ghost" label="แสดงทุกนัด" href={href(path, { status, aging })} /> : null}
    {rows.length === 0 ? <Text>ไม่มีรายการในหน้านี้</Text> : null}
    <LedgerPanel key={href(path, { ...filter, cursor })} gangId={gangId} rows={rows} payers={[...payers.values()]} permissions={permissions} />
    <HStack gap={2} wrap="wrap">
      {cursor ? <Button label="กลับหน้าแรกของรายการ" href={href(path, filter)} /> : null}
      {nextCursor ? <Button label="หน้าถัดไป" href={href(path, { ...filter, cursor: nextCursor })} /> : null}
    </HStack>
  </VStack>;
}
