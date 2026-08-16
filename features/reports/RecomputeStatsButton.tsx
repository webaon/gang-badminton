'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { recomputeGangStatistics } from '@/server/actions/reports';

/**
 * ปุ่มคำนวณสถิติใหม่ — **[WO-3.A]**
 *
 * ⚠️ ระบบคำนวณให้เองทุกคืนอยู่แล้ว ปุ่มนี้ไว้ดูผลทันทีหลังปิดรอบ
 */
export function RecomputeStatsButton({ gangId }: { gangId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await recomputeGangStatistics(gangId);

    if (result.success) {
      setNotice(`คำนวณสถิติของสมาชิก ${result.data.members} คนแล้ว`);
      router.refresh();
    } else {
      setError(result.error.message);
    }

    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button label="คำนวณสถิติใหม่" isLoading={pending} onClick={run} />
      </div>
      <p className="text-sm opacity-70">ระบบคำนวณให้อัตโนมัติทุกคืน — กดเองได้ถ้าอยากเห็นเลขทันที</p>
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}
    </div>
  );
}
