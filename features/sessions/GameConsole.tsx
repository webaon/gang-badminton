'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';

import {
  courtSlots,
  formatRest,
  isLongRest,
  longestRest,
  restBarPercent,
  restMinutes,
} from '@/domain/play/rest-time';
import { stepShuttles } from '@/domain/play/shuttle-step';
import { actionError } from '@/lib/i18n/error-text';
import {
  checkIn,
  checkInEveryone,
  finishGame,
  generateGames,
  markNoShow,
  substitutePlayer,
  updateGameShuttles,
} from '@/server/actions/game-console';

export type ConsolePlayer = {
  registrationId: string;
  displayName: string;
  isGuest: boolean;
  gamesPlayed: number;
  currentGameId: string | null;
  /** เวลาจบเกมล่าสุด (ถ้ายังไม่เคยเล่น = เวลาเช็คอิน) — server เป็นคนให้ ใช้แค่แสดง "พักมา N นาที" */
  waitingSince: string;
};

export type ConsoleGame = {
  id: string;
  courtNo: number;
  /** ลำดับมีความหมาย: [0]&[1] = ทีม A · [2]&[3] = ทีม B (ADR-003) */
  players: { registrationId: string; displayName: string }[];
};

export type PendingCheckIn = { registrationId: string; displayName: string };

/** เกมที่จบแล้วในนัดนี้ — มีไว้ให้แก้จำนวนลูกก่อนปิดรอบ [WO-2.5-A] */
export type FinishedGame = { id: string; courtNo: number; shuttlesUsed: string };

type Picked = { gameId: string; slot: number };

/**
 * คอนโซลวันเล่น (hi-fi 23 เช็คอิน · 25 จัดคู่ · 26 เกม + นับลูก · 27 เวลาพัก) — **[WO-6.4a]**
 *
 * 🔴 หน้านี้ **ไม่คำนวณการจับคู่เอง** — กด "จัดคู่รอบใหม่" แล้ว server action
 *    เรียก `domain/matching` ให้ (baseline: engine เป็น pure function ห้ามมี
 *    logic จับคู่ในคอมโพเนนต์) · ไม่ import `domain/matching` ที่นี่
 *
 * 🔴 แผนที่จัดแล้วถูกบันทึกลง `games` ⇒ **refresh แล้วไม่ถูก engine เขียนทับ**
 *    หน้าจอแสดงสิ่งที่อยู่ในฐานข้อมูลเสมอ ไม่ใช่ผลคำนวณสดของรอบนี้
 *
 * 🔴 ไม่คิดเงิน — เงินคิดตอนปิดรอบ (domain/billing) · ปุ่มทุกปุ่มคือ server action เดิม ซึ่ง server ตรวจสิทธิ์ซ้ำ
 *
 * ⚠️ [D-19] "ลากสลับ" ทำเป็น **แตะเลือกแล้วแตะสลับ** ไม่ใช่ drag & drop
 *    baseline เขียนว่า "ลากสลับ" แต่แอปเป็น mobile-first และหน้านี้ใช้ตอนอยู่
 *    ข้างคอร์ทจริง — drag & drop บนมือถือพลาดง่ายและเข้าถึงยาก
 *    ผลลัพธ์เหมือนกันคือแอดมิน override ได้เสมอ
 */
