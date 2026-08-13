'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { transitionSession } from '@/server/actions/sessions';

/**
 * ปุ่มเปลี่ยนสถานะนัด
 *
 * 🔴 ทุกปุ่มเรียก `transition_session()` ผ่าน server action — ไม่มีทางลัด UPDATE ตรง
 *    UI แสดงเฉพาะปลายทางที่ state machine อนุญาตจากสถานะปัจจุบัน เพื่อไม่ให้กดแล้วเจอ error
 */
const NEXT_STEPS: Record<string, Array<{ to: string; label: string; variant?: 'primary' }>> = {
  draft: [{ to: 'open', label: 'เปิดรับสมัคร', variant: 'primary' }],
  open: [
    { to: 'in_play', label: 'เริ่มเล่น', variant: 'primary' },
    { to: 'billing', label: 'ข้ามไปเก็บเงิน' },
  ],
  in_play: [{ to: 'billing', label: 'ปิดรอบ เก็บเงิน', variant: 'primary' }],
  billing: [{ to: 'settled', label: 'เก็บเงินครบแล้ว', variant: 'primary' }],
  settled: [{ to: 'archived', label: 'เก็บเข้าคลัง' }],
};

const CANCELLABLE = ['draft', 'open', 'in_play'];

export function SessionActions({ sessionId, status }: { sessionId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function go(to: string) {
    setPending(true);
    setError(null);

    const result = await transitionSession(
      sessionId,
      to as Parameters<typeof transitionSession>[1],
    );

    if (result.success) router.refresh();
    else setError(result.error.message);

    setPending(false);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {(NEXT_STEPS[status] ?? []).map((step) => (
          <Button
            key={step.to}
            size="sm"
            variant={step.variant ?? 'secondary'}
            label={step.label}
            isDisabled={pending}
            onClick={() => go(step.to)}
          />
        ))}
        {CANCELLABLE.includes(status) ? (
          <Button
            size="sm"
            variant="destructive"
            label="ยกเลิกนัด"
            isDisabled={pending}
            onClick={() => go('cancelled')}
          />
        ) : null}
      </div>

      {error ? (
        <div className="mt-2">
          <Banner status="error" title={error} />
        </div>
      ) : null}
    </div>
  );
}
