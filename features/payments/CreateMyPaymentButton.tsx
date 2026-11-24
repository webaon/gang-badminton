'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@astryxdesign/core/Button';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { StatePanel } from '@/components/ui/StatePanel';
import { actionError } from '@/lib/i18n/error-text';
import { createMyPayment } from '@/server/actions/payments';

/**
 * ขอ QR จ่ายเงิน — **[WO-6.3]**
 *   K30a: ระหว่างสร้าง = skeleton QR + ข้อความ · K30b: ล้ม = StatePanel + ลองใหม่ (ข้อความแปลจาก error.code)
 */
export function CreateMyPaymentButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const result = await createMyPayment(sessionId);
      if (result.success) {
        router.refresh();
        return;
      }
      setError(actionError(result.error));
    } catch {
      setError(actionError({ code: 'INTERNAL_ERROR', message: '' }));
    } finally {
      setPending(false);
    }
  }

  if (pending) {
    return (
      <VStack gap={3} align="center" aria-busy="true">
        <Skeleton height={216} width={216} radius={3} />
        <Text type="supporting" size="sm">
          กำลังสร้าง QR ตามยอดของคุณ…
        </Text>
      </VStack>
    );
  }

  if (error) {
    return (
      <StatePanel
        fullPage={false}
        headingLevel={2}
        tone="error"
        title="สร้าง QR ไม่สำเร็จ"
        description={error}
        actions={[{ label: 'ลองใหม่', onClick: run }]}
      />
    );
  }

  return <Button variant="primary" size="lg" width="100%" label="ขอ QR จ่ายเงิน" onClick={run} />;
}