export function GameConsole({
  sessionId,
  gangId,
  now,
  pendingCheckIn,
  games,
  finishedGames,
  queue,
  courtCount,
  canEditShuttles,
}: {
  sessionId: string;
  gangId: string;
  /** เวลา ณ ตอน render ฝั่ง server (ISO) */
  now: string;
  pendingCheckIn: PendingCheckIn[];
  games: ConsoleGame[];
  finishedGames: FinishedGame[];
  queue: ConsolePlayer[];
  courtCount: number;
  /** แก้ผลได้เฉพาะก่อนปิดรอบ — DB บังคับซ้ำอีกชั้นใน `update_game_shuttles()` */
  canEditShuttles: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shuttles, setShuttles] = useState<Record<string, string>>({});
  /** ช่องที่ถูกเลือกไว้รอสลับ */
  const [picked, setPicked] = useState<Picked | null>(null);
  /** ค่าที่กำลังแก้ของเกมที่จบแล้ว — key = gameId */
  const [corrections, setCorrections] = useState<Record<string, string>>({});

  async function run(fn: () => Promise<{ success: boolean; error?: { code?: string; message: string } }>) {
    setPending(true);
    setError(null);
    try {
      const result = await fn();
      if (result.success) router.refresh();
      else setError(actionError(result.error));
      return result.success;
    } catch {
      // network/5xx — ไม่ปล่อยให้ปุ่มค้างเป็น disabled ตลอด
      setError(actionError({ code: 'INTERNAL_ERROR', message: '' }));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function onSwapTarget(registrationId: string) {
    if (!picked) return;
    const ok = await run(() => substitutePlayer(picked.gameId, picked.slot, registrationId));
    if (ok) setPicked(null);
  }

  const idle = queue.filter((p) => p.currentGameId === null);
  const slots = courtSlots(courtCount, games);
  const checkedInCount = queue.length;
  const totalArrivals = checkedInCount + pendingCheckIn.length;
  const longest = longestRest(
    idle.map((p) => ({ registrationId: p.registrationId, waitingSince: p.waitingSince })),
    now,
  );

  return (
    <VStack gap={4}>
      {error ? <Banner status="error" title={error} /> : null}

      {picked ? (
        <Banner
          status="info"
          title="เลือกคนที่จะสลับเข้ามา"
          description="แตะชื่อคนในคิวหรือในคอร์ทอื่น"
          endContent={<Button size="sm" label="ยกเลิก" onClick={() => setPicked(null)} />}
        />
      ) : null}

      {/* ───────── 23 · เช็คอิน ───────── */}
      <Card padding={4}>
        <VStack gap={3}>
          <HStack justify="between" align="center" gap={3} wrap="wrap">
            <VStack gap={0.5}>
              <Heading level={2}>เช็คอิน</Heading>
              <Text type="supporting" size="sm" hasTabularNumbers>
                มาแล้ว {checkedInCount}/{totalArrivals} คน
              </Text>
            </VStack>
            <HStack gap={2} wrap="wrap">
              <Button size="sm" variant="secondary" label="สแกน QR" href={`/gangs/${gangId}/sessions/${sessionId}/scan`} />
              {pendingCheckIn.length > 0 ? (
                // 🔴 [WO-2.5-A] คนที่ได้ที่แต่ไม่เคยเช็คอิน ถูกคิดเงินเท่ากับคนไม่มา
                //    วันที่แอดมินไม่ได้เปิดคอนโซล = ทุกคนโดนเก็บด้วยเหตุผลผิด
                <Button
                  size="sm"
                  variant="primary"
                  label="เช็คอินทุกคน"
                  isDisabled={pending}
                  onClick={() => run(() => checkInEveryone(sessionId))}
                />
              ) : null}
            </HStack>
          </HStack>

          <ProgressBar
            label={`เช็คอินแล้ว ${checkedInCount} จาก ${totalArrivals} คน`}
            isLabelHidden
            value={totalArrivals === 0 ? 0 : Math.round((checkedInCount / totalArrivals) * 100)}
            variant="success"
          />

          {pendingCheckIn.length === 0 ? (
            <Text type="supporting">ทุกคนที่ได้ที่เช็คอินแล้ว</Text>
          ) : (
            <>
              <Text type="label">รอเช็คอิน ({pendingCheckIn.length})</Text>
              <List hasDividers>
                {pendingCheckIn.map((p) => (
                  <ListItem
                    key={p.registrationId}
                    label={p.displayName}
                    startContent={<Avatar name={p.displayName} size="sm" />}
                    endContent={
                      <HStack gap={2}>
                        <Button
                          size="sm"
                          variant="primary"
                          label="เช็คอิน"
                          isDisabled={pending}
                          onClick={() => run(() => checkIn(p.registrationId))}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          label="ไม่มา"
                          isDisabled={pending}
                          onClick={() => run(() => markNoShow(p.registrationId))}
                        />
                      </HStack>
                    }
                  />
                ))}
              </List>
            </>
          )}
        </VStack>
      </Card>

      {/* ───────── 25 · จัดคู่ + 26 · เกม + นับลูก ───────── */}
      <Card padding={4}>
        <VStack gap={3}>
          <HStack justify="between" align="center" gap={3} wrap="wrap">
            <VStack gap={0.5}>
              <Heading level={2}>
                คอร์ท ({games.length}/{courtCount})
              </Heading>
              <Text type="supporting" size="sm">
                คนว่างรอจัดคู่ {idle.length} คน
              </Text>
            </VStack>
            <Button
              size="sm"
              variant="primary"
              label="จัดคู่รอบใหม่"
              isDisabled={pending || idle.length < 4}
              onClick={() => run(() => generateGames(sessionId))}
            />
          </HStack>

          {games.length === 0 ? (
            <Text type="supporting">ยังไม่มีเกมกำลังเล่น — กด “จัดคู่รอบใหม่” เมื่อมีคนว่างครบ 4 คน</Text>
          ) : null}

          {slots.map(({ courtNo, game }) =>
            game ? (
              <Card key={game.id} padding={3} variant="muted" aria-label={`คอร์ท ${courtNo}`}>
                <VStack gap={3}>
                  <HStack justify="between" align="center">
                    <Heading level={3}>คอร์ท {courtNo}</Heading>
                    <Badge variant="success" label="กำลังเล่น" />
                  </HStack>

                  <HStack gap={2} align="center">
                    <TeamColumn game={game} slots={[1, 2]} picked={picked} pending={pending} onPick={setPicked} onSwapTarget={onSwapTarget} />
                    <Text type="supporting" size="xsm">
                      vs
                    </Text>
                    <TeamColumn game={game} slots={[3, 4]} picked={picked} pending={pending} onPick={setPicked} onSwapTarget={onSwapTarget} />
                  </HStack>

                  <HStack gap={2} align="end" wrap="wrap">
                    <VStack className="w-28">
                      <TextInput
                        label="ลูกที่ใช้"
                        size="sm"
                        value={shuttles[game.id] ?? ''}
                        onChange={(v) => setShuttles((s) => ({ ...s, [game.id]: v }))}
                        placeholder="เช่น 1.5"
                      />
                    </VStack>
                    <Button
                      size="sm"
                      label="−1 ลูก"
                      isDisabled={pending}
                      onClick={() => setShuttles((s) => ({ ...s, [game.id]: stepShuttles(s[game.id] ?? '', -1) }))}
                    />
                    <Button
                      size="sm"
                      label="+1 ลูก"
                      isDisabled={pending}
                      onClick={() => setShuttles((s) => ({ ...s, [game.id]: stepShuttles(s[game.id] ?? '', 1) }))}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      label="จบเกม"
                      isDisabled={pending}
                      onClick={() => run(() => finishGame(game.id, shuttles[game.id] || '0'))}
                    />
                  </HStack>
                </VStack>
              </Card>
            ) : (
              <Card key={`empty-${courtNo}`} padding={3} variant="muted" aria-label={`คอร์ท ${courtNo}`}>
                <HStack justify="between" align="center">
                  <Heading level={3}>คอร์ท {courtNo}</Heading>
                  <Badge label="ว่าง" />
                </HStack>
              </Card>
            ),
          )}
        </VStack>
      </Card>

      {finishedGames.length > 0 ? (
        <Card padding={4}>
          <VStack gap={3}>
            <VStack gap={0.5}>
              <Heading level={2}>เกมที่จบแล้ว ({finishedGames.length})</Heading>
              <Text type="supporting" size="sm">
                {canEditShuttles
                  ? 'แก้จำนวนลูกได้จนกว่าจะปิดรอบ — หลังปิดรอบแก้ไม่ได้'
                  : 'ปิดรอบไปแล้ว แก้จำนวนลูกไม่ได้'}
              </Text>
            </VStack>

            {canEditShuttles ? (
              <VStack gap={2}>
                {finishedGames.map((g) => (
                  <HStack key={g.id} gap={2} align="end">
                    <Text className="min-w-0 flex-1 pb-2" weight="semibold">
                      คอร์ท {g.courtNo}
                    </Text>
                    <VStack className="w-28">
                      <TextInput
                        label="ลูกที่ใช้"
                        size="sm"
                        value={corrections[g.id] ?? g.shuttlesUsed}
                        onChange={(v) => setCorrections((c) => ({ ...c, [g.id]: v }))}
                      />
                    </VStack>
                    <Button
                      size="sm"
                      label="บันทึก"
                      isDisabled={pending}
                      onClick={() => run(() => updateGameShuttles(g.id, corrections[g.id] ?? g.shuttlesUsed))}
                    />
                  </HStack>
                ))}
              </VStack>
            ) : (
              // หลังปิดรอบ: อ่านอย่างเดียว (ไม่มีช่องกรอกให้ลองกดแล้วโดนปฏิเสธ)
              <List hasDividers>
                {finishedGames.map((g) => (
                  <ListItem
                    key={g.id}
                    label={`คอร์ท ${g.courtNo}`}
                    endContent={<Badge label={`ลูก ${g.shuttlesUsed}`} />}
                  />
                ))}
              </List>
            )}
          </VStack>
        </Card>
      ) : null}

      {/* ───────── 27 · เวลาพัก ───────── */}
      <Card padding={4}>
        <VStack gap={3}>
          <VStack gap={0.5}>
            <Heading level={2}>คิวรอ ({idle.length})</Heading>
            <Text type="supporting" size="sm">
              เรียงตามคิวที่ระบบจัด · แสดงเวลาพักของแต่ละคน
            </Text>
          </VStack>

          <HStack gap={2} wrap="wrap">
            <Badge variant="success" label={`กำลังเล่น ${queue.length - idle.length} คน`} />
            <Badge label={`พักอยู่ ${idle.length} คน`} />
            {longest ? <Badge variant="warning" label={`พักนานสุด ${longest.minutes} นาที`} /> : null}
          </HStack>

          {idle.length === 0 ? (
            <Text type="supporting">ไม่มีคนรอ</Text>
          ) : (
            <List hasDividers>
              {idle.map((p) => {
                const minutes = restMinutes(p.waitingSince, now);
                const long = isLongRest(minutes);
                const isLongest = longest?.registrationId === p.registrationId;
                return (
                  <ListItem
                    key={p.registrationId}
                    label={p.isGuest ? `${p.displayName} (guest)` : p.displayName}
                    startContent={<Avatar name={p.displayName} size="sm" />}
                    description={
                      <VStack gap={1}>
                        <Text type="supporting" size="xsm">
                          เล่นแล้ว {p.gamesPlayed} เกม · {formatRest(minutes)}
                        </Text>
                        <ProgressBar
                          label={`${formatRest(minutes)}`}
                          isLabelHidden
                          value={restBarPercent(minutes)}
                          variant={long ? 'warning' : 'accent'}
                        />
                      </VStack>
                    }
                    endContent={
                      <HStack gap={2} align="center">
                        {isLongest ? <Badge variant="warning" label="พักนานสุด" /> : long ? <Badge variant="warning" label="พักนาน" /> : null}
                        {picked ? (
                          <Button
                            size="sm"
                            variant="primary"
                            label="สลับเข้ามา"
                            isDisabled={pending}
                            onClick={() => onSwapTarget(p.registrationId)}
                          />
                        ) : null}
                      </HStack>
                    }
                  />
                );
              })}
            </List>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}

function TeamColumn({
  game,
  slots,
  picked,
  pending,
  onPick,
  onSwapTarget,
}: {
  game: ConsoleGame;
  slots: number[];
  picked: Picked | null;
  pending: boolean;
  onPick: (v: Picked) => void;
  onSwapTarget: (registrationId: string) => void;
}) {
  return (
    <VStack gap={1} className="min-w-0 flex-1">
      {slots.map((slot) => {
        const player = game.players[slot - 1];
        const isPicked = picked?.gameId === game.id && picked.slot === slot;

        return (
          <Button
            key={slot}
            width="100%"
            variant={isPicked ? 'primary' : 'secondary'}
            label={player.displayName}
            isDisabled={pending}
            onClick={() =>
              picked && !isPicked ? onSwapTarget(player.registrationId) : onPick({ gameId: game.id, slot })
            }
          />
        );
      })}
    </VStack>
  );
}
