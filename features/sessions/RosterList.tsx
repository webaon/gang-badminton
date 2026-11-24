import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import type { Roster, RosterRow } from '@/domain/sessions/member-view';

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'ได้ที่',
  checked_in: 'มาแล้ว',
};

function RosterItem({
  row,
  index,
  isMe,
  isDuplicate,
  tone,
}: {
  row: RosterRow;
  index: number;
  isMe: boolean;
  isDuplicate: boolean;
  tone: 'seated' | 'waitlist';
}) {
  const isGuest = row.userId === null;
  return (
    <HStack as="li" gap={3} align="center" className="min-w-0 py-2">
      <Text type="supporting" size="sm" hasTabularNumbers className="w-6 shrink-0 text-center">
        {index}
      </Text>
      <Avatar name={row.name} size="md" tooltip={false} />
      <VStack className="min-w-0 flex-1" gap={0.5}>
        <Text weight={isMe ? 'semibold' : 'normal'} maxLines={1}>
          {row.name}
          {isMe ? ' (คุณ)' : ''}
        </Text>
        <HStack gap={1.5} wrap="wrap">
          {isGuest ? <Badge variant="warning" label="guest" /> : null}
          {isDuplicate ? <Badge variant="orange" label="ชื่อซ้ำ" /> : null}
        </HStack>
      </VStack>
      {tone === 'seated' ? <Badge variant="success" label={STATUS_LABEL[row.status] ?? row.status} /> : null}
    </HStack>
  );
}

/**
 * รายชื่อผู้เล่น (hi-fi 20 ฉบับมือถือ) — ได้ที่แล้ว / รอคิว (ลำดับ) — [WO-6.2]
 * server component ล้วน: realtime อยู่ที่ `RosterSync` (สั่ง router.refresh) ⇒ ไม่มี state ซ้ำซ้อนที่นี่
 *
 * ป้าย "ชื่อซ้ำ" เป็นคำเตือนฝั่ง UI เท่านั้น (ไม่บล็อก ไม่แก้ข้อมูล) — กัน guest ชื่อเดียวกันหลายแถวโดยไม่รู้ตัว
 */
export function RosterList({
  roster,
  meUserId,
  duplicateIds,
  maxPlayers,
}: {
  roster: Roster;
  meUserId: string;
  duplicateIds: ReadonlySet<string>;
  maxPlayers: number;
}) {
  const empty = roster.seated.length === 0 && roster.waitlist.length === 0;

  if (empty) {
    return <Text type="supporting">ยังไม่มีใครลงชื่อ — เป็นคนแรกได้เลย</Text>;
  }

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <HStack justify="between" align="center">
          <Heading level={3}>ได้ที่แล้ว</Heading>
          <Text type="supporting" size="sm" hasTabularNumbers>
            {roster.seated.length}/{maxPlayers} คน
          </Text>
        </HStack>
        {roster.seated.length === 0 ? (
          <Text type="supporting">ยังไม่มีคนได้ที่</Text>
        ) : (
          <VStack as="ul" className="list-none p-0">
            {roster.seated.map((r, i) => (
              <RosterItem
                key={r.id}
                row={r}
                index={i + 1}
                isMe={r.userId === meUserId}
                isDuplicate={duplicateIds.has(r.id)}
                tone="seated"
              />
            ))}
          </VStack>
        )}
      </VStack>

      {roster.waitlist.length > 0 ? (
        <VStack gap={1}>
          <HStack justify="between" align="center">
            <Heading level={3}>คิวรอ</Heading>
            <Text type="supporting" size="sm" hasTabularNumbers>
              {roster.waitlist.length} คน
            </Text>
          </HStack>
          <Text type="supporting" size="sm">
            ได้ที่ตามลำดับเมื่อมีคนยกเลิก
          </Text>
          <VStack as="ul" className="list-none p-0">
            {roster.waitlist.map((r, i) => (
              <RosterItem
                key={r.id}
                row={r}
                index={i + 1}
                isMe={r.userId === meUserId}
                isDuplicate={duplicateIds.has(r.id)}
                tone="waitlist"
              />
            ))}
          </VStack>
        </VStack>
      ) : null}
    </VStack>
  );
}

export function RosterCardShell({ children, sync }: { children: React.ReactNode; sync: React.ReactNode }) {
  return (
    <Card padding={5}>
      <VStack gap={3}>
        <HStack justify="between" align="center">
          <Heading level={2}>รายชื่อ</Heading>
          {sync}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}
