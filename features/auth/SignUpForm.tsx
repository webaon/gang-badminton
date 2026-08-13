'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { signUpWithPassword } from '@/server/actions/auth';

export function SignUpForm() {
  const router = useRouter();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    // ชื่อนี้ถูกส่งไปเป็น user metadata แล้ว trigger handle_new_user() เอาไปใส่
    // ใน profiles.display_name ให้อัตโนมัติ (migration 0014)
    const result = await signUpWithPassword(email, password, displayName);

    if (!result.success) {
      setError(result.error.message);
      setPending(false);
      return;
    }

    if (result.data.needsEmailConfirmation) {
      setNotice('สมัครเรียบร้อย — เปิดอีเมลเพื่อยืนยันบัญชีก่อนเข้าใช้งาน');
      setPending(false);
      return;
    }

    router.replace('/profile');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormLayout direction="vertical">
        <TextInput
          label="ชื่อที่ใช้แสดง"
          value={displayName}
          onChange={setDisplayName}
          description="ชื่อที่เพื่อนในก๊วนจะเห็น"
          isRequired
        />
        <TextInput
          type="email"
          label="อีเมล"
          value={email}
          onChange={setEmail}
          isRequired
          htmlName="email"
        />
        <TextInput
          type="password"
          label="รหัสผ่าน"
          value={password}
          onChange={setPassword}
          isRequired
          htmlName="new-password"
        />
      </FormLayout>

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
      {notice ? (
        <div className="mt-3">
          <Banner status="success" title={notice} />
        </div>
      ) : null}

      <div className="mt-4">
        <Button type="submit" variant="primary" label="สมัครสมาชิก" isLoading={pending} />
      </div>
    </form>
  );
}
