import { notFound, redirect } from 'next/navigation';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import { baht } from '@/domain/sessions/close-view';
import { actionError } from '@/lib/i18n/error-text';
import { StatePanel } from '@/components/ui/StatePanel';
import { SimpleTable } from '@/components/ui/SimpleTable';
import { financeReport } from '@/server/actions/finance-report';
import { FinanceEntries } from './FinanceEntries';
import { ReportRange } from './ReportRange';

function Row({ label, amount }: { label: string; amount: string }) {
  return <HStack role="group" aria-label={label} justify="between" gap={3} wrap="wrap"><Text>{label}</Text><Text hasTabularNumbers weight="semibold">{baht(amount)}</Text></HStack>;
}

export async function ReportsPage({ params, searchParams }: {
  params: Promise<{ gangId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/reports`);
  const db = await supabaseServer();
  // Existing page-context queries only; all financial data and calculations belong to the loader.
  const { data: gang, error: gangError } = await db.from('gangs').select('id,name').eq('id', gangId).is('deleted_at', null).maybeSingle();
  if (gangError) throw gangError;
  if (!gang) notFound();
  const { data: membership, error: memberError } = await db.from('gang_members').select('role').eq('gang_id', gangId).eq('user_id', user.id).is('deleted_at', null).maybeSingle();
  if (memberError) throw memberError;
  const ctx = { role: (membership?.role as GangRole | undefined) ?? null };
  if (!can(ctx, 'gang.finance.view')) redirect(`/gangs/${gangId}/sessions`);
  const today = utcToZonedWallClock(new Date(), 'Asia/Bangkok').slice(0, 10);
  const query = await searchParams;
  const from = typeof query.from === 'string' ? query.from : `${today.slice(0, 7)}-01`;
  const to = typeof query.to === 'string' ? query.to : today;
  const result = await financeReport(gangId, { from, to });
  if (!result.success) return <StatePanel fullPage={false} tone="error" title="โหลดรายงานไม่ได้" description={actionError(result.error)}
    actions={[{ label: 'ดูรายงานเดือนนี้', href: `/gangs/${gangId}/reports` }, { label: 'กลับหน้านัด', href: `/gangs/${gangId}/sessions` }]} />;
  const data = result.data;
  const { report } = data;
  const asOf = utcToZonedWallClock(new Date(data.outstandingAsOf), data.range.timeZone).replace('T', ' ');
  return <VStack gap={4} className="mx-auto w-full max-w-4xl p-4">
    <Heading level={1}>รายงาน · {gang.name}</Heading>
    <Card padding={4} variant="muted"><VStack gap={2}>
      <Text>ช่วง {data.range.from} ถึง {data.range.to} · เวลาไทย</Text>
      <ReportRange key={`${data.range.from}:${data.range.to}`} gangId={gangId} from={data.range.from} to={data.range.to} />
      <Text type="supporting" size="sm">เงินโอนนับตามวันที่ยืนยันสลิป ส่วนโอนเกินและเงินคืนสมาชิกนับตามวันที่บันทึกรายการ</Text>
    </VStack></Card>
    <Card padding={4}><VStack gap={3}>
      <Heading level={2}>กระแสเงินสดในช่วงเวลา</Heading>
      <Row label="เงินโอนรับชำระก่อนคืนเงิน" amount={data.transferIn} />
      <Row label="คืนเงินจากรายการหนี้" amount={data.refunds} />
      <Row label="เก็บได้จริง (หักคืนเงินแล้ว)" amount={report.collected} />
      <Row label="โอนเกินเข้าเครดิต" amount={report.overpaymentIn} />
      <Row label="รายรับอื่น" amount={report.otherIncome} />
      <Row label="รายจ่าย" amount={report.expense} />
      <Row label="เงินคืนสมาชิก" amount={report.memberPayouts} />
      <Row label="เงินสดสุทธิ" amount={report.netCash} />
      <Text type="supporting" size="sm">เงินสดสุทธิรวมเงินโอนเกินที่ก๊วนยังติดสมาชิก ไม่ใช่กำไรที่ใช้ได้ทั้งหมด</Text>
      <Row label="ชำระด้วยเครดิต (ไม่ใช่เงินสดเข้า)" amount={data.creditAllocated} />
    </VStack></Card>
    <Card padding={4}><VStack gap={3}>
      <Heading level={2}>เงินเข้าต่อนัด</Heading>
      <Text type="supporting" size="sm">เฉพาะเงินโอนก่อนหักคืนเงิน ไม่รวมโอนเกินเข้าเครดิต ใบจ่ายรวมหลายนัดแยกตามรายการที่ชำระ</Text>
      {data.cashInBySession.length === 0 ? <Text>ไม่มีเงินโอนรับชำระในช่วงนี้</Text> : <SimpleTable
        columns={[{ key: 'title', header: 'นัด / รายการ' }, { key: 'amount', header: 'เงินโอนเข้า', widthPx: 125, align: 'end' }]}
        rows={data.cashInBySession.map((s) => ({ id: s.sessionId ?? 'monthly', title: s.sessionTitle ?? 'ค่าสมาชิกรายเดือน', amount: baht(s.amount) }))} />}
      <Text type="supporting" size="sm">ยอดค้าง ณ {asOf} (เวลาไทย) ไม่ใช่ยอดคงเหลือย้อนหลัง ณ วันสิ้นสุดช่วง</Text>
    </VStack></Card>
    <Card padding={4}><VStack gap={3}>
      <Heading level={2}>ยอดเรียกเก็บของนัดในช่วงเวลา</Heading>
      <Text type="supporting" size="sm">เลือกตามวันนัด; ค่ารายเดือนเลือกตามวันที่สร้างรายการ ยอดค้างใช้การชำระและการปรับยอดทั้งหมดจนถึงเวลาข้างต้น</Text>
      <Row label="เรียกเก็บแล้ว" amount={report.charged} />
      <Row label="ยังค้างเก็บ" amount={report.outstanding} />
      <Row label="ต้องคืนผู้เล่น" amount={report.credit.replace(/^-/, '')} />
      <Row label="เศษจากการปัดที่เข้าก๊วน" amount={report.roundingSurplus} />
      <Row label="ต้นทุนจริงของช่วงนี้" amount={data.actualCost} />
    </VStack></Card>
    <Card padding={4}><VStack gap={3}>
      <Heading level={2}>รายรับอื่น / รายจ่าย</Heading>
      <Text type="supporting" size="sm">บันทึกเงินนอกบิลเท่านั้น ไม่บันทึกยอดผู้เล่นซ้ำ</Text>
      {can(ctx, 'gang.finance.manage') ? <FinanceEntries gangId={gangId} today={today}
        entries={data.entries.map((e) => ({ ...e, sessionTitle: null }))} /> : <>
        <Text>ดูได้อย่างเดียว</Text>
        {data.entries.map((entry) => <Row key={`${entry.kind}:${entry.id}`} label={`${entry.occurredOn} · ${entry.category}`} amount={entry.amount} />)}
      </>}
    </VStack></Card>
    <Button variant="ghost" label="ดูยอดค้างจ่ายรายคน" href={`/gangs/${gangId}/payments/outstanding`} />
  </VStack>;
}
