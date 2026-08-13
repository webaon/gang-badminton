'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { TextInput } from '@astryxdesign/core/TextInput';

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

/**
 * คอนโซลวันเล่น
 *
 * 🔴 หน้านี้ **ไม่คำนวณการจับคู่เอง** — กด "จัดคู่รอบใหม่" แล้ว server action
 *    เรียก `domain/matching` ให้ (baseline: engine เป็น pure function ห้ามมี
 *    logic จับคู่ในคอมโพเนนต์)
 *
 * 🔴 แผนที่จัดแล้วถูกบันทึกลง `games` ⇒ **refresh แล้วไม่ถูก engine เขียนทับ**
 *    หน้าจอแสดงสิ่งที่อยู่ในฐานข้อมูลเสมอ ไม่ใช่ผลคำนวณสดของรอบนี้
 *
 * ⚠️ [D-19] "ลากสลับ" ทำเป็น **แตะเลือกแล้วแตะสลับ** ไม่ใช่ drag & drop
 *    baseline เขียนว่า "ลากสลับ" แต่แอปเป็น mobile-first และหน้านี้ใช้ตอนอยู่
 *    ข้างคอร์ทจริง — drag & drop บนมือถือพลาดง่ายและเข้าถึงยาก
 *    ผลลัพธ์เหมือนกันคือแอดมิน override ได้เสมอ
 */
