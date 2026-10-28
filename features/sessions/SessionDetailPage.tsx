import { notFound } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { formatInTimeZone } from '@/domain/time/timezone';
import {
  buildRoster,
  duplicateGuestRowIds,
  fillPercent,
  primaryAction,
  seatPosition,
  seatsLeft,
  waitlistPosition,
  type RosterRow,
} from '@/domain/sessions/member-view';
import { buildTimeline, type TimelineEvent } from '@/domain/reports/timeline';
import { CheckinQrButton } from '@/features/sessions/CheckinQrButton';
import { GuestInviteCard } from '@/features/sessions/GuestInviteCard';
import { RegistrationActions } from '@/features/sessions/RegistrationActions';
import { RosterCardShell, RosterList } from '@/features/sessions/RosterList';
import { RosterSync } from '@/features/sessions/RosterSync';
import { SESSION_STATUS_LABELS } from '@/features/sessions/SessionListCard';
import { SessionTimeline } from '@/features/reports/SessionTimeline';

type Row = {
  id: string;
  user_id: string | null;
  guest_name: string | null;
  status: string;
  ordering: number;
  created_at: string;
  profiles: { display_name: string } | null;
};

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <VStack gap={0.5} align="center" className="min-w-0 flex-1 rounded-lg bg-muted p-3">
      <Text weight="semibold" size="lg" hasTabularNumbers>
        {value}
      </Text>
      <Text type="supporting" size="xsm">
        {label}
      </Text>
    </VStack>
  );
}

/**
 * หน้ารายละเอียดนัดฝั่งสมาชิก (hi-fi 19 + 20 ฉบับมือถือ + K19c) — [WO-6.2]
 * server component · route ห่อบางๆ ที่ `app/gangs/[gangId]/sessions/[sessionId]/page.tsx`
 *
 * 🔴 สิทธิ์: `can()` + flag ตัดสินว่าจะ "แสดง" อะไร — ไม่ใช่การตรวจสิทธิ์ (server action ตรวจซ้ำเอง)
 * 🔴 ไม่มีการคิดเงิน/ค่าปรับใน UI · timeline ผ่าน `buildTimeline()` เท่านั้น (ไม่ render payload ดิบ)
 */
