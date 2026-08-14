'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';

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

export function SessionActions({
  sessionId,
  gangId,
  status,
  midwayCancelRatioDefault,
}: {
  sessionId: string;
  gangId: string;
  status: string;
  /** [ADR-004] ค่าตั้งต้นของก๊วนที่แช่แข็งไว้ใน snapshot ของนัดนี้ */
  midwayCancelRatioDefault: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** เปิดช่องกรอกสัดส่วนตอนยกเลิกกลางคัน — null = ยังไม่ได้กด */
  const [midwayPercent, setMidwayPercent] = useState<string | null>(null);

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
        {/*
          🔴 [WO-2.5-A] ปุ่มนี้ **ไม่ปิดรอบทันที** — พาไปหน้าสรุปยอดก่อน
             ปิดรอบคือจุดที่เงินถูก commit แล้วแก้ไม่ได้ (ADR-001)
             การกดครั้งเดียวจากหน้ารายการนัดแล้วเก็บเงินเลย คือทางที่ผิดพลาดแล้วกู้ไม่ได้
        */}
        {CLOSABLE.includes(status) ? (
          <Button
            size="sm"
            variant="primary"
            label="ปิดรอบ เก็บเงิน"
            isDisabled={pending}
            onClick={() => router.push(`/gangs/${gangId}/sessions/${sessionId}/close`)}
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

        {status === 'in_play' && midwayPercent === null ? (
          <Button
            size="sm"
            variant="destructive"
            label="ยกเลิกกลางคัน"
            isDisabled={pending}
            onClick={() =>
              setMidwayPercent(String(Math.round(midwayCancelRatioDefault * 100)))
            }
          />
        ) : null}
      </div>

      {/*
        [ADR-004] แอดมินยืนยันสัดส่วนก่อนยกเลิกจริง
        เติมค่าตั้งต้นของก๊วนให้ แต่แก้ได้ — สถานการณ์จริงต่างกันทุกครั้ง
        (เล่นไป 10 นาทีกับเล่นไปเกือบจบ ไม่ควรเก็บเท่ากัน)
      */}
      {midwayPercent !== null ? (
        <div className="mt-3 rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">ยกเลิกกลางคัน — เก็บเงินกี่ %</p>
          <div className="flex items-end gap-2">
            <div className="w-28">
              <TextInput
                label="เปอร์เซ็นต์"
                size="sm"
                value={midwayPercent}
                onChange={setMidwayPercent}
              />
            </div>
            <Button
              size="sm"
              variant="destructive"
              label="ยืนยันยกเลิก"
              isDisabled={pending}
              onClick={() => {
                const percent = Number(midwayPercent);
                if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
                  setError('เปอร์เซ็นต์ต้องอยู่ระหว่าง 0 ถึง 100');
                  return;
                }
                close('cancelled', percent / 100).then(() => setMidwayPercent(null));
              }}
            />
            <Button size="sm" label="ยกเลิก" onClick={() => setMidwayPercent(null)} />
          </div>
        </div>
      ) : null}

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
