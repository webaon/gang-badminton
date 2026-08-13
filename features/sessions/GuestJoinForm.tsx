'use client';

import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { registerAsGuest } from '@/server/actions/guest';

export function GuestJoinForm({ inviteToken }: { inviteToken: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ status: string; url: string } | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const response = await registerAsGuest(inviteToken, name, phone || undefined);

    if (response.success) {
      // 🔴 guest token โผล่ครั้งเดียว — ระบบเก็บแค่ hash
      //    ถ้าปิดหน้านี้ไปโดยไม่เก็บลิงก์ จะดู/ยกเลิกเองไม่ได้อีก ต้องให้แอดมินช่วย
      setResult({
        status: response.data.status,
        url: `${window.location.origin}/guest/${response.data.registrationId}?t=${response.data.guestToken}`,
      });
    } else {
      setError(response.error.message);
    }
    setPending(false);
  }

  if (result) {
    return (
      <Banner
        status={result.status === 'confirmed' ? 'success' : 'info'}
        title={result.status === 'confirmed' ? 'ลงชื่อเรียบร้อย — ได้ที่แล้ว' : 'ลงชื่อแล้ว — อยู่ในคิวรอ'}
        description="เก็บลิงก์ด้านล่างไว้สำหรับดูสถานะหรือยกเลิก — ลิงก์นี้แสดงครั้งเดียว"
        defaultIsExpanded
      >
        <code className="block break-all p-2 text-xs">{result.url}</code>
      </Banner>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormLayout direction="vertical">
        <TextInput label="ชื่อของคุณ" value={name} onChange={setName} isRequired />
        <TextInput
          label="เบอร์โทร"
          value={phone}
          onChange={setPhone}
          isOptional
          description="ให้แอดมินติดต่อได้ถ้ามีการเปลี่ยนแปลง"
        />
      </FormLayout>

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}

      <div className="mt-4">
        <Button
          type="submit"
          variant="primary"
          label="ลงชื่อเข้านัด"
          isLoading={pending}
          isDisabled={name.trim() === ''}
        />
      </div>
    </form>
  );
}
