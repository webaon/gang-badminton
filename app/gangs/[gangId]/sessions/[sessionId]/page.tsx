import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { formatInTimeZone } from '@/domain/time/timezone';
import { RegistrationActions } from '@/features/sessions/RegistrationActions';
import { CheckinQrButton } from '@/features/sessions/CheckinQrButton';
import { SessionTimeline } from '@/features/reports/SessionTimeline';
import { buildTimeline, type TimelineEvent } from '@/domain/reports/timeline';
import { RosterSync } from '@/features/sessions/RosterSync';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  confirmed: 'ได้ที่',
  waitlist: 'รอคิว',
  checked_in: 'มาแล้ว',
  cancelled: 'ยกเลิก',
  no_show: 'ไม่มา',
};

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  const user = await requireUser(`/gangs/${gangId}/sessions/${sessionId}`);
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, venue, starts_at, ends_at, status, max_players, allow_guests, gangs!inner(timezone, features)')
    .eq('id', sessionId)
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) notFound();

  const gang = (session as unknown as {
    gangs: { timezone: string; features: Record<string, boolean> };
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
    .select(
      'id, user_id, guest_name, status, ordering, profiles!session_registrations_user_id_fkey(display_name)',
    )
    .eq('session_id', sessionId)
    .is('deleted_at', null)
    .order('status')
    .order('ordering');

  type Row = {
    id: string;
    user_id: string | null;
    guest_name: string | null;
    status: string;
    ordering: number;
    profiles: { display_name: string } | null;
  };

  const rows = (registrations ?? []) as unknown as Row[];
  const active = rows.filter((r) => !['cancelled', 'no_show'].includes(r.status));
  const confirmed = active.filter((r) => ['confirmed', 'checked_in'].includes(r.status));
  const waitlist = active.filter((r) => r.status === 'waitlist');

  const mine = rows.find((r) => r.user_id === user.id && !['cancelled'].includes(r.status));

  // 🔴 [WO-3.C] timeline อ่านผ่าน client ที่ผูก session — **RLS เป็นด่านจริง**
  //    ไม่ใช่ admin client แล้วมากรองเองใน TS
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

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{session.title}</h1>
        <span className="flex gap-3">
          {can({ role }, 'registration.checkin') ? (
            <Link href={`/gangs/${gangId}/sessions/${sessionId}/scan`} className="underline">
              สแกนเช็คอิน
            </Link>
          ) : null}
          {can({ role }, 'game.manage') ? (
            <Link href={`/gangs/${gangId}/sessions/${sessionId}/console`} className="underline">
              คอนโซล
            </Link>
          ) : null}
          <Link href={`/gangs/${gangId}/sessions/${sessionId}/pay`} className="underline">
            จ่ายเงิน
          </Link>
          <Link href={`/gangs/${gangId}/sessions`} className="underline">
            นัดทั้งหมด
          </Link>
        </span>
      </div>

      <Card padding={6}>
        <p className="text-sm">
          {formatInTimeZone(new Date(session.starts_at), gang.timezone)} –{' '}
          {formatInTimeZone(new Date(session.ends_at), gang.timezone, { timeStyle: 'short' })}
        </p>
        {session.venue ? <p className="text-sm">{session.venue}</p> : null}
        <p className="mt-1 text-sm">
          ได้ที่แล้ว {confirmed.length}/{session.max_players} คน
          {waitlist.length > 0 ? ` · รอคิว ${waitlist.length} คน` : ''}
        </p>

        {/* [WO-2.5-F] QR ของตัวเอง — ออกได้เฉพาะคนที่ได้ที่แล้ว */}
        {mine && ['confirmed', 'checked_in'].includes(mine.status) ? (
          <div className="mt-4">
            <CheckinQrButton registrationId={mine.id} />
          </div>
        ) : null}

        <div className="mt-4">
          <RegistrationActions
            sessionId={sessionId}
            myRegistrationId={mine?.id ?? null}
            canRegister={session.status === 'open' && can({ role }, 'registration.create.self')}
            canInvite={
              session.allow_guests &&
              can({ role, features: gang.features }, 'session.invite.manage')
            }
          />
        </div>
      </Card>

      <div className="mt-4">
        <Card padding={6}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">รายชื่อ</h2>
            <RosterSync sessionId={sessionId} />
          </div>

          {active.length === 0 ? (
            <p className="text-sm">ยังไม่มีใครลงชื่อ</p>
          ) : (
            <ul className="divide-y">
              {active.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate">
                    {r.profiles?.display_name ?? r.guest_name}
                    {r.user_id === null ? <span className="ml-2 text-xs">(guest)</span> : null}
                  </span>
                  <Badge label={STATUS_LABELS[r.status] ?? r.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card padding={6}>
          <h2 className="mb-3 text-base font-semibold">ไทม์ไลน์</h2>
          <SessionTimeline items={timeline} />
        </Card>
      </div>
    </main>
  );
}
