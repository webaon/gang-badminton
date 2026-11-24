import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { StatePanel } from '@/components/ui/StatePanel';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import { SESSION_PRICING_TYPES } from '@/domain/policies/pricing';
import type { GangRole } from '@/domain/permissions/types';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import {
  bucketSessions,
  buildRoster,
  pickFeatured,
  waitlistPosition,
  type RosterRow,
  type SessionTab,
} from '@/domain/sessions/member-view';
import { CreateSessionForm } from '@/features/sessions/CreateSessionForm';
import { SessionActions } from '@/features/sessions/SessionActions';
import { SessionFilterTabs } from '@/features/sessions/SessionFilterTabs';
import { SessionListCard, type MyStatus, type SessionCardData } from '@/features/sessions/SessionListCard';

const PAST_LIMIT = 20;

/**
 * ลิสต์นัดของก๊วน (hi-fi 17 + K17) — server component · route (`app/.../sessions/page.tsx`) ห่อบางๆ
 *
 * 🔴 สิทธิ์ทุกอย่างมาจาก `can()` + RLS · ปุ่มแอดมิน (SessionActions / สร้างนัด) ซ่อนตาม `can()` เท่านั้น
 *    ซึ่งไม่ใช่การตรวจสิทธิ์ — server action แต่ละตัวตรวจซ้ำเอง
 */
