'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { cancelRegistration, registerSelf } from '@/server/actions/registrations';
import { createInviteLink } from '@/server/actions/registrations';

export function RegistrationActions({
  sessionId,
  myRegistrationId,
  canRegister,
  canInvite,
}: {
  sessionId: string;
  myRegistrationId: string | null;
  canRegister: boolean;
  canInvite: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onRegister() {
    setPending(true);
    setError(null);
    const result = await registerSelf(sessionId);
    if (result.success) router.refresh();
    else setError(result.error.message);
    setPending(false);
  }

  async function onCancel() {
    if (!myRegistrationId) return;
    setPending(true);
    setError(null);
    const result = await cancelRegistration(myRegistrationId);
    if (result.success) router.refresh();
    else setError(result.error.message);
    setPending(false);
  }

  async function onCreateInvite() {
    setPending(true);
    setError(null);
    const result = await createInviteLink(sessionId);
    if (result.success) {
      // 🔴 token โผล่ครั้งเดียว — ระบบเก็บแค่ hash หลังจากนี้อ่านย้อนหลังไม่ได้
      setInviteUrl(`${window.location.origin}/join/${result.data.token}`);
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {myRegistrationId ? (
          <Button label="ยกเลิกการลงชื่อ" isDisabled={pending} onClick={onCancel} />
        ) : canRegister ? (
          <Button variant="primary" label="ลงชื่อเข้านัด" isDisabled={pending} onClick={onRegister} />
        ) : null}

        {canInvite ? (
          <Button label="สร้างลิงก์เชิญ" isDisabled={pending} onClick={onCreateInvite} />
        ) : null}
      </div>

      {inviteUrl ? (
        <Banner
          status="warning"
          title="คัดลอกลิงก์เก็บไว้ตอนนี้"
          description="ลิงก์นี้แสดงครั้งเดียว ระบบไม่เก็บไว้ให้ดูย้อนหลัง"
        >
          <code className="block break-all p-2 text-xs">{inviteUrl}</code>
        </Banner>
      ) : null}

      {error ? <Banner status="error" title={error} /> : null}
    </div>
  );
}