export async function SessionDetailPage({ gangId, sessionId }: { gangId: string; sessionId: string }) {
  const user = await requireUser(`/gangs/${gangId}/sessions/${sessionId}`);
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, venue, starts_at, ends_at, status, max_players, allow_guests, gangs!inner(name, timezone, features)')
    .eq('id', sessionId)
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) notFound();

  const gang = (session as unknown as {
    gangs: { name: string; timezone: string; features: Record<string, boolean> };
  }).gangs;

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  const { data: registrations } = await supabase
    .from('session_registrations')
    // 🔴 ต้องระบุชื่อ FK — `session_registrations` ชี้ไป `profiles` ถึง 5 เส้น
    //    (user_id, registered_by, updated_by, created_by, deleted_by) ⇒ เขียน `profiles(...)`
    //    เฉยๆ จะได้ PGRST201 "ambiguous embed" แล้ว query ทั้งก้อนคืน error ⇒ รายชื่อหายทั้งหน้า
    .select('id, user_id, guest_name, status, ordering, created_at, profiles!session_registrations_user_id_fkey(display_name)')
    .eq('session_id', sessionId)
    .is('deleted_at', null)
    .order('status')
    .order('ordering');

  const rows = (registrations ?? []) as unknown as Row[];
  const rosterRows: RosterRow[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.profiles?.display_name ?? r.guest_name ?? 'ไม่ระบุชื่อ',
    status: r.status,
    ordering: r.ordering,
    registeredAt: r.created_at,
  }));

  const roster = buildRoster(rosterRows);
  const mineRow = rosterRows.find((r) => r.userId === user.id && ['confirmed', 'checked_in', 'waitlist'].includes(r.status));
  const mine = mineRow ? { id: mineRow.id, status: mineRow.status } : null;

  const sessionOpen = session.status === 'open';
  const primary = primaryAction({
    roster,
    mine,
    maxPlayers: session.max_players,
    sessionOpen,
    canRegister: can({ role }, 'registration.create.self'),
  });

  const seatedCount = roster.seated.length;
  const left = seatsLeft(seatedCount, session.max_players);
  const myWaitPos = mine ? waitlistPosition(roster, mine.id) : null;
  const mySeat = mine ? seatPosition(roster, mine.id) : null;
  const duplicateIds = duplicateGuestRowIds(rosterRows);

  const canInvite = session.allow_guests && can({ role, features: gang.features }, 'session.invite.manage');

  // 🔴 [WO-3.C] timeline อ่านผ่าน client ที่ผูก session — **RLS เป็นด่านจริง**
  const { data: eventRows } = await supabase
    .from('event_logs')
    .select('id, event_type, created_at, payload, profiles:actor_id(display_name)')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(50);

  type EventRow = {
    id: string;
    event_type: string;
    created_at: string;
    payload: Record<string, unknown> | null;
    profiles: { display_name: string } | null;
  };

  const events: TimelineEvent[] = ((eventRows ?? []) as unknown as EventRow[]).map((e) => ({
    id: e.id,
    eventType: e.event_type,
    createdAt: e.created_at,
    actorName: e.profiles?.display_name ?? null,
    payload: e.payload ?? {},
  }));

  // เรื่องเงินรายคนแสดงเฉพาะคนที่มีสิทธิ์ดู (กติกาเดียวกับ payments ใน WO-2.9)
  const timeline = buildTimeline(events, can({ role }, 'payment.verify'));

  const starts = new Date(session.starts_at);
  const ends = new Date(session.ends_at);

  return (
    <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4">
      <Card padding={5} variant="blue">
        <VStack gap={2}>
          <HStack justify="between" align="start" gap={3}>
            <Text type="supporting" size="sm">
              {gang.name}
            </Text>
            <Badge variant={sessionOpen ? 'success' : 'neutral'} label={SESSION_STATUS_LABELS[session.status] ?? session.status} />
          </HStack>
          <Heading level={1}>{session.title}</Heading>
          {/* 🔴 แสดงตาม timezone ของก๊วน ไม่ใช่ของเครื่องผู้ใช้ */}
          <Text weight="medium">
            {formatInTimeZone(starts, gang.timezone, { dateStyle: 'full' })}
          </Text>
          <Text type="supporting">
            {formatInTimeZone(starts, gang.timezone, { timeStyle: 'short' })}–
            {formatInTimeZone(ends, gang.timezone, { timeStyle: 'short' })}
            {session.venue ? ` · ${session.venue}` : ''}
          </Text>
        </VStack>
      </Card>

      <HStack gap={2}>
        <Stat value={`${seatedCount}/${session.max_players}`} label="ลงชื่อ" />
        <Stat value={String(roster.waitlist.length)} label="รอคิว" />
        <Stat value={left === 0 ? 'เต็ม' : String(left)} label="ที่ว่าง" />
      </HStack>
      <Text type="supporting" size="xsm" className="sr-only">
        เติม {fillPercent(seatedCount, session.max_players)}%
      </Text>

      {/* สถานะของฉัน — แสดงเมื่อลงชื่อ/อยู่ในคิวแล้ว */}
      {mine ? (
        <Card padding={4} variant={mine.status === 'waitlist' ? 'orange' : 'green'}>
          <VStack gap={0.5}>
            <Text weight="semibold" size="lg">
              {mine.status === 'waitlist'
                ? `คุณอยู่ในคิวรอ · ลำดับที่ ${myWaitPos ?? '-'}`
                : `คุณลงชื่อแล้ว${mySeat ? ` · ลำดับที่ ${mySeat}` : ''}`}
            </Text>
            <Text type="supporting" size="sm">
              {mine.status === 'waitlist'
                ? 'ถ้ามีคนยกเลิก คุณจะได้ที่ตามลำดับโดยอัตโนมัติ'
                : mine.status === 'checked_in'
                  ? 'เช็คอินแล้ว เจอกันที่สนาม'
                  : 'อย่าลืมแสดง QR เช็คอินเมื่อถึงสนาม'}
            </Text>
          </VStack>
        </Card>
      ) : null}

      <RegistrationActions
        sessionId={sessionId}
        myRegistrationId={mine?.id ?? null}
        primary={primary}
        timezone={gang.timezone}
      />

      {/* [WO-2.5-F] QR ของตัวเอง — ออกได้เฉพาะคนที่ได้ที่แล้ว */}
      {mine && ['confirmed', 'checked_in'].includes(mine.status) ? <CheckinQrButton registrationId={mine.id} /> : null}

      <RosterCardShell sync={<RosterSync sessionId={sessionId} />}>
        <RosterList roster={roster} meUserId={user.id} duplicateIds={duplicateIds} maxPlayers={session.max_players} />
      </RosterCardShell>

      {canInvite ? <GuestInviteCard sessionId={sessionId} /> : null}

      <HStack gap={2} wrap="wrap">
        <Button label="จ่ายเงิน" href={`/gangs/${gangId}/sessions/${sessionId}/pay`} />
        {can({ role }, 'registration.checkin') ? (
          <Button label="สแกนเช็คอิน" href={`/gangs/${gangId}/sessions/${sessionId}/scan`} />
        ) : null}
        {can({ role }, 'game.manage') ? (
          <Button label="คอนโซล" href={`/gangs/${gangId}/sessions/${sessionId}/console`} />
        ) : null}
        <Button label="นัดทั้งหมด" variant="ghost" href={`/gangs/${gangId}/sessions`} />
      </HStack>

      <Card padding={5}>
        <VStack gap={3}>
          <Heading level={2}>ไทม์ไลน์</Heading>
          <SessionTimeline items={timeline} />
        </VStack>
      </Card>
    </VStack>
  );
}