export async function SessionsListPage({ gangId, tab }: { gangId: string; tab: SessionTab }) {
  const user = await requireUser(`/gangs/${gangId}/sessions`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, timezone')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;
  const canCreate = can({ role }, 'session.create');
  const canTransition = can({ role }, 'session.transition');

  const { data: plan } = await supabase
    .from('gang_pricing_plans')
    .select('id')
    .eq('gang_id', gangId)
    .eq('is_active', true)
    // แผน `monthly` ไม่นับว่า "ตั้งราคานัดแล้ว" [ADR-006]
    .in('type', SESSION_PRICING_TYPES)
    .limit(1)
    .maybeSingle();

  const { data: sessionRows } = await supabase
    .from('sessions')
    .select('id, title, venue, starts_at, ends_at, status, max_players, snapshot')
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .order('starts_at', { ascending: false })
    .limit(100);

  const sessions = (sessionRows ?? []).map((s) => ({
    id: s.id as string,
    title: s.title as string,
    venue: (s.venue as string | null) ?? null,
    startsAt: s.starts_at as string,
    endsAt: s.ends_at as string,
    status: s.status as string,
    maxPlayers: s.max_players as number,
    snapshot: s.snapshot as { cancellation_policy?: unknown } | null,
  }));

  const { upcoming, past } = bucketSessions(sessions, new Date());

  // ตัวเลขที่นั่ง + สถานะของฉัน: อ่านจาก session_registrations ผ่าน RLS เดิม (แถวที่ยังอยู่ในนัดเท่านั้น)
  // นัดที่ผ่านมาไม่ต้องนับ (ไม่แสดงที่ว่าง) ⇒ แถวที่ดึงจึงจำกัดอยู่ที่นัดที่ยังไม่จบ
  const upcomingIds = upcoming.map((s) => s.id);
  const { data: regRows } = upcomingIds.length
    ? await supabase
        .from('session_registrations')
        .select('id, session_id, user_id, status, ordering')
        .in('session_id', upcomingIds)
        .in('status', ['confirmed', 'checked_in', 'waitlist'])
        .is('deleted_at', null)
    : { data: [] };

  const bySession = new Map<string, RosterRow[]>();
  for (const r of regRows ?? []) {
    const row: RosterRow = {
      id: r.id as string,
      userId: (r.user_id as string | null) ?? null,
      name: '',
      status: r.status as string,
      ordering: r.ordering as number,
    };
    const list = bySession.get(r.session_id as string);
    if (list) list.push(row);
    else bySession.set(r.session_id as string, [row]);
  }

  function cardFor(s: (typeof sessions)[number]): SessionCardData {
    const rows = bySession.get(s.id) ?? [];
    const roster = buildRoster(rows);
    const mineRow = rows.find((r) => r.userId === user.id);
    let mine: MyStatus = { kind: 'none' };
    if (mineRow) {
      mine =
        mineRow.status === 'waitlist'
          ? { kind: 'waitlist', position: waitlistPosition(roster, mineRow.id) }
          : { kind: 'seated' };
    }
    return { ...s, seated: roster.seated.length, waitlist: roster.waitlist.length, mine };
  }

  const upcomingCards = upcoming.map(cardFor);
  const mineCards = upcomingCards.filter((c) => c.mine.kind !== 'none');
  const pastCards: SessionCardData[] = past.slice(0, PAST_LIMIT).map((s) => ({ ...s, mine: { kind: 'none' } }));

  const visible = tab === 'mine' ? mineCards : tab === 'past' ? pastCards : upcomingCards;
  const featured = tab === 'upcoming' ? pickFeatured(upcomingCards, (c) => c.mine.kind !== 'none') : null;

  const snapshotById = new Map(sessions.map((s) => [s.id, s.snapshot]));
  const listed = visible.filter((c) => !(featured && c.id === featured.id));

  const adminActions = (c: SessionCardData) =>
    canTransition ? (
      <SessionActions
        sessionId={c.id}
        gangId={gangId}
        status={c.status}
        midwayCancelRatioDefault={policyFromJson(snapshotById.get(c.id)?.cancellation_policy).midwayCancelRatio}
      />
    ) : null;

  return (
    <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4">
      <Heading level={1}>นัดของ {gang.name}</Heading>

      {canCreate && !plan ? (
        <Card padding={4} variant="muted">
          <Text type="supporting">
            ยังไม่ได้ตั้งแผนราคา — ต้องตั้งราคาก่อนถึงจะสร้างนัดได้{' '}
            <Link href={`/gangs/${gangId}/settings`} className="underline">
              ไปตั้งราคา
            </Link>
          </Text>
        </Card>
      ) : null}

      {featured ? (
        <VStack gap={2}>
          <Text type="label">{featured.mine.kind !== 'none' ? 'นัดถัดไปของคุณ' : 'นัดที่เปิดรับถัดไป'}</Text>
          <SessionListCard gangId={gangId} timezone={gang.timezone} session={featured} featured />
          {adminActions(featured)}
        </VStack>
      ) : null}

      <SessionFilterTabs value={tab} />

      {visible.length === 0 ? (
        // hi-fi K17 — empty state ตามแท็บ
        <StatePanel
          fullPage={false}
          headingLevel={2}
          title={
            tab === 'mine'
              ? 'คุณยังไม่ได้ลงชื่อนัดไหน'
              : tab === 'past'
                ? 'ยังไม่มีนัดที่ผ่านมา'
                : 'ตอนนี้ยังไม่มีนัดเปิดรับ'
          }
          description={
            tab === 'mine'
              ? 'ลงชื่อนัดที่สนใจได้จากแท็บ “เร็วๆ นี้”'
              : tab === 'past'
                ? 'นัดที่จบแล้วจะมาอยู่ที่นี่'
                : 'เมื่อแอดมินสร้างนัดใหม่ นัดจะขึ้นที่นี่ทันที'
          }
          actions={[
            tab === 'upcoming'
              ? { label: 'ดูนัดที่ผ่านมา', href: `/gangs/${gangId}/sessions?tab=past`, variant: 'secondary' }
              : { label: 'ดูนัดเร็วๆ นี้', href: `/gangs/${gangId}/sessions`, variant: 'secondary' },
          ]}
        />
      ) : (
        <VStack as="ul" gap={3} className="list-none p-0">
          {listed.map((c) => (
            <li key={c.id}>
              <VStack gap={2}>
                <SessionListCard gangId={gangId} timezone={gang.timezone} session={c} />
                {adminActions(c)}
              </VStack>
            </li>
          ))}
        </VStack>
      )}

      {canCreate && plan ? (
        <Card padding={6} elevation="low">
          <VStack gap={3}>
            <Heading level={2}>สร้างนัดใหม่</Heading>
            <CreateSessionForm gangId={gangId} timezone={gang.timezone} />
          </VStack>
        </Card>
      ) : null}
    </VStack>
  );
}
