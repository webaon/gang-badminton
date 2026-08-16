import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { HStack } from '@astryxdesign/core/Stack';
import { VStack } from '@astryxdesign/core/VStack';

import { platformHighlights } from '@/server/landing/metrics';
import { hasHighlights } from '@/domain/reports/platform';

/**
 * หน้าแรก — **[WO-3.F]**
 *
 * 🔴 **static/ISR ห้ามเป็น `force-dynamic`** (DoD ของใบนี้ — ตรวจได้จากผลลัพธ์ `npm run build`)
 *    ⇒ ห้ามเรียก `cookies()` / `headers()` / `supabaseServer()` ในไฟล์นี้เด็ดขาด
 *      แตะอย่างใดอย่างหนึ่งเมื่อไหร่ Next จะสลับหน้านี้เป็น dynamic ให้เงียบๆ
 *
 * 🔴 ตัวเลขมาจาก `daily_metrics` (rollup) เท่านั้น — ไม่ query ตารางธุรกรรมสด
 *    และ **ไม่มีข้อมูลของก๊วนใดก๊วนหนึ่งบนหน้านี้เลย** (ไม่มีชื่อก๊วน ไม่มีรายชื่อคน)
 *    คนที่อยากเห็นก๊วนต้องไปหน้า `/discover` ซึ่งกรอง `is_public` + `features.discovery` ให้แล้ว
 */
export const revalidate = 3600;

export const metadata = {
  title: 'Gang Badminton — จัดก๊วนแบดให้จบในที่เดียว',
  description:
    'เปิดนัด ลงชื่อ คิวรอ เช็คอิน จัดคู่ และเก็บเงินค่าสนาม/ค่าลูก ครบในระบบเดียว',
};

const FEATURES = [
  {
    title: 'เปิดนัด · ลงชื่อ · คิวรอ',
    detail: 'ที่นั่งเต็มแล้วเข้าคิวรออัตโนมัติ มีคนยกเลิกก็เลื่อนคิวให้เอง ไม่ต้องนั่งนับในกลุ่มไลน์',
  },
  {
    title: 'คอนโซลวันเล่น',
    detail: 'เช็คอินด้วย QR · กระดานคิวสด · จัดคู่ให้อัตโนมัติแล้วลากสลับได้ · นับลูกต่อเกม',
  },
  {
    title: 'เก็บเงินไม่ตกหล่น',
    detail: 'ปิดรอบแล้วคิดค่าสนาม/ค่าลูกให้ทีละคน ออก PromptPay QR ต่อคน แนบสลิป แล้วกดยืนยัน',
  },
  {
    title: 'รายงานที่ตรวจย้อนได้',
    detail: 'รายรับ-รายจ่าย-กำไรของก๊วน สถิติรายคน และไทม์ไลน์ว่าเกิดอะไรขึ้นในแต่ละนัด',
  },
];

export default async function LandingPage() {
  const highlights = await platformHighlights();
  const showNumbers = highlights !== null && hasHighlights(highlights);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <VStack gap={6}>
        <VStack gap={3}>
          <Heading level={1}>Gang Badminton</Heading>
          <Text>
            จัดก๊วนแบดให้จบในที่เดียว — เปิดนัด ลงชื่อ คิวรอ เช็คอิน จัดคู่ แล้วเก็บเงินตามจริง
          </Text>

          <HStack gap={4} wrap="wrap">
            <Link href="/discover" isStandalone hasUnderline>
              ค้นหาก๊วนใกล้ตัว
            </Link>
            <Link href="/sign-up" isStandalone hasUnderline>
              สมัครใช้งาน
            </Link>
            <Link href="/sign-in" isStandalone hasUnderline>
              เข้าสู่ระบบ
            </Link>
          </HStack>
        </VStack>

        {showNumbers ? (
          <Card padding={4} variant="muted">
            <VStack gap={2}>
              <Text>30 วันที่ผ่านมาบนระบบ</Text>

              <HStack gap={6} wrap="wrap">
                <Stat label="นัดที่จัด" value={highlights.sessionsHeld} />
                <Stat label="เกมที่ลง" value={highlights.gamesPlayed} />
                <Stat label="สมาชิกใหม่" value={highlights.newMembers} />
              </HStack>

              {/*
                บอกวันล่าสุดที่มีข้อมูลเสมอ — rollup รันรายคืน ตัวเลขจึงตามหลังของจริงได้
                ถ้าไม่บอก คนอ่านจะเข้าใจว่าเป็นตัวเลข ณ วินาทีนี้
              */}
              <Text>ข้อมูลถึงวันที่ {highlights.latestDate} (สรุปรายคืน)</Text>
            </VStack>
          </Card>
        ) : null}

        <VStack gap={3}>
          <Heading level={2}>ระบบทำอะไรให้บ้าง</Heading>

          <div className="grid gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <Card key={feature.title} padding={4}>
                <VStack gap={1}>
                  <Text weight="bold">{feature.title}</Text>
                  <Text>{feature.detail}</Text>
                </VStack>
              </Card>
            ))}
          </div>
        </VStack>

        <Card padding={4}>
          <VStack gap={2}>
            <Text weight="bold">ยังไม่มีก๊วน?</Text>
            <Text>
              สมัครแล้วสร้างก๊วนของตัวเองได้เลย หรือค้นหาก๊วนที่เปิดรับสมาชิกแล้วส่งคำขอเข้าร่วม
            </Text>
            <HStack gap={4} wrap="wrap">
              <Link href="/gangs" isStandalone hasUnderline>
                สร้างก๊วนของฉัน
              </Link>
              <Link href="/discover" isStandalone hasUnderline>
                ดูก๊วนที่เปิดรับ
              </Link>
            </HStack>
          </VStack>
        </Card>
      </VStack>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <VStack gap={0.5}>
      <Heading level={3}>{value.toLocaleString('th-TH')}</Heading>
      <Text>{label}</Text>
    </VStack>
  );
}
