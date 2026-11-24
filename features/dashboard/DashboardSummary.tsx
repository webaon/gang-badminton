import React from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { baht } from '@/domain/sessions/close-view';
import type { DashboardOverview } from '@/server/actions/dashboard';

export type DashboardSummaryData = Pick<DashboardOverview,
  'memberCount' | 'newMembersThisMonth' | 'sessionsThisMonth' |
  'unclosedSessionsCount' | 'joinRequestsPending' | 'outstanding' |
  'pendingSlips' | 'netCashThisMonth' | 'creditOutstanding'>;

function Metric({ title, value, detail }: { title: string; value: string; detail?: string }) {
  return (
    <Card padding={5}>
      <VStack gap={2} className="min-w-0">
        <Heading level={2}>{title}</Heading>
        <Text size="2xl" weight="semibold" hasTabularNumbers className="break-words">{value}</Text>
        {detail ? <Text color="secondary" size="sm">{detail}</Text> : null}
      </VStack>
    </Card>
  );
}

/** Visibility follows the loader contract; zero remains a real, visible value. */
export function DashboardSummary({ data }: { data: DashboardSummaryData }) {
  return (
    <Grid columns={{ minWidth: 240, max: 4 }} gap={4}>
      <Metric title="สมาชิก" value={`${data.memberCount} คน`} detail={`สมาชิกใหม่เดือนนี้ ${data.newMembersThisMonth} คน`} />
      <Metric title="นัดเดือนนี้" value={`${data.sessionsThisMonth} นัด`} />
      {data.outstanding !== null ? (
        <Metric title="ค้างจ่าย" value={baht(data.outstanding.amount)} detail={`${data.outstanding.debtors} คน`} />
      ) : null}
      {data.pendingSlips !== null ? (
        <Metric title="สลิปรอตรวจ" value={`${data.pendingSlips.count} รายการ`}
          detail={data.pendingSlips.oldestDays !== null ? `เก่าสุด ${data.pendingSlips.oldestDays} วัน` : undefined} />
      ) : null}
      {data.netCashThisMonth !== null ? <Metric title="เงินสดสุทธิเดือนนี้" value={baht(data.netCashThisMonth)} /> : null}
      {data.creditOutstanding !== null ? <Metric title="เครดิตสมาชิกคงค้าง" value={baht(data.creditOutstanding)} /> : null}
      {data.unclosedSessionsCount !== null ? <Metric title="นัดที่ยังไม่ปิดรอบ" value={`${data.unclosedSessionsCount} นัด`} /> : null}
      {data.joinRequestsPending !== null ? <Metric title="คำขอเข้าก๊วน" value={`${data.joinRequestsPending} คน`} /> : null}
    </Grid>
  );
}
