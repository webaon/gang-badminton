'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { issueCheckinQr } from '@/server/actions/game-console';

/**
 * QR เช็คอินของผู้เล่น — **[WO-2.5-F]**
 *
 * 🔴 QR ไม่ได้ถูกสร้างไว้ล่วงหน้า — กดขอถึงจะออก และ**ออกใหม่ทุกครั้งที่กด**
 *    (ของเดิมใช้ไม่ได้ทันที) ⇒ ภาพ QR ที่หลุดไปในแชทกลุ่มไม่ใช่กุญแจถาวร
 *
 * ⚠️ client ได้รับ**ภาพ QR** ไม่ใช่ token — token ไม่เคยผ่าน JavaScript ฝั่งเบราว์เซอร์
 */
export function CheckinQrButton({ registrationId }: { registrationId: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onIssue() {
    setPending(true);
    setError(null);

    const issued = await issueCheckinQr(registrationId);

    if (issued.success) setDataUrl(issued.data.dataUrl);
    else setError(actionError(issued.error));

    setPending(false);
  }

  return (
    <VStack gap={3} align="center">
      <Button
        label={dataUrl ? 'ขอ QR ใหม่' : 'QR เช็คอินของฉัน'}
        isLoading={pending}
        onClick={onIssue}
      />

      {dataUrl ? (
        <VStack gap={2} align="center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={dataUrl} alt="QR เช็คอิน" className="mx-auto w-56" />
          <Text type="supporting" size="sm" justify="center">
            ให้แอดมินสแกนตอนถึงสนาม
          </Text>
        </VStack>
      ) : null}

      {error ? <Banner status="error" title={error} /> : null}
    </VStack>
  );
}
