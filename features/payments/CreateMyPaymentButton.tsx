'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { createMyPayment } from '@/server/actions/payments';

export function CreateMyPaymentButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div>
      <Button
        variant="primary"
        label="ขอ QR จ่ายเงิน"
        isLoading={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await createMyPayment(sessionId);
          if (result.success) router.refresh();
          else setError(result.error.message);
          setPending(false);
        }}
      />
      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
    </div>
  );
}
