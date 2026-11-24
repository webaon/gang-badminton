import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { payStepsOf } from '@/domain/payments/pay-view';

/** ขั้นสถานะ 3 ขั้น (hi-fi 31) จาก `payments.status` — แสดงผลล้วน */
export function PayStatusSteps({ status }: { status: string }) {
  const steps = payStepsOf(status);

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Text weight="semibold">สถานะการจ่าย</Text>
        {steps.map((step, i) => (
          <HStack key={step.label} gap={3} align="center">
            <Badge
              variant={step.state === 'done' ? 'success' : step.state === 'current' ? 'info' : 'neutral'}
              label={String(i + 1)}
            />
            <Text weight={step.state === 'todo' ? undefined : 'semibold'} type={step.state === 'todo' ? 'supporting' : 'body'}>
              {step.label}
            </Text>
            {step.state === 'current' ? <Badge variant="info" label="ตอนนี้" /> : null}
          </HStack>
        ))}
      </VStack>
    </Card>
  );
}
