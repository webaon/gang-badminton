'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { adminPaymentDetail } from '@/server/actions/payment-admin';
import { reviewPayment } from '@/server/actions/payments';
import { recordOverpayment, setPaymentReceivedAmount } from '@/server/actions/credit';
import { actionError } from '@/lib/i18n/error-text';
import { baht } from '@/domain/sessions/close-view';

type Result = Awaited<ReturnType<typeof adminPaymentDetail>>;
export type PaymentDetail = Extract<Result, { success: true }>['data'];
type Step = 'received' | 'verify' | 'reject' | 'overpayment';
const COMPARISON = { unknown: 'ยังไม่ได้บันทึกยอดที่โอนจริง', equal: 'ยอดตรง', over: 'โอนเกิน', under: 'โอนน้อยกว่ายอดใบจ่าย' };
const STATUS: Record<string, string> = { pending: 'รอโอน', submitted: 'รอตรวจสลิป', verified: 'ยืนยันแล้ว', rejected: 'ปฏิเสธแล้ว' };
const CONFIRM: Record<Step, string> = { received: 'บันทึกยอดที่โอนจริง', verify: 'ยืนยันการจ่าย', reject: 'ยืนยันปฏิเสธ', overpayment: 'บันทึกโอนเกินเข้าเครดิต' };

