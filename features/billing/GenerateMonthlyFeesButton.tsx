'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { generateMonthlyFeesNow } from '@/server/actions/membership';

/**
 * ปุ่ม "ออกบิลรอบนี้" — **[WO-2.5-C]**
 *
 * ⚠️ ปกติ cron ออกให้เองอยู่แล้ว ปุ่มนี้มีไว้สองกรณี:
 *    · สมาชิกที่สมัครหลัง cron รันรอบล่าสุด (กติกาคือเก็บเต็มเดือน ⇒ ต้องได้บิลของเดือนนี้)
 *    · แอดมินอยากยืนยันด้วยตาว่ารอบนี้ออกครบแล้ว
 *
 * 🔴 กดซ้ำได้ไม่จำกัด — `commit_monthly_fees()` idempotent ต่อสมาชิก+เดือน
 */
export function GenerateMonthlyFeesButton({
  gangId,
  billingMonth,
}: {
  gangId: string;
  billingMonth: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await generateMonthlyFeesNow(gangId, billingMonth);

    if (result.success) {
      setNotice(
        result.data.created > 0
          ? `ออกบิลใหม่ ${result.data.created} ใบ`
          : 'ออกครบแล้ว — ไม่มีใบใหม่ที่ต้องออก',
      );
      router.refresh();
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button label="ออกบิลรอบนี้" isLoading={pending} onClick={run} />
      </div>
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}
    </div>
  );
}