export function GameConsole({
  sessionId,
  pendingCheckIn,
  games,
  finishedGames,
  queue,
  courtCount,
  canEditShuttles,
}: {
  sessionId: string;
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
  const [picked, setPicked] = useState<{ gameId: string; slot: number } | null>(null);
  /** ค่าที่กำลังแก้ของเกมที่จบแล้ว — key = gameId */
  const [corrections, setCorrections] = useState<Record<string, string>>({});

  async function run(fn: () => Promise<{ success: boolean; error?: { message: string } }>) {
    setPending(true);
    setError(null);
    const result = await fn();
    if (result.success) router.refresh();
    else setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');
    setPending(false);
    return result.success;
  }

  async function onSwapTarget(registrationId: string) {
    if (!picked) return;
    const ok = await run(() => substitutePlayer(picked.gameId, picked.slot, registrationId));
    if (ok) setPicked(null);
  }

  const idle = queue.filter((p) => p.currentGameId === null);

  return (
    <div className="flex flex-col gap-4">
      {error ? <Banner status="error" title={error} /> : null}

      {picked ? (
        <Banner
          status="info"
          title="เลือกคนที่จะสลับเข้ามา"
          description="แตะชื่อคนในคิวหรือในคอร์ทอื่น"
          endContent={<Button size="sm" label="ยกเลิก" onClick={() => setPicked(null)} />}
        />
      ) : null}

      {pendingCheckIn.length > 0 ? (
        <Card padding={4}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">รอเช็คอิน ({pendingCheckIn.length})</h2>
            {/*
              🔴 [WO-2.5-A] คนที่ได้ที่แต่ไม่เคยเช็คอิน ถูกคิดเงินเท่ากับคนไม่มา
                 วันที่แอดมินไม่ได้เปิดคอนโซล = ทุกคนโดนเก็บด้วยเหตุผลผิด
            */}
            <Button
              size="sm"
              label="เช็คอินทุกคน"
              isDisabled={pending}
              onClick={() => run(() => checkInEveryone(sessionId))}
            />
          </div>
          <ul className="divide-y">
            {pendingCheckIn.map((p) => (
              <li key={p.registrationId} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
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
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card padding={4}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">
            คอร์ท ({games.length}/{courtCount})
          </h2>
          <Button
            size="sm"
            variant="primary"
            label="จัดคู่รอบใหม่"
            isDisabled={pending || idle.length < 4}
            onClick={() => run(() => generateGames(sessionId))}
          />
        </div>

        {games.length === 0 ? (
          <p className="text-sm">ยังไม่มีเกมกำลังเล่น — กด “จัดคู่รอบใหม่” เมื่อมีคนว่างครบ 4 คน</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {games.map((game) => (
              <li key={game.id} className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-medium">คอร์ท {game.courtNo}</p>

                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <TeamColumn
                    game={game}
                    slots={[1, 2]}
                    picked={picked}
                    pending={pending}
                    onPick={setPicked}
                    onSwapTarget={onSwapTarget}
                  />
                  <span className="text-xs opacity-60">vs</span>
                  <TeamColumn
                    game={game}
                    slots={[3, 4]}
                    picked={picked}
                    pending={pending}
                    onPick={setPicked}
                    onSwapTarget={onSwapTarget}
                  />
                </div>

                <div className="mt-3 flex items-end gap-2">
                  <div className="w-32">
                    <TextInput
                      label="ลูกที่ใช้"
                      size="sm"
                      value={shuttles[game.id] ?? ''}
                      onChange={(v) => setShuttles((s) => ({ ...s, [game.id]: v }))}
                      placeholder="เช่น 1.5"
                    />
                  </div>
                  <Button
                    size="sm"
                    label="จบเกม"
                    isDisabled={pending}
                    onClick={() => run(() => finishGame(game.id, shuttles[game.id] || '0'))}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {finishedGames.length > 0 ? (
        <Card padding={4}>
          <h2 className="mb-1 text-base font-semibold">เกมที่จบแล้ว ({finishedGames.length})</h2>
          <p className="mb-3 text-sm opacity-70">
            {canEditShuttles
              ? 'แก้จำนวนลูกได้จนกว่าจะปิดรอบ — หลังปิดรอบแก้ไม่ได้'
              : 'ปิดรอบไปแล้ว แก้จำนวนลูกไม่ได้'}
          </p>
          <ul className="flex flex-col gap-2">
            {finishedGames.map((g) => (
              <li key={g.id} className="flex items-end gap-2">
                <span className="mb-2 min-w-0 flex-1 truncate text-sm">คอร์ท {g.courtNo}</span>
                <div className="w-28">
                  <TextInput
                    label="ลูกที่ใช้"
                    size="sm"
                    isDisabled={!canEditShuttles}
                    value={corrections[g.id] ?? g.shuttlesUsed}
                    onChange={(v) => setCorrections((c) => ({ ...c, [g.id]: v }))}
                  />
                </div>
                <Button
                  size="sm"
                  label="บันทึก"
                  isDisabled={pending || !canEditShuttles}
                  onClick={() =>
                    run(() => updateGameShuttles(g.id, corrections[g.id] ?? g.shuttlesUsed))
                  }
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card padding={4}>
        <h2 className="mb-3 text-base font-semibold">คิวรอ ({idle.length})</h2>
        {idle.length === 0 ? (
          <p className="text-sm">ไม่มีคนรอ</p>
        ) : (
          <ul className="divide-y">
            {idle.map((p) => (
              <li key={p.registrationId} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">
                  {p.displayName}
                  {p.isGuest ? <span className="ml-2 text-xs">(guest)</span> : null}
                </span>
                <Badge label={`${p.gamesPlayed} เกม`} />
                {picked ? (
                  <Button
                    size="sm"
                    variant="primary"
                    label="สลับเข้ามา"
                    isDisabled={pending}
                    onClick={() => onSwapTarget(p.registrationId)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
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
  picked: { gameId: string; slot: number } | null;
  pending: boolean;
  onPick: (v: { gameId: string; slot: number }) => void;
  onSwapTarget: (registrationId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {slots.map((slot) => {
        const player = game.players[slot - 1];
        const isPicked = picked?.gameId === game.id && picked.slot === slot;

        return (
          <button
            key={slot}
            type="button"
            disabled={pending}
            onClick={() =>
              picked && !isPicked
                ? onSwapTarget(player.registrationId)
                : onPick({ gameId: game.id, slot })
            }
            className={`truncate rounded-md border p-2 text-left text-sm ${
              isPicked ? 'border-2 font-semibold' : ''
            }`}
          >
            {player.displayName}
          </button>
        );
      })}
    </div>
  );
}