/** One explicit mutation per confirmation; re-read server state before offering another step. */
export function PaymentReview({ initial }: { initial: PaymentDetail }) {
  const [detail, setDetail] = useState(initial);
  const [received, setReceived] = useState(initial.receivedAmount ?? '');
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<Step | null>(null);
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const busy = useRef(false);

  async function reload() {
    const result = await adminPaymentDetail(detail.id);
    if (!result.success) { setError(actionError(result.error)); return false; }
    setDetail(result.data);
    setStep(null);
    setReceived(result.data.receivedAmount ?? '');
    setImageFailed(false);
    setStale(false);
    return true;
  }
  async function run(write: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true); setError(null); setNotice(null);
    try {
      if (write && step) {
        // Even a transport error may follow a committed action; require re-read before retrying.
        setStale(true);
        const result = step === 'received' ? await setPaymentReceivedAmount(detail.id, received)
          : step === 'overpayment' ? await recordOverpayment(detail.id, null, reason)
          : await reviewPayment(detail.id, step === 'verify' ? 'verified' : 'rejected', reason);
        setStep(null);
        if (!result.success) { setError(actionError(result.error)); return; }
        setNotice('บันทึกขั้นตอนนี้แล้ว');
        setReason('');
      }
      await reload();
    } catch { setStale(true); setStep(null); setError(actionError({ code: 'INTERNAL_ERROR', message: '' })); }
    finally { busy.current = false; setPending(false); }
  }
  const locked = pending || stale;
  return <VStack gap={4}>
    <Heading level={1}>ตรวจสลิป</Heading>
    <Text>{detail.payerDisplayName ?? 'ไม่ทราบชื่อผู้จ่าย'} · {STATUS[detail.status] ?? 'ไม่ทราบสถานะ'}</Text>
    <Heading level={2}>ยอดใบจ่าย {baht(detail.amount)}</Heading>
    {detail.slip ? <VStack gap={2}>
      {detail.slip.kind === 'image' && !imageFailed ? <Image unoptimized src={detail.slip.url} alt="สลิปการโอน" width={640} height={900}
        className="h-auto max-h-screen w-full object-contain" onError={() => setImageFailed(true)} />
        : <Text>{detail.slip.kind === 'pdf' ? 'สลิป PDF — เปิดเอกสารเพื่อตรวจสอบ' : 'แสดงตัวอย่างไม่ได้ — เปิดไฟล์ต้นฉบับเพื่อตรวจสอบ'}</Text>}
      <Button variant="secondary" label="เปิดสลิปต้นฉบับ" href={detail.slip.url} target="_blank" rel="noopener noreferrer" />
      <Text type="supporting" size="sm">ลิงก์มีอายุ 5 นาที หากเปิดไม่ได้ให้โหลดข้อมูลใหม่</Text>
    </VStack> : <Banner status="warning" title="ยังไม่มีสลิปแนบ" />}
    <Text>ยอดที่โอนจริง: {detail.receivedAmount === null ? 'ยังไม่บันทึก' : baht(detail.receivedAmount)}</Text>
    <Banner status={detail.comparison === 'under' ? 'warning' : 'info'} title={COMPARISON[detail.comparison]}
      description={detail.comparison === 'over' ? `ส่วนเกิน ${baht(detail.overpaymentAmount)}` : undefined} />
    {detail.overpayment ? <Banner status="success" title={`บันทึกโอนเกินเข้าเครดิตแล้ว ${baht(detail.overpayment.amount)}`} /> : null}
    {notice ? <Banner status="success" title={notice} /> : null}
    {error ? <Banner status="error" title={error} /> : null}
    {stale ? <Banner status="warning" title="โหลดสถานะล่าสุดก่อนทำต่อ" description="คำขอเดิมอาจบันทึกแล้ว อย่าส่งขั้นตอนเดิมซ้ำก่อนตรวจสอบ" /> : null}
    <Button variant="ghost" label="โหลดข้อมูลและลิงก์สลิปใหม่" isDisabled={pending} onClick={() => run(false)} />
    {step ? <VStack gap={2}>
      <Heading level={2}>ตรวจทานก่อนยืนยัน</Heading>
      <Text>{CONFIRM[step]}</Text>
      <Text>{step === 'received' ? received : step === 'overpayment' ? baht(detail.overpaymentAmount) : baht(detail.amount)}</Text>
      {reason ? <Text>เหตุผล: {reason}</Text> : null}
      <HStack gap={2} wrap="wrap">
        <Button label="ยืนยันขั้นตอนนี้" variant={step === 'reject' ? 'destructive' : 'primary'} isDisabled={locked} onClick={() => run(true)} />
        <Button label="กลับไปแก้ไข" isDisabled={pending} onClick={() => setStep(null)} />
      </HStack>
    </VStack> : <VStack gap={3}>
      {detail.permissions.setReceivedAmount ? <VStack gap={2}>
        <TextInput label="ยอดที่โอนจริง (บาท)" value={received} onChange={setReceived} />
        <Button label="ตรวจทานยอดที่โอนจริง" isDisabled={locked || !received.trim()} onClick={() => setStep('received')} />
      </VStack> : null}
      {detail.permissions.verify ? <Button variant="primary" label="ยืนยันการจ่าย" isDisabled={locked || detail.receivedAmount === null || received !== detail.receivedAmount} onClick={() => setStep('verify')} /> : null}
      {detail.permissions.reject || detail.permissions.recordOverpayment ? <TextInput label="เหตุผล" value={reason} onChange={setReason} /> : null}
      {detail.permissions.reject ? <Button variant="destructive" label="ปฏิเสธสลิป" isDisabled={locked || !reason.trim()} onClick={() => setStep('reject')} /> : null}
      {detail.permissions.recordOverpayment ? <Button label="บันทึกโอนเกินเข้าเครดิต" isDisabled={locked || !reason.trim()} onClick={() => setStep('overpayment')} /> : null}
    </VStack>}
    <Heading level={2}>รายการที่ใบจ่ายนี้ครอบคลุม</Heading>
    {detail.allocations.map((allocation) => <HStack key={allocation.id} justify="between" gap={2} wrap="wrap">
      <Button variant="ghost" label="ดูประวัติรายการหนี้" href={`/gangs/${detail.gangId}/payments/charges/${allocation.chargeId}`} />
      <Text hasTabularNumbers>{baht(allocation.amount)}</Text>
    </HStack>)}
  </VStack>;
}
