import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * K28a — กำลังคำนวณยอดต่อคน (skeleton) — **[WO-6.4b]**
 * route-level loading: โผล่ระหว่างที่ server ตรวจสิทธิ์ + เรียก `previewSessionCharges()`
 */
export default function CloseLoading() {
  return (
    <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4 lg:max-w-4xl" aria-busy="true">
      <VStack gap={2}>
        <Heading level={1}>ปิดรอบ</Heading>
        <Text type="supporting">กำลังคำนวณยอดต่อคน…</Text>
      </VStack>

      <Grid columns={{ minWidth: 150, repeat: 'fit' }} gap={3}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={86} radius={3} index={i} />
        ))}
      </Grid>

      <Card padding={4}>
        <VStack gap={3}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={20} index={i} />
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}
