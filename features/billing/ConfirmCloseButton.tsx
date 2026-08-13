'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';

import { closeSessionWithBilling } from '@/server/actions/billing';

/**
 * ปุ่มยืนยันปิดรอบ — **[WO-2.5-A]**
 *
 * 🔴 หน้านี้เป็นด่านสุดท้ายก่อนเงินถูก commit (`close_session_with_charges()`)
 *    ปิดแล้วแก้ยอดไม่ได้ ⇒ ต้องเห็นตัวเลขต่อคนก่อนเสมอ ไม่ใช่กดจากหน้ารายละเอียดนัดตรงๆ
 *
 * ⚠️ ช่อง "ยืนยันทั้งที่ไม่มีใครเช็คอิน" โผล่เฉพาะตอนที่ server เตือนจริงเท่านั้น
 *    (ไม่ใช่ติ๊กไว้ล่วงหน้าได้ทุกครั้ง) — ไม่งั้นก็เท่ากับไม่มีด่าน
 */
export function ConfirmCloseButton({
  sessionId,
  gangId,
  needsCheckInConfirmation,
}: {
  sessionId: string;
  gangId: string;
  needsCheckInConfirmation: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function close() {
    setPending(true);
    setError(null);

    const result = await closeSessionWithBilling(sessionId, {
      toStatus: 'billing',
      confirmNoCheckIn: confirmed,
    });

    if (result.success) {
      router.replace(`/gangs/${gangId}/sessions/${sessionId}`);
      router.refresh();
    } else {
      setError(result.error.message);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {needsCheckInConfirmation ? (
        <CheckboxInput
          label="เข้าใจแล้ว — ยืนยันปิดรอบทั้งที่ไม่มีใครเช็คอิน"
          value={confirmed}
          onChange={setConfirmed}
        />
      ) : null}

      <div className="flex gap-2">
        <Button
          variant="primary"
          label="ยืนยันปิดรอบ เก็บเงิน"
          isDisabled={pending || (needsCheckInConfirmation && !confirmed)}
          onClick={close}
        />
      </div>

      {error ? <Banner status="error" title={error} /> : null}
    </div>
  );
}
