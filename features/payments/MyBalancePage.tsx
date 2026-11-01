import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { StatePanel } from '@/components/ui/StatePanel';
import { baht, isZeroAmount } from '@/domain/sessions/close-view';
import { requireUser } from '@/lib/supabase/auth';
import { errorText } from '@/lib/i18n/error-text';
import { myBalance } from '@/server/actions/payments';
import { getMyCredit } from '@/server/actions/credit';

/** H29: server actions enforce identity; never accept a target user id from the URL. */
export async function MyBalancePage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const href = `/gangs/${gangId}/my-payments`;
  await requireUser(href);
  const [result, wallet] = await Promise.all([myBalance(gangId), getMyCredit(gangId)]);
  if (!result.success || !wallet.success) {
    const error = !result.success ? result.error : !wallet.success ? wallet.error : undefined;
    return <StatePanel tone="error" title="โหลดยอดไม่สำเร็จ" description={errorText(error)}
      actions={[{ label: 'ลองใหม่', href }]} />;
  }
  const { items, totals } = result.data;
  return <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4">
    <Heading level={1}>ยอดของฉัน</Heading>
    <Card padding={4}>
      <VStack gap={2}>
        <Text type="supporting">ยอดค้างทั้งหมด</Text>
        <Heading level={2}>{baht(totals.outstanding)}</Heading>
        <Text type="supporting">จ่ายแล้ว {baht(totals.paid)}</Text>
        {!isZeroAmount(totals.credit) ? <Text>ก๊วนต้องคืนให้ {baht(totals.credit.replace(/^-/, ''))}</Text> : null}
      </VStack>
    </Card>
    {!isZeroAmount(wallet.data.balance) ? <Banner status="info" title={`เครดิตคงเหลือ ${baht(wallet.data.balance)}`}
      description="ระบบจะหักเครดิตอัตโนมัติเมื่อมีหนี้ใหม่" /> : null}
    <Heading level={2}>รายการของฉัน</Heading>
    {items.length === 0 ? <StatePanel fullPage={false} headingLevel={3} title="ยังไม่มีรายการ"
      description="ยอดของคุณจะปรากฏหลังปิดรอบหรือออกบิลรายเดือน"
      actions={[{ label: 'ดูนัดเล่น', href: `/gangs/${gangId}/sessions` }]} /> : null}
    {items.map((item) => <VStack as="article" key={item.chargeIds.join(':')} gap={2} className="min-w-0 border-b border-border pb-4">
      <HStack justify="between" align="start" gap={2} wrap="wrap">
        <Heading level={3}>{item.kind === 'monthly_fee' ? `ค่าสมาชิกรายเดือน ${item.date?.slice(0, 7) ?? ''}` : item.sessionTitle ?? 'นัดเล่น'}</Heading>
        <Text weight="semibold" hasTabularNumbers>ค้าง {baht(item.outstanding)}</Text>
      </HStack>
      <Text type="supporting" size="sm">ยอดตั้งต้น {baht(item.amount)} · จ่ายแล้ว {baht(item.paid)}</Text>
      {!isZeroAmount(item.adjusted) ? <Text size="sm">ปรับยอด {baht(item.adjusted)}</Text> : null}
      {!isZeroAmount(item.credit) ? <Text size="sm">ก๊วนต้องคืนให้ {baht(item.credit.replace(/^-/, ''))}</Text> : null}
      {item.latestPayment?.status === 'submitted' ? <Text type="supporting">ส่งสลิปแล้ว รอแอดมินยืนยัน</Text> : null}
      {item.sessionId ? <Button variant="secondary" label={`ดูยอดและจ่าย — ${item.sessionTitle ?? 'นัดเล่น'}`}
        href={`/gangs/${gangId}/sessions/${item.sessionId}/pay`}>
          <Text weight="semibold">{`ดูยอดและจ่าย — ${item.sessionTitle ?? 'นัดเล่น'}`}</Text>
        </Button> : <Text type="supporting" size="sm">บิลรายเดือน — ติดต่อแอดมินเพื่อชำระ</Text>}
    </VStack>)}
  </VStack>;
}
