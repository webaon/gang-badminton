import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';

/**
 * Foundation smoke check (WO-1.1) — ไม่ใช่หน้าจริงของแอป
 *
 * มีไว้พิสูจน์ว่า cascade layer order ถูกต้อง:
 *   1. Astryx component ต้องมี style ครบ (layer astryx-base / astryx-theme)
 *   2. Tailwind utility ที่ map ผ่าน bridge ต้อง override ได้ (layer utilities)
 * layer order ที่ผิดจะพังเงียบโดยไม่มี error — ดู `astryx docs migration`
 * หัวข้อ Cascade Layer Safety
 *
 * Phase 2 (MVP-0) จะแทนที่ไฟล์นี้ด้วยหน้าแรกจริง (BACKLOG.md)
 */
export default function FoundationCheck() {
  return (
    <VStack gap={4} padding={6}>
      <Heading level={1}>Gang Badminton</Heading>
      <Text>Foundation check — Astryx × Tailwind v4 wiring ทำงานถูกต้อง</Text>

      <Card maxWidth={640} padding={4}>
        <VStack gap={3}>
          <Text>การ์ดนี้มาจาก Astryx (layer astryx-base)</Text>

          {/*
            กล่องเดียวในโปรเจกต์ที่ตั้งใจใช้ Tailwind utility ล้วน — เป็นหลักฐานว่า
            bridge ทำงาน: bg-surface → var(--color-background-surface),
            border-border → var(--color-border), rounded-lg → var(--radius-container)
          */}
          <div className="rounded-lg border border-border bg-surface p-4">
            <Text>กล่องนี้ใช้ Tailwind utility ที่ค่าสีมาจาก Astryx token</Text>
          </div>

          <Button label="ปุ่ม Astryx" variant="primary" />
        </VStack>
      </Card>
    </VStack>
  );
}
