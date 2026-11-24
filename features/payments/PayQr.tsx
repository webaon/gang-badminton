'use client';

import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * QR PromptPay + คัดลอกเลข + บันทึกรูป (hi-fi 30) — **[WO-6.3]**
 *
 * 🔴 รับ `qr` (data URL) / ยอด / เลข PromptPay ที่ server ประกอบมาให้แล้วเท่านั้น — ไม่คิดเงินที่นี่
 *    QR เป็นแบบสถิต (ไม่มีวันหมดอายุ) จึงไม่โชว์ตัวนับเวลา · ไม่มีชื่อบัญชีผู้รับในสกีมา จึงโชว์แค่ชื่อก๊วน + เลข
 * client component เพราะใช้ clipboard / download (function ส่งจาก server ไม่ได้ แต่ props ที่รับเป็น string ล้วน)
 */
export function PayQr({
  qr,
  amountText,
  promptPayId,
  gangName,
}: {
  qr: string;
  amountText: string;
  promptPayId: string;
  gangName: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copyId() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(promptPayId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  function saveImage() {
    const link = document.createElement('a');
    link.href = qr;
    link.download = 'promptpay-qr.png';
    link.click();
  }

  return (
    <Card padding={5} variant="blue">
      <VStack gap={3} align="center">
        <Badge label="PromptPay" />
        <Text type="supporting" size="sm">
          ยอดที่ต้องโอน
        </Text>
        <Heading level={1}>{amountText}</Heading>

        {/* QR ต้องเป็นดำบนขาวเสมอ (สแกนได้) — รูปที่ lib สร้างเองมีพื้นขาว ไม่ขึ้นกับธีม */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="PromptPay QR" className="mx-auto w-56 rounded-lg" />

        <VStack gap={1} align="center">
          <Text weight="semibold">{gangName}</Text>
          <Text type="supporting" hasTabularNumbers>
            {promptPayId}
          </Text>
        </VStack>

        <HStack gap={2} wrap="wrap" justify="center">
          <Button variant="secondary" label="บันทึกรูป QR" onClick={saveImage} />
          <Button variant="secondary" label={copied ? 'คัดลอกแล้ว' : 'คัดลอกเลขพร้อมเพย์'} onClick={copyId} />
        </HStack>

        {copyFailed ? (
          <Banner status="warning" title="คัดลอกไม่สำเร็จ" description="กดค้างที่เลขด้านบนเพื่อคัดลอกเอง" />
        ) : null}
        <Banner status="info" title="ยอดฝังใน QR แล้ว" description="สแกนแล้วกดยืนยันได้เลย ไม่ต้องพิมพ์ตัวเลข" />
      </VStack>
    </Card>
  );
}
