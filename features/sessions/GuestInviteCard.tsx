'use client';

import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { actionError } from '@/lib/i18n/error-text';
import { createInviteLink } from '@/server/actions/registrations';

/**
 * ชวนเพื่อน (guest) — ปุ่ม **รอง** แยกจากการลงชื่อตัวเองโดยสิ้นเชิง [WO-6.2]
 *
 * guest เกิดทางเดียวคือ "คนอื่น" เปิดลิงก์นี้แล้วลงชื่อเอง (ไม่ผ่านการลงชื่อของเรา) ⇒ การ์ดนี้บอกชัดว่า
 * ลิงก์ไว้ให้คนอื่น ถ้าจะลงชื่อให้ตัวเองให้ใช้ปุ่มหลักด้านบน — ต้นเหตุ guest "Ford" ซ้ำหลายแถวคือคนเข้าใจผิดตรงนี้
 *
 * 🔴 ปุ่มนี้แสดงเฉพาะเมื่อ `can(session.invite.manage)` + flag guests ผ่าน (หน้าเป็นคนตัดสิน) — ซ่อนปุ่มไม่ใช่การตรวจสิทธิ์
 */
export function GuestInviteCard({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  async function onCreate() {
    setPending(true);
    setError(null);
    setCopied(false);
    const result = await createInviteLink(sessionId);
    if (result.success) {
      // 🔴 token โผล่ครั้งเดียว — ระบบเก็บแค่ hash หลังจากนี้อ่านย้อนหลังไม่ได้
      setInviteUrl(`${window.location.origin}/join/${result.data.token}`);
    } else {
      setError(actionError(result.error));
    }
    setPending(false);
  }

  async function onCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      // clipboard ใช้ไม่ได้ (เช่น http / ไม่อนุญาต) — ผู้ใช้เลือกข้อความในกล่องด้านบนเองได้
      setCopied(false);
    }
  }

  return (
    <Card padding={4} variant="muted">
      <VStack gap={3}>
        <Heading level={2} type="display-3">
          ชวนเพื่อนมาเล่น (guest)
        </Heading>
        <Text type="supporting">
          สร้างลิงก์ส่งให้เพื่อนที่ไม่ได้เป็นสมาชิก — เพื่อนเปิดลิงก์แล้วกรอกชื่อลงเอง
          ถ้าคุณจะลงชื่อให้ตัวเอง ให้ใช้ปุ่ม “ลงชื่อเข้านัด” ด้านบน ไม่ต้องใช้ลิงก์นี้
        </Text>

        {inviteUrl ? (
          <Banner
            status="warning"
            title="คัดลอกลิงก์เก็บไว้ตอนนี้"
            description="ลิงก์นี้แสดงครั้งเดียว ระบบไม่เก็บไว้ให้ดูย้อนหลัง"
            defaultIsExpanded
          >
            <VStack gap={2}>
              <Text type="code" wordBreak="break-all">
                {inviteUrl}
              </Text>
              <Button label={copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'} size="sm" onClick={onCopy} />
            </VStack>
          </Banner>
        ) : (
          <Button label="สร้างลิงก์เชิญ" isLoading={pending} onClick={onCreate} />
        )}

        {error ? <Banner status="error" title={error} /> : null}
      </VStack>
    </Card>
  );
}
