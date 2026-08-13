'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { createGang } from '@/server/actions/gangs';

export function CreateGangForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await createGang({ name, area: area || undefined });

    if (result.success) {
      router.push(`/gangs/${result.data.gangId}/settings`);
      router.refresh();
    } else {
      setError(result.error.message);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormLayout direction="vertical">
        <TextInput label="ชื่อก๊วน" value={name} onChange={setName} isRequired />
        <TextInput
          label="พื้นที่"
          value={area}
          onChange={setArea}
          isOptional
          description="เช่น ลาดพร้าว กรุงเทพฯ"
        />
      </FormLayout>

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}

      <div className="mt-4">
        <Button type="submit" variant="primary" label="สร้างก๊วน" isLoading={pending} />
      </div>
    </form>
  );
}
