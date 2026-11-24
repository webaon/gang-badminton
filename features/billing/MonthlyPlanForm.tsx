'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
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
  const submitRef = useRef(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitRef.current) return;
    submitRef.current = true;
    setPending(true);
    setError(null);
    setSaved(false);

    try {
      const result = await upsertMonthlyPlan(gangId, fee, plan?.id);
      if (result.success) {
        setSaved(true);
        router.refresh();
      } else {
        setError(actionError(result.error));
      }
    } catch {
      setError(actionError({ code: 'INTERNAL_ERROR' }));
    } finally {
      submitRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby="monthly-settings-title">
    <VStack as="section" id="monthly-settings" gap={3} className="scroll-mt-24" aria-labelledby="monthly-settings-title">
      <h2 id="monthly-settings-title" className="text-lg font-semibold">ค่าสมาชิกรายเดือน</h2>
      <Text as="p" color="secondary" size="sm">แผนรายเดือนแยกจากแผนราคาต่อนัด</Text>
      <Card padding={5}>
          <VStack gap={4}>
            <TextInput
              size="lg"
              label="ค่าสมาชิกต่อเดือน (บาท)"
              value={fee}
              onChange={setFee}
              description="ออกบิลอัตโนมัติต้นเดือนสำหรับเดือนนั้น · สมัครกลางเดือนคิดเต็มเดือน"
            />
            {error ? <Banner status="error" title={error} /> : null}
            {saved ? (
              <Banner
                status="success"
                title="บันทึกค่าสมาชิกรายเดือนแล้ว"
                isDismissable
                onDismiss={() => setSaved(false)}
              />
            ) : null}
            <Button type="submit" variant="secondary" label="บันทึก" isLoading={pending} className="min-h-11 w-full sm:w-auto sm:self-start">
              <Text color="primary">บันทึก</Text>
            </Button>
          </VStack>
      </Card>
    </VStack>
    </form>
  );
}
