'use client';

import { useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';

import { actionError } from '@/lib/i18n/error-text';
import { cancelAsGuest } from '@/server/actions/guest';

/**
 * ⚠️ **[WO-2.5-F]** ไม่รับ token อีกต่อไป — server action อ่านจาก cookie httpOnly
 *    (token ที่ผ่านมือ client ได้ = token ที่หลุดไปกับ log/extension ได้)
 *
 * [WO-6.2] มีขั้นยืนยันก่อนยกเลิก (กดพลาดแล้วเสียที่) — ไม่อ้างค่าปรับ/เวลา เพราะ guest ไม่มี preview จาก server
 */
export function GuestCancelButton({ registrationId }: { registrationId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function onConfirm() {
    setPending(true);
    setError(null);

    const result = await cancelAsGuest(registrationId);

    if (result.success) setCancelled(true);
    else setError(actionError(result.error));

    setPending(false);
    setConfirmOpen(false);
  }

  if (cancelled) {
    return <Banner status="info" title="ยกเลิกเรียบร้อยแล้ว" />;
  }

  return (
    <VStack gap={3}>
      <Button variant="secondary" size="lg" width="100%" label="ยกเลิกการลงชื่อ" onClick={() => setConfirmOpen(true)} />
      {error ? <Banner status="error" title={error} /> : null}
      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open);
        }}
        title="ยกเลิกการลงชื่อ?"
        description="ที่ของคุณจะถูกปล่อยให้คนในคิวรอ และลิงก์นี้จะใช้ลงชื่อใหม่ไม่ได้ ถ้าใกล้เวลาเริ่ม อาจมีค่าปรับตามกติกาของก๊วน"
        actionLabel="ยืนยันยกเลิก"
        cancelLabel="ไม่ยกเลิก"
        onAction={onConfirm}
        isActionLoading={pending}
      />
    </VStack>
  );
}
