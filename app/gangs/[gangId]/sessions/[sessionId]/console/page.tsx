import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import {
  GameConsole,
  type ConsoleGame,
  type FinishedGame,
} from '@/features/sessions/GameConsole';
import { RosterSync } from '@/features/sessions/RosterSync';
import type { ConsoleQueueRow } from '@/server/actions/game-console';

export const dynamic = 'force-dynamic';

export default async function ConsolePage({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  const user = await requireUser(`/gangs/${gangId}/sessions/${sessionId}/console`);
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, status, court_count')
    .eq('id', sessionId)
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  // คอนโซลเป็นเครื่องมือของแอดมิน — สมาชิกทั่วไปให้กลับไปหน้ารายละเอียดนัด
  if (!can({ role }, 'game.manage')) {
    redirect(`/gangs/${gangId}/sessions/${sessionId}`);
  }

  const admin = supabaseAdmin();

  const { data: queueData } = await admin.rpc('session_console_queue', {
    p_session_id: sessionId,
  });
  const queue = (queueData ?? []) as ConsoleQueueRow[];

  // คนที่ได้ที่แล้วแต่ยังไม่เช็คอิน
  const { data: pending } = await supabase
    .from('session_registrations')
    // 🔴 ระบุ FK เสมอ — ดูเหตุผลใน `app/gangs/[gangId]/sessions/[sessionId]/page.tsx`
    .select('id, guest_name, profiles!session_registrations_user_id_fkey(display_name)')
    .eq('session_id', sessionId)
    .eq('status', 'confirmed')
    .is('deleted_at', null);

  type PendingRow = {
    id: string;
    guest_name: string | null;
    profiles: { display_name: string } | null;
  };

  const pendingCheckIn = ((pending ?? []) as unknown as PendingRow[]).map((r) => ({
    registrationId: r.id,
    displayName: r.profiles?.display_name ?? r.guest_name ?? 'ไม่ทราบชื่อ',
  }));

  const { data: activeGames } = await admin
    .from('games')
    .select(
      'id, court_no, player1_registration_id, player2_registration_id, player3_registration_id, player4_registration_id',
    )
    .eq('session_id', sessionId)
    .is('ended_at', null)
    .order('court_no');

  // เกมที่จบแล้ว — ให้แอดมินแก้จำนวนลูกก่อนปิดรอบ [WO-2.5-A]
  const { data: endedGames } = await admin
    .from('games')
    .select('id, court_no, shuttles_used')
    .eq('session_id', sessionId)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(50);

  const finishedGames: FinishedGame[] = (endedGames ?? []).map((g) => ({
    id: g.id,
    courtNo: g.court_no,
    shuttlesUsed: String(g.shuttles_used ?? '0'),
  }));

  const nameOf = new Map(queue.map((r) => [r.registration_id, r.display_name]));

  const games: ConsoleGame[] = (activeGames ?? []).map((g) => ({
    id: g.id,
    courtNo: g.court_no,
    // ⚠️ เรียงตามคอลัมน์เป๊ะ — ลำดับคือทีม A/B (ADR-003)
    players: [
      g.player1_registration_id,
      g.player2_registration_id,
      g.player3_registration_id,
      g.player4_registration_id,
    ].map((id) => ({ registrationId: id, displayName: nameOf.get(id) ?? 'ไม่ทราบชื่อ' })),
  }));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">คอนโซล · {session.title}</h1>
        <Link href={`/gangs/${gangId}/sessions/${sessionId}`} className="underline">
          รายละเอียดนัด
        </Link>
      </div>

      <div className="mb-3">
        <RosterSync sessionId={sessionId} />
      </div>

      <GameConsole
        sessionId={sessionId}
        pendingCheckIn={pendingCheckIn}
        games={games}
        queue={queue.map((r) => ({
          registrationId: r.registration_id,
          displayName: r.display_name,
          isGuest: r.is_guest,
          gamesPlayed: Number(r.games_played),
          currentGameId: r.current_game_id,
        }))}
        courtCount={session.court_count}
        finishedGames={finishedGames}
        canEditShuttles={['open', 'in_play'].includes(session.status)}
      />
    </main>
  );
}
