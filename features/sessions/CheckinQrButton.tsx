'use client';

import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

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
    else setError(issued.error.message);

    setPending(false);
  }

  return (
    <div>
      <Button
        label={dataUrl ? 'ขอ QR ใหม่' : 'QR เช็คอินของฉัน'}
        isLoading={pending}
        onClick={onIssue}
      />

      {dataUrl ? (
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={dataUrl} alt="QR เช็คอิน" className="mx-auto w-56" />
          <p className="mt-2 text-center text-xs">ให้แอดมินสแกนตอนถึงสนาม</p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
    </div>
  );
}
