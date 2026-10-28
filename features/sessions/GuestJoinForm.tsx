'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';

import { actionError } from '@/lib/i18n/error-text';
import { registerAsGuest } from '@/server/actions/guest';

/**
 * ฟอร์มลงชื่อ guest จากลิงก์เชิญ (hi-fi 21 → 22) — [WO-6.2]
 *
 * ต้นเหตุ guest "Ford" ซ้ำหลายแถว: สมาชิกที่ล็อกอินอยู่เปิดลิงก์ guest แล้วลงชื่อ "ตัวเอง" (หรือลงซ้ำ)
 *   · ล็อกอินอยู่ (`signedInAs`) ⇒ เตือนชัด + ต้องติ๊กยืนยันว่าลงชื่อให้ "คนอื่น" ก่อนปุ่มส่งจะเปิด
 *   · กันกดซ้ำ: ref กันส่งซ้อนก่อน state อัปเดต + ปุ่ม loading + หลังสำเร็จซ่อนฟอร์ม
 *
 * 🔴 ไม่ตรวจชื่อซ้ำกับคนที่ลงแล้วที่นี่ — หน้า join จงใจไม่ให้เห็นรายชื่อผู้เล่น (กันรั่ว)
 *    ป้าย "ชื่อซ้ำ" แสดงในรายชื่อหน้านัดให้สมาชิกเห็นแทน
 */
export function GuestJoinForm({
  inviteToken,
  signedInAs,
}: {
  inviteToken: string;
  /** อีเมลของสมาชิกที่ล็อกอินอยู่ขณะเปิดลิงก์ (ถ้ามี) */
  signedInAs?: string | null;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [forOther, setForOther] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ status: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);

  const needsConfirm = Boolean(signedInAs);
  const canSubmit = name.trim() !== '' && (!needsConfirm || forOther);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !canSubmit) return;
    inFlight.current = true;
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
      // ไม่ปล่อย inFlight — ฟอร์มถูกซ่อนแล้ว ส่งซ้ำไม่ได้
    } else {
      setError(actionError(response.error));
      inFlight.current = false;
    }
    setPending(false);
  }

  async function onCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (result) {
    return (
      <VStack gap={3}>
        <Banner
          status={result.status === 'confirmed' ? 'success' : 'info'}
          title={result.status === 'confirmed' ? 'ลงชื่อเรียบร้อย — ได้ที่แล้ว' : 'ลงชื่อแล้ว — อยู่ในคิวรอ'}
          description="เก็บลิงก์ด้านล่างไว้ใช้ดูสถานะหรือยกเลิก — ลิงก์นี้แสดงครั้งเดียว ไม่ต้องสมัครสมาชิก"
          defaultIsExpanded
        >
          <VStack gap={2}>
            <Text type="code" wordBreak="break-all">
              {result.url}
            </Text>
            <Button label={copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'} size="sm" onClick={onCopy} />
          </VStack>
        </Banner>
      </VStack>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <VStack gap={4}>
        {needsConfirm ? (
          <Banner
            status="warning"
            title="คุณล็อกอินอยู่ในบัญชีสมาชิก"
            description={`บัญชี ${signedInAs} — ถ้าจะลงชื่อให้ตัวเอง ให้ลงจากหน้านัดในแอป ฟอร์มนี้สำหรับเพื่อนที่ไม่ได้เป็นสมาชิกเท่านั้น`}
          />
        ) : null}

        <FormLayout direction="vertical">
          <TextInput label="ชื่อที่ให้เรียก" value={name} onChange={setName} isRequired />
          <TextInput
            label="เบอร์โทร"
            value={phone}
            onChange={setPhone}
            isOptional
            description="ให้แอดมินติดต่อได้ถ้ามีการเปลี่ยนแปลง"
          />
        </FormLayout>

        {needsConfirm ? (
          <CheckboxInput
            label="ฉันกำลังลงชื่อให้คนอื่น (ไม่ใช่ตัวฉันเอง)"
            value={forOther}
            onChange={setForOther}
          />
        ) : null}

        {error ? <Banner status="error" title={error} /> : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          width="100%"
          label="ลงชื่อเข้านัด"
          isLoading={pending}
          isDisabled={!canSubmit}
        />
      </VStack>
    </form>
  );
}
