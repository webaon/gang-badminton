'use client';
import { useState, type ComponentProps } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { DateInput } from '@astryxdesign/core/DateInput';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';

export function ReportRange({ gangId, from, to }: { gangId: string; from: string; to: string }) {
  // Initial dates are validated by financeReport before this component renders.
  type DateValue = ComponentProps<typeof DateInput>['value'];
  const [start, setStart] = useState<DateValue>(from as DateValue);
  const [end, setEnd] = useState<DateValue>(to as DateValue);
  return <HStack gap={3} wrap="wrap" align="end" aria-label="ช่วงวันที่รายงาน">
    <DateInput label="ตั้งแต่วันที่" value={start} onChange={setStart} max={end} format="system_date" />
    <DateInput label="ถึงวันที่" value={end} onChange={setEnd} min={start} format="system_date" />
    <Button variant="secondary" label="ดูรายงานช่วงนี้" isDisabled={!start || !end} href={`/gangs/${gangId}/reports?${new URLSearchParams({ from: start ?? '', to: end ?? '' })}`}>
      <Text weight="semibold">ดูรายงานช่วงนี้</Text>
    </Button>
  </HStack>;
}
