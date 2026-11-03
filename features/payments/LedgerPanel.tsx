'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { addChargeAdjustment, createPaymentForCharges } from '@/server/actions/payments';
import type { AdminLedgerRow } from '@/server/actions/payment-admin';
import { actionError } from '@/lib/i18n/error-text';
import { baht } from '@/domain/sessions/close-view';

type Adjustment = 'refund' | 'correction' | 'credit';
const LABEL = { refund: 'คืนเงิน', correction: 'แก้ยอด', credit: 'ลดหนี้' };
export function LedgerPanel({ gangId, rows, payers, permissions }: {
  gangId: string; rows: AdminLedgerRow[];
  payers: { userId: string; displayName: string }[];
  permissions: { combine: boolean; adjust: boolean };
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [payer, setPayer] = useState('');
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [type, setType] = useState<Adjustment>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState<'combine' | 'adjust' | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function commit() {
    if (busy.current || uncertain || !confirmation) return;
    busy.current = true; setPending(true); setUncertain(true); setError(null);
    try {
      if (confirmation === 'combine') {
        const result = await createPaymentForCharges(gangId, selected, payer);
        if (!result.success) { setError(actionError(result.error)); return; }
        setSelected([]); setConfirmation(null);
        router.push(`/gangs/${gangId}/payments/${result.data.paymentId}`);
      } else if (adjusting) {
        // Only step 1 here. History re-reads whether step 2 (credit return) is available.
        const result = await addChargeAdjustment(adjusting, { type, amount, reason });
        if (!result.success) { setError(actionError(result.error)); return; }
        setConfirmation(null);
        router.push(`/gangs/${gangId}/payments/charges/${adjusting}`);
      }
      setUncertain(true);
    } catch { setUncertain(true); setConfirmation(null); setError(actionError({ code: 'INTERNAL_ERROR', message: '' })); }
    finally { busy.current = false; setPending(false); }
  }
  return <VStack gap={3}>
    {error ? <Banner status="error" title={error} /> : null}
    {uncertain ? <Banner status="warning" title="ตรวจสถานะล่าสุดก่อนทำรายการอีกครั้ง" description="รายการอาจบันทึกแล้ว เปิดประวัติหรือโหลดหน้าใหม่ก่อนส่งซ้ำ" /> : null}
    {rows.map((row) => <Card key={row.id} padding={4}><VStack gap={2}>
      <HStack justify="between" wrap="wrap" gap={2}>
        <Heading level={2}>{row.displayName}</Heading><Text weight="semibold" hasTabularNumbers>{baht(row.outstanding)}</Text>
      </HStack>
      <Text>{row.type === 'monthly_fee' ? 'ค่าสมาชิกรายเดือน' : `นัด: ${row.sessionTitle ?? 'ไม่ทราบชื่อนัด'}`}</Text>
      <Text>ยอดเรียกเก็บ {baht(row.amount)} · ชำระแล้ว {baht(row.paid)}</Text>
      <Text>{row.status === 'outstanding' ? `อายุหนี้ ${row.daysOutstanding} วัน` : row.status === 'credit' ? 'ต้องคืนสมาชิก' : 'ชำระครบ'}</Text>
      <HStack wrap="wrap" gap={2}>
        {permissions.combine && row.status === 'outstanding' ? <CheckboxInput label={`เลือก ${row.displayName}`} value={selected.includes(row.id)}
          isDisabled={pending || uncertain || confirmation !== null} onChange={(checked) => setSelected(checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))} /> : null}
        <Button label="ดูประวัติรายการหนี้" variant="ghost" href={`/gangs/${gangId}/payments/charges/${row.id}`} />
        {permissions.adjust ? <Button label="ปรับยอด" isDisabled={pending || uncertain || confirmation !== null} onClick={() => { setAdjusting(row.id); setAmount(''); setReason(''); }} /> : null}
        {row.sessionId ? <Button variant="ghost" label="ดูสลิปของนัดนี้" href={`/gangs/${gangId}/payments/review?sessionId=${row.sessionId}`} /> : null}
      </HStack>
    </VStack></Card>)}
    {permissions.combine && selected.length > 0 && !confirmation ? <VStack gap={2}>
      <Text>เลือกรายการในหน้านี้ {selected.length} รายการ · ยอดรวมให้ระบบคำนวณตอนออกใบ</Text>
      <Selector label="คนจ่าย" value={payer} onChange={setPayer} options={payers.map((p) => ({ value: p.userId, label: p.displayName }))} />
      <Button label="ตรวจทานใบจ่ายรวม" isDisabled={!payer || pending || uncertain} onClick={() => setConfirmation('combine')} />
    </VStack> : null}
    {permissions.adjust && adjusting && !confirmation ? <VStack gap={2}>
      <Heading level={2}>ปรับยอด — {rows.find((r) => r.id === adjusting)?.displayName}</Heading>
      <RadioList label="ประเภทการปรับยอด" value={type} onChange={(v) => setType(v as Adjustment)}>
        {(['credit', 'refund', 'correction'] as const).map((t) => <RadioListItem key={t} value={t} label={LABEL[t]} />)}
      </RadioList>
      <TextInput label="จำนวนเงินปรับยอด" value={amount} onChange={setAmount} description={type === 'correction' ? 'บวกเพิ่มหนี้ ลบลดหนี้' : 'ใส่ค่าติดลบ เช่น -50.00'} />
      <TextInput label="เหตุผลการปรับยอด" value={reason} onChange={setReason} />
      <Text type="supporting">ลดหนี้ไม่ได้ย้ายเงินเข้ากระเป๋าเครดิตทันที หลังบันทึกให้ตรวจประวัติและยืนยันคืนเข้าเครดิตแยกอีกขั้น</Text>
      <Button label="ตรวจทานการปรับยอด" isDisabled={pending || uncertain || !amount.trim() || !reason.trim()} onClick={() => setConfirmation('adjust')} />
    </VStack> : null}
    {confirmation ? <VStack gap={2}>
      <Heading level={2}>ตรวจทานก่อนยืนยัน</Heading>
      <Text>{confirmation === 'combine' ? `ผู้จ่าย: ${payers.find((p) => p.userId === payer)?.displayName} · ${selected.length} รายการ` : `${LABEL[type]} ${amount} บาท · ${reason}`}</Text>
      <Button variant="primary" label="ยืนยันรายการ" isDisabled={pending || uncertain} onClick={commit} />
      <Button label="กลับไปแก้ไข" isDisabled={pending} onClick={() => setConfirmation(null)} />
    </VStack> : null}
  </VStack>;
}
