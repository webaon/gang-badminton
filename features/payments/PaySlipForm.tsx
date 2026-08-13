'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';

import { supabaseBrowser } from '@/lib/supabase/client';
import { prepareSlipUpload, submitSlip } from '@/server/actions/payments';

/**
 * อัปสลิป
 *
 * 🔴 [D-15] **server เป็นคนบอก path** — client แค่อัปโหลดไปที่ path ที่ได้มา
 *    สิทธิ์ของ storage ตรวจจาก path ⇒ ให้ client ตั้งเอง = ให้ client เลือกสิทธิ์เอง
 */
export function PaySlipForm({ paymentId, status }: { paymentId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onFile(file: File) {
    setPending(true);
    setError(null);

    const prepared = await prepareSlipUpload(paymentId, file.name);
    if (!prepared.success) {
      setError(prepared.error.message);
      setPending(false);
      return;
    }

    const { error: uploadError } = await supabaseBrowser()
      .storage.from(prepared.data.bucket)
      .upload(prepared.data.path, file, { upsert: true });

    if (uploadError) {
      setError(`อัปโหลดไม่สำเร็จ: ${uploadError.message}`);
      setPending(false);
      return;
    }

    const submitted = await submitSlip(paymentId, prepared.data.path);
    if (submitted.success) router.refresh();
    else setError(submitted.error.message);

    setPending(false);
  }

  if (status === 'verified') {
    return <Banner status="success" title="ยืนยันการจ่ายแล้ว" />;
  }

  return (
    <div>
      <label className="flex flex-col gap-1 text-sm">
        <span>{status === 'rejected' ? 'อัปสลิปใหม่' : 'อัปสลิปโอนเงิน'}</span>
        <input
          type="file"
          accept="image/*,application/pdf"
          disabled={pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
          className="rounded-lg border p-2"
        />
      </label>

      {pending ? <p className="mt-2 text-sm">กำลังอัปโหลด…</p> : null}
      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
    </div>
  );
}
