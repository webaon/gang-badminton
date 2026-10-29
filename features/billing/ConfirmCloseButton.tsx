'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { VStack } from '@astryxdesign/core/VStack';

import { closeSessionWithBilling } from '@/server/actions/billing';

/**
 * ปุ่มยืนยันปิดรอบ — **[WO-2.5-A]**
 *
 * 🔴 หน้านี้เป็นด่านสุดท้ายก่อนเงินถูก commit (`close_session_with_charges()`)
 *    ปิดแล้วแก้ยอดไม่ได้ ⇒ ต้องเห็นตัวเลขต่อคนก่อนเสมอ ไม่ใช่กดจากหน้ารายละเอียดนัดตรงๆ
 *
 * ⚠️ ช่อง "ยืนยันทั้งที่ไม่มีใครเช็คอิน" โผล่เฉพาะตอนที่ server เตือนจริงเท่านั้น
 *    (ไม่ใช่ติ๊กไว้ล่วงหน้าได้ทุกครั้ง) — ไม่งั้นก็เท่ากับไม่มีด่าน
 *
 * [WO-6.4b] reskin เป็น Astryx stack + กัน network/5xx ค้าง — ด่านทั้งหมดคงเดิม
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

    try {
      const result = await closeSessionWithBilling(sessionId, {
        toStatus: 'billing',
        confirmNoCheckIn: confirmed,
      });

      if (result.success) {
        router.replace(`/gangs/${gangId}/sessions/${sessionId}`);
        router.refresh();
        return;
      }
      setError(actionError(result.error));
    } catch {
      // network/5xx — ไม่ปล่อยให้ปุ่มค้างเป็น disabled ตลอดไป
      setError(actionError({ code: 'INTERNAL_ERROR', message: '' }));
    }
    setPending(false);
  }

  return (
    <VStack gap={3}>
      {needsCheckInConfirmation ? (
        <CheckboxInput
          label="เข้าใจแล้ว — ยืนยันปิดรอบทั้งที่ไม่มีใครเช็คอิน"
          value={confirmed}
          onChange={setConfirmed}
        />
      ) : null}

      <Button
        variant="primary"
        size="lg"
        width="100%"
        label="ยืนยันปิดรอบ เก็บเงิน"
        isLoading={pending}
        isDisabled={pending || (needsCheckInConfirmation && !confirmed)}
        onClick={close}
      />

      {error ? <Banner status="error" title={error} /> : null}
    </VStack>
  );
}
