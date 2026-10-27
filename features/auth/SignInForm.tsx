'use client';

import { errorText } from '@/lib/i18n/error-text';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { signInWithMagicLink, signInWithPassword, startLineSignIn } from '@/server/actions/auth';

/**
 * ⚠️ Astryx `TextInput` **ไม่มี prop `autoComplete`** และไม่มีช่องส่ง attribute ดิบ
 *    ⇒ ใช้ `htmlName` ให้เบราว์เซอร์เดาเอาแทน ซึ่งอ่อนกว่า `autocomplete` จริง
 *    (password manager บางตัวจะไม่เติมรหัสให้อัตโนมัติ) — จดไว้ใน BACKLOG แล้ว
 *
 * ⚠️ ข้อความ error ผ่าน `errorText()` (code → ไทย) [WO-6.1b] — ไม่อ่าน `message` ของ server ตรงๆ
 *
 * **[WO-B1.a · ADR-013]** `lineEnabled` = flag ฝั่ง server (ส่งมาจาก page) · `initialError` = ข้อความตายตัวที่ page แปลงจาก `?error=` แล้ว
 * 🔴 ปุ่ม LINE ต้องเป็น `onClick → window.location.href` เท่านั้น ห้ามทำเป็น `<form action>`
 *    (CSP `form-action 'self'` — ดู ADR-013 §6.1)
 */
export function SignInForm({
  next,
  initialError,
  lineEnabled = false,
}: {
  next?: string;
  initialError?: string;
  lineEnabled?: boolean;
}) {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onLineSignIn() {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await startLineSignIn(next);

    if (result.success) {
      // ไม่ปลด pending — กำลังพาออกไปหน้า LINE
      window.location.href = result.data.url;
    } else {
      setError(errorText(result.error));
      setPending(false);
    }
  }

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
      // `UNAUTHENTICATED` ที่นี่แปลว่า "อีเมลหรือรหัสผ่านไม่ถูกต้อง" (server/actions/auth.ts ใช้ code นี้กับการล็อกอินพลาด)
      // ไม่ใช่เซสชันหมดอายุ ⇒ ใช้ `errorText` ล้วน (ไม่ redirect ไป /session-expired) และบอกตามบริบทของฟอร์ม
      setError(
        result.error.code === 'UNAUTHENTICATED'
          ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
          : errorText(result.error),
      );
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
      setError(errorText(result.error));
    }
    setPending(false);
  }

  return (
    <>
      {lineEnabled ? (
        <div className="mb-4">
          <Button
            type="button"
            variant="primary"
            label="เข้าสู่ระบบด้วย LINE"
            onClick={onLineSignIn}
            isLoading={pending}
          />
          <p className="mt-3 text-center text-sm">หรือเข้าสู่ระบบด้วยอีเมล</p>
        </div>
      ) : null}
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
    </>
  );
}
