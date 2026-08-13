'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { transitionSession } from '@/server/actions/sessions';
import { closeSessionWithBilling } from '@/server/actions/billing';

/**
 * ปุ่มเปลี่ยนสถานะนัด
 *
 * 🔴 ทุกปุ่มเรียก `transition_session()` ผ่าน server action — ไม่มีทางลัด UPDATE ตรง
 *    UI แสดงเฉพาะปลายทางที่ state machine อนุญาตจากสถานะปัจจุบัน เพื่อไม่ให้กดแล้วเจอ error
 */
/**
 * ปลายทางที่เปลี่ยนได้ด้วย `transition_session()` ตรงๆ (ยังไม่มีเงินเข้ามาเกี่ยว)
 *
 * 🔴 `→ billing` และ `in_play → cancelled` **ไม่อยู่ในนี้** เพราะสองเส้นนั้นต้อง
 *    สร้าง charges พร้อมเปลี่ยนสถานะแบบ atomic ผ่าน `close_session_with_charges()`
 *    (ADR-001) — ใช้ปุ่มแยกด้านล่าง
 */
const NEXT_STEPS: Record<string, Array<{ to: string; label: string; variant?: 'primary' }>> = {
  draft: [{ to: 'open', label: 'เปิดรับสมัคร', variant: 'primary' }],
  open: [{ to: 'in_play', label: 'เริ่มเล่น', variant: 'primary' }],
  billing: [{ to: 'settled', label: 'เก็บเงินครบแล้ว', variant: 'primary' }],
  settled: [{ to: 'archived', label: 'เก็บเข้าคลัง' }],
};

/** ปิดรอบเก็บเงินได้จากสถานะไหนบ้าง (baseline: open/in_play → billing) */
const CLOSABLE = ['open', 'in_play'];

/** ยกเลิกโดยไม่มีเงินเข้ามาเกี่ยว — ยังไม่เริ่มเล่น */
const PLAIN_CANCELLABLE = ['draft', 'open'];

export function SessionActions({ sessionId, status }: { sessionId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function go(to: string) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await transitionSession(
      sessionId,
      to as Parameters<typeof transitionSession>[1],
    );

    if (result.success) router.refresh();
    else setError(result.error.message);

    setPending(false);
  }

  /**
   * ปิดรอบ / ยกเลิกกลางคัน — ต้องผ่าน billing เพราะสร้าง charges พร้อมเปลี่ยน
   * สถานะแบบ atomic (ADR-001) ไม่ใช่ transition เปล่าๆ
   */
  async function close(toStatus: 'billing' | 'cancelled', midwayCancelRatio?: number) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await closeSessionWithBilling(sessionId, { toStatus, midwayCancelRatio });

    if (result.success) {
      setNotice(`สร้างยอดเรียกเก็บ ${result.data.chargeCount} รายการ รวม ${result.data.total} บาท`);
      router.refresh();
    } else {
      setError(result.error.message);
    }

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
        {CLOSABLE.includes(status) ? (
          <Button
            size="sm"
            variant="primary"
            label="ปิดรอบ เก็บเงิน"
            isDisabled={pending}
            onClick={() => close('billing')}
          />
        ) : null}

        {PLAIN_CANCELLABLE.includes(status) ? (
          <Button
            size="sm"
            variant="destructive"
            label="ยกเลิกนัด"
            isDisabled={pending}
            onClick={() => go('cancelled')}
          />
        ) : null}

        {status === 'in_play' ? (
          // ยกเลิกกลางคัน: เก็บครึ่งเดียวเป็นค่าเริ่มต้น (ก๊วนจ่ายค่าคอร์ทไปแล้วบางส่วน)
          // ⚠️ สัดส่วนนี้ยังไม่มีที่เก็บใน policy — ดู session-billing.ts
          <Button
            size="sm"
            variant="destructive"
            label="ยกเลิกกลางคัน (เก็บครึ่ง)"
            isDisabled={pending}
            onClick={() => close('cancelled', 0.5)}
          />
        ) : null}
      </div>

      {error ? (
        <div className="mt-2">
          <Banner status="error" title={error} />
        </div>
      ) : null}
      {notice ? (
        <div className="mt-2">
          <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
        </div>
      ) : null}
    </div>
  );
}
