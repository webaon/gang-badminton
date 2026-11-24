import React from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { SimpleTable } from '@/components/ui/SimpleTable';
import { baht } from '@/domain/sessions/close-view';
import { formatInTimeZone } from '@/domain/time/timezone';
import type { DashboardOverview } from '@/server/actions/dashboard';

export function DashboardDetails({ data, gangId }: { data: DashboardOverview; gangId: string }) {
  const next = data.nextSession;
  const average = data.avgAttendeesThisMonth;
  return (
    <VStack gap={4}>
      {next !== null ? (
        <Card padding={5}>
          <VStack gap={3}>
            <Heading level={2}>นัดถัดไป</Heading>
            <Text weight="semibold">{next.title}</Text>
            <Text>{formatInTimeZone(new Date(next.startsAt), 'Asia/Bangkok', { dateStyle: 'medium', timeStyle: 'short' })} – {formatInTimeZone(new Date(next.endsAt), 'Asia/Bangkok', { dateStyle: 'medium', timeStyle: 'short' })}</Text>
            <Text color="secondary">เวลาไทย · ลงชื่อ {next.seatedCount} คน · รอคิว {next.waitlistCount} คน · ผู้เล่นรับเชิญ {next.guestCount} คน · {next.courtCount} คอร์ท</Text>
            <Button href={`/gangs/${gangId}/sessions/${next.id}`} label="ดูรายละเอียดนัด" variant="secondary" className="min-h-11"><Text color="primary">ดูรายละเอียดนัด</Text></Button>
          </VStack>
        </Card>
      ) : null}
      <Card padding={5}>
        <VStack gap={2}>
          <Heading level={2}>ผู้เล่นเฉลี่ยเดือนนี้</Heading>
          <Text size="2xl" hasTabularNumbers>{average.sessionCount === 0 ? '—' : (average.totalSeated / average.sessionCount).toFixed(1)}</Text>
          <Text color="secondary">คนต่อนัด · จาก {average.sessionCount} นัด</Text>
        </VStack>
      </Card>
      {data.monthlyCashFlow !== null ? (
        <Card padding={5}>
          <VStack gap={3} className="min-w-0">
            <Heading level={2}>เงินเข้า / เงินออก · 6 เดือน</Heading>
            {data.monthlyCashFlow.length === 0 ? <Text color="secondary">ยังไม่มีข้อมูลรายเดือน</Text> : (
              <SimpleTable columns={[
                { key: 'month', header: 'เดือน' },
                { key: 'inflow', header: 'เงินเข้า', align: 'end' },
                { key: 'outflow', header: 'เงินออก', align: 'end' },
              ]} rows={data.monthlyCashFlow.map(row => ({ id: row.month, month: row.month, inflow: baht(row.inflow), outflow: baht(row.outflow) }))} />
            )}
          </VStack>
        </Card>
      ) : null}
      <Card padding={5}>
        <VStack gap={3}>
          <Heading level={2}>ความเคลื่อนไหวล่าสุด</Heading>
          {data.recentActivity.length === 0 ? <Text color="secondary">ยังไม่มีเหตุการณ์</Text> : data.recentActivity.map(item => (
            <VStack key={item.id} gap={1} className="border-b border-divider pb-3">
              <Text weight="medium">{item.title}</Text>
              {item.detail ? <Text>{item.detail}</Text> : null}
              {item.actorName ? <Text color="secondary">โดย {item.actorName}</Text> : null}
              <Text color="secondary" size="sm">{formatInTimeZone(new Date(item.createdAt), 'Asia/Bangkok', { dateStyle: 'short', timeStyle: 'short' })} · เวลาไทย</Text>
            </VStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}
