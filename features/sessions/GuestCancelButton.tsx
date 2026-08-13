'use client';

import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { cancelAsGuest } from '@/server/actions/guest';

export function GuestCancelButton({
  registrationId,
  guestToken,
}: {
  registrationId: string;
  guestToken: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [pending, setPending] = useState(false);

  async function onCancel() {
    setPending(true);
    setError(null);

    const result = await cancelAsGuest(registrationId, guestToken);

    if (result.success) setCancelled(true);
    else setError(result.error.message);

    setPending(false);
  }

  if (cancelled) {
    return <Banner status="info" title="ยกเลิกเรียบร้อยแล้ว" />;
  }

  return (
    <div>
      <Button variant="destructive" label="ยกเลิกการลงชื่อ" isLoading={pending} onClick={onCancel} />
      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
    </div>
  );
}
