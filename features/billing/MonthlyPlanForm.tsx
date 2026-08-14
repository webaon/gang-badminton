'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';

import { upsertMonthlyPlan } from '@/server/actions/membership';

/**
 * ค่าสมาชิกรายเดือน — **[WO-2.5-C]**
 *
 * 🔴 [ADR-006] แยกจากแผนราคาต่อนัดโดยตั้งใจ
 *    ก๊วนหนึ่งมีได้ทั้งสองอย่าง: คนทั่วไปจ่ายต่อนัด · สมาชิกรายเดือนจ่ายเป็นเดือน
 *    แล้วค่าสนามของสมาชิกรายเดือนเป็น 0 ตอนปิดรอบ (ADR-005)
 */
export function MonthlyPlanForm({
  gangId,
  plan,
}: {
  gangId: string;
  plan: { id: string; monthlyFee: string } | null;
}) {
  const router = useRouter();
  const [fee, setFee] = useState(plan?.monthlyFee ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    const result = await upsertMonthlyPlan(gangId, fee, plan?.id);

    if (result.success) {
      setSaved(true);
      router.refresh();
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <h2 className="mb-2 text-base font-semibold">ค่าสมาชิกรายเดือน</h2>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextInput
            label="ค่าสมาชิกต่อเดือน (บาท)"
            value={fee}
            onChange={setFee}
            description="ออกบิลอัตโนมัติต้นเดือนสำหรับเดือนนั้น · สมัครกลางเดือนคิดเต็มเดือน"
          />
        </div>
        <Button type="submit" variant="primary" label="บันทึก" isLoading={pending} />
      </div>

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
      {saved ? (
        <div className="mt-3">
          <Banner
            status="success"
            title="บันทึกค่าสมาชิกรายเดือนแล้ว"
            isDismissable
            onDismiss={() => setSaved(false)}
          />
        </div>
      ) : null}
    </form>
  );
}
