'use client';

import { useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { chargeHistory } from '@/server/actions/payment-admin';
import { returnChargeToCredit } from '@/server/actions/credit';
import { actionError } from '@/lib/i18n/error-text';
import { baht } from '@/domain/sessions/close-view';

type Result = Awaited<ReturnType<typeof chargeHistory>>;
type History = Extract<Result, { success: true }>['data'];
const RETURN_STATE = { none: 'ยังไม่มีรายการลดหนี้', debt_reduced: 'ลดหนี้แล้ว ยังไม่มียอดรอคืนเข้าเครดิต', pending_credit_return: 'มียอดรอคืนเข้าเครดิต', returned: 'คืนเข้าเครดิตแล้ว' };
const ADJUSTMENT: Record<string, string> = { refund: 'คืนเงิน', credit: 'ลดหนี้', correction: 'แก้ไขยอด', credit_return: 'คืนเข้าเครดิต' };
const STATUS: Record<string, string> = { pending: 'รอโอน', submitted: 'รอตรวจ', verified: 'ยืนยันแล้ว', rejected: 'ปฏิเสธแล้ว' };

export function ChargeHistory({ initial }: { initial: History }) {
  const [history, setHistory] = useState(initial);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  async function run(write: boolean) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null); setNotice(null);
    try {
      if (write) {
        setStale(true); setConfirm(false);
        const result = await returnChargeToCredit(history.chargeId, null, reason);
        if (!result.success) { setError(actionError(result.error)); return; }
        setNotice('คืนเข้าเครดิตแล้ว'); setReason('');
      }
      const result = await chargeHistory(history.chargeId);
      if (!result.success) { setError(actionError(result.error)); return; }
      setHistory(result.data); setStale(false);
    } catch { setStale(true); setConfirm(false); setError(actionError({ code: 'INTERNAL_ERROR', message: '' })); }
    finally { busy.current = false; setPending(false); }
  }
  return <VStack gap={4}>
    <Heading level={1}>ประวัติรายการหนี้</Heading>
    <Text>ยอดเรียกเก็บ {baht(history.amount)}</Text>
    <Text>ชำระแล้ว {baht(history.paid)} · ปรับยอด {baht(history.adjusted)}</Text>
    <Text>ยอดสุทธิที่ยังค้าง / ต้องคืน {baht(history.outstanding)}</Text>
    <Banner status="info" title={RETURN_STATE[history.creditReturn.state]} description={`คืนเข้าเครดิตแล้ว ${baht(history.creditReturn.returnedAmount)}`} />
    {notice ? <Banner status="success" title={notice} /> : null}
    {error ? <Banner status="error" title={error} /> : null}
    {stale ? <Banner status="warning" title="โหลดสถานะล่าสุดก่อนทำต่อ" description="คำขออาจบันทึกแล้ว ตรวจประวัติก่อนส่งซ้ำ" /> : null}
    <Button variant="ghost" label="โหลดประวัติล่าสุด" isDisabled={pending} onClick={() => run(false)} />
    {history.creditReturn.canReturn ? <VStack gap={2}>
      <Text>ขั้นที่ 2: คืนยอดที่คืนได้เข้าเครดิต ระบบตรวจสอบเพดานจากยอดที่ได้รับจริง — ไม่ลดหนี้ซ้ำ</Text>
      {confirm ? <>
        <Heading level={2}>ยืนยันคืนยอดที่คืนได้เข้าเครดิต</Heading><Text>เหตุผล: {reason}</Text>
        <Button variant="primary" label="ยืนยันคืนเข้าเครดิต" isDisabled={pending || stale} onClick={() => run(true)} />
        <Button label="กลับไปแก้ไข" isDisabled={pending} onClick={() => setConfirm(false)} />
      </> : <>
        <TextInput label="เหตุผลที่คืนเข้าเครดิต" value={reason} onChange={setReason} />
        <Button label="ตรวจทานการคืนเข้าเครดิต" isDisabled={pending || stale || !reason.trim()} onClick={() => setConfirm(true)} />
      </>}
    </VStack> : null}
    <Heading level={2}>ประวัติการชำระ</Heading>
    {history.allocations.length === 0 ? <Text>ยังไม่มีรายการชำระ</Text> : null}
    {history.allocations.map((a) => <VStack key={a.id} gap={1}>
      <Text>{a.source === 'credit' ? 'เครดิต' : 'เงินโอน'} · {STATUS[a.status ?? ''] ?? 'ไม่ทราบสถานะ'}{a.deleted ? ' · ยกเลิกรายการแล้ว' : ''} · {baht(a.amount)}</Text>
      <Button variant="ghost" label="ดูใบจ่าย" href={`/gangs/${history.gangId}/payments/${a.paymentId}`} />
    </VStack>)}
    <Heading level={2}>ประวัติการปรับยอด</Heading>
    {history.adjustments.length === 0 ? <Text>ยังไม่มีการปรับยอด</Text> : null}
    {history.adjustments.map((a) => <VStack key={a.id} gap={1}>
      <Text>{ADJUSTMENT[a.type] ?? 'ปรับยอด'} · {baht(a.amount)}</Text>
      <Text type="supporting">{a.reason}</Text>
    </VStack>)}
  </VStack>;
}
