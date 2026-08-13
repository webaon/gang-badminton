'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';

import { reviewPayment, slipSignedUrl } from '@/server/actions/payments';

export function ReviewPaymentActions({ paymentId, hasSlip }: { paymentId: string; hasSlip: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function decide(decision: 'verified' | 'rejected', why?: string) {
    setPending(true);
    setError(null);

    const result = await reviewPayment(paymentId, decision, why);
    if (result.success) {
      setReason(null);
      router.refresh();
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  async function openSlip() {
    setError(null);
    const result = await slipSignedUrl(paymentId);
    // bucket เป็น private ⇒ ต้องใช้ signed URL ที่มีอายุ ไม่ใช่ลิงก์ตรง
    if (result.success) window.open(result.data.url, '_blank', 'noopener');
    else setError(result.error.message);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {hasSlip ? <Button size="sm" label="ดูสลิป" onClick={openSlip} /> : null}
        <Button
          size="sm"
          variant="primary"
          label="ยืนยันการจ่าย"
          isDisabled={pending}
          onClick={() => decide('verified')}
        />
        {reason === null ? (
          <Button size="sm" label="ปฏิเสธ" isDisabled={pending} onClick={() => setReason('')} />
        ) : null}
      </div>

      {reason !== null ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextInput
              label="เหตุผลที่ปฏิเสธ"
              size="sm"
              value={reason}
              onChange={setReason}
              description="ผู้จ่ายจะเห็นข้อความนี้"
            />
          </div>
          <Button
            size="sm"
            variant="destructive"
            label="ยืนยันปฏิเสธ"
            isDisabled={pending || reason.trim() === ''}
            onClick={() => decide('rejected', reason)}
          />
          <Button size="sm" label="ยกเลิก" onClick={() => setReason(null)} />
        </div>
      ) : null}

      {error ? <Banner status="error" title={error} /> : null}
    </div>
  );
}
