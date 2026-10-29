import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { VStack } from '@astryxdesign/core/VStack';

import { GameConsole } from '@/features/sessions/GameConsole';
import { RosterSync } from '@/features/sessions/RosterSync';
import { loadConsole } from '@/server/sessions/console-loader';

export const dynamic = 'force-dynamic';

/**
 * คอนโซลวันเล่น (hi-fi 23 เช็คอิน · 25 จัดคู่ · 26 เกม + นับลูก · 27 เวลาพัก) — **[WO-6.4a]**
 * ข้อมูล + ด่านสิทธิ์ (`game.manage`) อยู่ใน `loadConsole()` ร่วมกับกระดานคิวสด
 */
export default async function ConsolePage({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  const data = await loadConsole(gangId, sessionId, `/gangs/${gangId}/sessions/${sessionId}/console`);
  const { session } = data;

  return (
    <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4">
      <VStack gap={2}>
        <Heading level={1}>คอนโซล · {session.title}</Heading>
        <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            variant="secondary"
            label="กระดานคิวสด"
            href={`/gangs/${gangId}/sessions/${sessionId}/console/board`}
          />
          <Button size="sm" variant="ghost" label="รายละเอียดนัด" href={`/gangs/${gangId}/sessions/${sessionId}`} />
          {data.canClose && ['open', 'in_play'].includes(session.status) ? (
            <Button
              size="sm"
              variant="secondary"
              label="ปิดรอบ"
              href={`/gangs/${gangId}/sessions/${sessionId}/close`}
            />
          ) : null}
        </HStack>
      </VStack>

      <RosterSync sessionId={sessionId} />

      <GameConsole
        sessionId={sessionId}
        gangId={gangId}
        now={data.now}
        pendingCheckIn={data.pendingCheckIn}
        games={data.games}
        queue={data.queue.map((r) => ({
          registrationId: r.registration_id,
          displayName: r.display_name,
          isGuest: r.is_guest,
          gamesPlayed: Number(r.games_played),
          currentGameId: r.current_game_id,
          waitingSince: r.waiting_since,
        }))}
        courtCount={session.courtCount}
        finishedGames={data.finishedGames}
        canEditShuttles={['open', 'in_play'].includes(session.status)}
      />
    </VStack>
  );
}
