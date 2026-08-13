'use client';

import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { updateOwnProfile } from '@/server/actions/profile';

export type ProfileFormProps = {
  initialDisplayName: string;
  initialPhone: string | null;
  email: string;
};

export function ProfileForm({ initialDisplayName, initialPhone, email }: ProfileFormProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    // action อ่าน user จาก session เอง — ไม่มีการส่ง id จากฝั่ง client
    const result = await updateOwnProfile({ displayName, phone: phone || null });

    if (result.success) {
      setSaved(true);
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormLayout direction="vertical">
        <TextInput label="อีเมล" value={email} onChange={() => {}} isDisabled />
        <TextInput
          label="ชื่อที่ใช้แสดง"
          value={displayName}
          onChange={setDisplayName}
          isRequired
        />
        <TextInput
          label="เบอร์โทร"
          value={phone}
          onChange={setPhone}
          description="ไม่บังคับ — ใช้ให้แอดมินก๊วนติดต่อได้"
        />
      </FormLayout>

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
      {saved ? (
        <div className="mt-3">
          <Banner status="success" title="บันทึกแล้ว" isDismissable onDismiss={() => setSaved(false)} />
        </div>
      ) : null}

      <div className="mt-4">
        <Button type="submit" variant="primary" label="บันทึก" isLoading={pending} />
      </div>
    </form>
  );
}
