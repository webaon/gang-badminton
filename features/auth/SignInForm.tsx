'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { signInWithMagicLink, signInWithPassword } from '@/server/actions/auth';

/**
 * ⚠️ Astryx `TextInput` **ไม่มี prop `autoComplete`** และไม่มีช่องส่ง attribute ดิบ
 *    ⇒ ใช้ `htmlName` ให้เบราว์เซอร์เดาเอาแทน ซึ่งอ่อนกว่า `autocomplete` จริง
 *    (password manager บางตัวจะไม่เติมรหัสให้อัตโนมัติ) — จดไว้ใน BACKLOG แล้ว
 *
 * ⚠️ ข้อความ error ที่โชว์มาจาก `message` ของ response contract
 *    ซึ่ง server เป็นคนตัดสินว่าจะบอกอะไร — หน้าจอไม่ตีความ `code` เอง
 *    (Phase 2 ค่อยทำ mapping code → ข้อความไทยรวมศูนย์ตาม CLAUDE.md §4)
 */
export function SignInForm({ next }: { next?: string }) {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onPasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await signInWithPassword(email, password);

    if (result.success) {
      router.replace(next ?? '/profile');
      router.refresh();
    } else {
      setError(result.error.message);
      setPending(false);
    }
  }

  async function onMagicLink() {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await signInWithMagicLink(email, next);

    if (result.success) {
      setNotice('ส่งลิงก์เข้าสู่ระบบไปที่อีเมลแล้ว — เปิดลิงก์ในอีเมลเพื่อเข้าใช้งาน');
    } else {
      setError(result.error.message);
    }
    setPending(false);
  }

  return (
    <form onSubmit={onPasswordSubmit} noValidate>
      <FormLayout direction="vertical">
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
          description="ถ้ายังไม่มีรหัสผ่าน ใช้ปุ่มส่งลิงก์เข้าอีเมลแทนได้"
          htmlName="current-password"
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

      <div className="mt-4 flex flex-col gap-2">
        <Button type="submit" variant="primary" label="เข้าสู่ระบบ" isLoading={pending} />
        <Button
          type="button"
          variant="ghost"
          label="ส่งลิงก์เข้าอีเมลแทน"
          onClick={onMagicLink}
          isDisabled={pending || email.trim() === ''}
        />
      </div>
    </form>
  );
}
