import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Link } from '@astryxdesign/core/Link';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { formatInTimeZone } from '@/domain/time/timezone';
import { fillPercent, seatsLeft } from '@/domain/sessions/member-view';

export const SESSION_STATUS_LABELS: Record<string, string> = {
  draft: 'ร่าง',
  open: 'เปิดรับสมัคร',
  in_play: 'กำลังเล่น',
  billing: 'กำลังเก็บเงิน',
  settled: 'เก็บเงินครบ',
  archived: 'เก็บเข้าคลัง',
  cancelled: 'ยกเลิก',
};

export type MyStatus =
  | { kind: 'none' }
  | { kind: 'seated' }
  | { kind: 'waitlist'; position: number | null };

export type SessionCardData = {
  id: string;
  title: string;
  venue: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  maxPlayers: number;
  /** ได้ที่แล้ว (confirmed + checked_in) — ไม่มี = ไม่รู้ (นัดที่ผ่านมา) */
  seated?: number;
  waitlist?: number;
  mine: MyStatus;
};

/** วันที่/เวลาตาม timezone ของก๊วน (ไม่ใช่ของเครื่องผู้ใช้) */
function DateBox({ startsAt, timezone, accent }: { startsAt: string; timezone: string; accent: boolean }) {
  const date = new Date(startsAt);
  return (
    <VStack
      className={`size-14 shrink-0 items-center justify-center rounded-lg ${accent ? 'bg-accent-muted' : 'bg-muted'}`}
      aria-hidden="true"
    >
      <Text type="supporting" size="xsm">
        {formatInTimeZone(date, timezone, { weekday: 'short' })}
      </Text>
      <Text weight="semibold" size="xl" hasTabularNumbers>
        {formatInTimeZone(date, timezone, { day: 'numeric' })}
      </Text>
    </VStack>
  );
}

function MyStatusBadge({ mine }: { mine: MyStatus }) {
  if (mine.kind === 'seated') return <Badge variant="success" label="ลงชื่อแล้ว" />;
  if (mine.kind === 'waitlist') {
    return <Badge variant="warning" label={mine.position ? `อยู่คิวที่ ${mine.position}` : 'อยู่ในคิว'} />;
  }
  return null;
}

/**
 * การ์ดนัดในลิสต์ (hi-fi 17) — server component ล้วน ไม่มี state
 * ปุ่มทุกอันเป็นลิงก์ไปหน้านัด: ลงชื่อ/ยกเลิกทำที่หน้านัดเพราะต้องบอกผลก่อนยกเลิก
 */
export function SessionListCard({
  gangId,
  timezone,
  session,
  featured = false,
}: {
  gangId: string;
  timezone: string;
  session: SessionCardData;
  featured?: boolean;
}) {
  const href = `/gangs/${gangId}/sessions/${session.id}`;
  const known = session.seated !== undefined;
  const seated = session.seated ?? 0;
  const left = seatsLeft(seated, session.maxPlayers);
  const full = known && left === 0;
  const isOpen = session.status === 'open';

  const cta =
    session.mine.kind !== 'none'
      ? { label: 'ดูนัด', variant: 'secondary' as const }
      : isOpen && known
        ? full
          ? { label: 'เข้าคิว', variant: 'secondary' as const }
          : { label: 'ลงชื่อ', variant: 'primary' as const }
        : { label: 'ดูนัด', variant: 'secondary' as const };

  return (
    <Card padding={4} variant={featured ? 'blue' : 'default'} aria-label={session.title}>
      <HStack gap={4} align="center">
        <DateBox startsAt={session.startsAt} timezone={timezone} accent={featured} />

        <VStack gap={1.5} className="min-w-0 flex-1">
          <Text weight="semibold" maxLines={2}>
            <Link href={href}>{session.title}</Link>
          </Text>
          <Text type="supporting" size="sm">
            {formatInTimeZone(new Date(session.startsAt), timezone, { timeStyle: 'short' })}–
            {formatInTimeZone(new Date(session.endsAt), timezone, { timeStyle: 'short' })}
            {session.venue ? ` · ${session.venue}` : ''}
          </Text>

          {known ? (
            <>
              <ProgressBar
                label={`ลงชื่อแล้ว ${seated} จาก ${session.maxPlayers} คน`}
                isLabelHidden
                value={fillPercent(seated, session.maxPlayers)}
                variant={full ? 'warning' : 'accent'}
              />
              <HStack justify="between" gap={2} wrap="wrap">
                <Text type="supporting" size="xsm" hasTabularNumbers>
                  {seated}/{session.maxPlayers} คน
                </Text>
                <Text type="supporting" size="xsm">
                  {full
                    ? `เต็ม${session.waitlist ? ` · รอคิว ${session.waitlist} คน` : ''}`
                    : `เหลือ ${left} ที่`}
                </Text>
              </HStack>
            </>
          ) : null}

          <HStack gap={2} align="center" wrap="wrap">
            <MyStatusBadge mine={session.mine} />
            <Badge label={SESSION_STATUS_LABELS[session.status] ?? session.status} />
          </HStack>
        </VStack>

        <Button label={cta.label} href={href} variant={cta.variant} size="sm" />
      </HStack>
    </Card>
  );
}
