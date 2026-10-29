import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import {
  courtSlots,
  formatRest,
  isLongRest,
  longestRest,
  restMinutes,
} from "@/domain/play/rest-time";
import { BoardSync } from "@/features/sessions/BoardSync";
import { BoardTheme } from "@/features/sessions/BoardTheme";
import type { ConsoleData } from "@/server/sessions/console-loader";

/**
 * กระดานคิวสด (hi-fi 24) — **[WO-6.4a]** อ่านอย่างเดียว · ธีม navy · ตัวใหญ่อ่านได้จาก ~3 เมตร
 *
 * server component ล้วน (ไม่มีปุ่มแก้ไข ไม่มี server action) — ข้อมูลมาจาก `loadConsole()` ตัวเดียวกับคอนโซล
 * `BoardTheme` (Theme ซ้อน mode="dark") บังคับธีมมืดให้ทั้งกระดาน แม้เครื่องที่สนามตั้งเป็นโหมดสว่าง
 * (token ของ theme เป็น `light-dark()` ประกาศที่ root ⇒ พื้น = navy-950, ตัวหนังสือ = on-dark)
 */
export function LiveBoard({
  data,
  backHref,
}: {
  data: ConsoleData;
  backHref: string;
}) {
  return (
    <BoardTheme>
      <BoardBody data={data} backHref={backHref} />
    </BoardTheme>
  );
}

function BoardBody({
  data,
  backHref,
}: {
  data: ConsoleData;
  backHref: string;
}) {
  const { session, queue, games, now } = data;
  const idle = queue.filter((p) => p.current_game_id === null);
  const slots = courtSlots(session.courtCount, games);
  const longest = longestRest(
    idle.map((p) => ({
      registrationId: p.registration_id,
      waitingSince: p.waiting_since,
    })),
    now,
  );

  return (
    <VStack className="min-h-dvh w-full bg-body text-primary">
      {/* ≥1280px (จอทีวี/โน้ตบุ๊กที่ตั้งไว้ข้างสนาม): ขยายทั้งกระดาน ~30% ให้อ่านจากไกลได้ — ต่ำกว่านั้นขนาดเดิม */}
      <VStack gap={6} className="w-full p-6 xl:[zoom:1.3]">
        <HStack justify="between" align="center" gap={4} wrap="wrap">
          <VStack gap={1}>
            <Text type="supporting" size="sm">
              กระดานคิวสด
            </Text>
            <Heading level={1}>{session.title}</Heading>
          </VStack>
          <HStack gap={4} align="center" wrap="wrap">
            <BoardSync />
            <Button variant="secondary" label="กลับคอนโซล" href={backHref} />
          </HStack>
        </HStack>

        <VStack gap={3}>
          <Heading level={2}>
            คอร์ท ({games.length}/{session.courtCount})
          </Heading>
          <Grid columns={{ minWidth: 320, repeat: "fit" }} gap={4}>
            {slots.map(({ courtNo, game }) => (
              <Card key={courtNo} padding={5} aria-label={`คอร์ท ${courtNo}`}>
                <VStack gap={3}>
                  <HStack justify="between" align="center">
                    <Heading level={2}>คอร์ท {courtNo}</Heading>
                    {game ? (
                      <Badge variant="success" label="กำลังเล่น" />
                    ) : (
                      <Badge label="ว่าง" />
                    )}
                  </HStack>
                  {game ? (
                    <VStack gap={2}>
                      <Text size="2xl" weight="semibold" maxLines={1}>
                        {game.players[0].displayName} ·{" "}
                        {game.players[1].displayName}
                      </Text>
                      <Text type="supporting" size="lg">
                        พบกับ
                      </Text>
                      <Text size="2xl" weight="semibold" maxLines={1}>
                        {game.players[2].displayName} ·{" "}
                        {game.players[3].displayName}
                      </Text>
                    </VStack>
                  ) : (
                    <Text type="supporting" size="lg">
                      รอจัดคู่
                    </Text>
                  )}
                </VStack>
              </Card>
            ))}
          </Grid>
        </VStack>

        <VStack gap={3}>
          <HStack justify="between" align="center" wrap="wrap" gap={2}>
            <Heading level={2}>คิวถัดไป · {idle.length} คน</Heading>
            {longest ? (
              <Badge
                variant="warning"
                label={`พักนานสุด ${longest.minutes} นาที`}
              />
            ) : null}
          </HStack>

          {idle.length === 0 ? (
            <Text type="supporting" size="lg">
              ไม่มีคนรอ
            </Text>
          ) : (
            <Grid columns={{ minWidth: 280, repeat: "fit" }} gap={3}>
              {idle.map((p, index) => {
                const minutes = restMinutes(p.waiting_since, now);
                const isLongest = longest?.registrationId === p.registration_id;
                return (
                  <Card key={p.registration_id} padding={4}>
                    <HStack gap={3} align="center">
                      <Text size="2xl" weight="semibold" hasTabularNumbers>
                        {index + 1}
                      </Text>
                      <VStack gap={0.5} className="min-w-0 flex-1">
                        <Text size="xl" weight="semibold" maxLines={1}>
                          {p.display_name}
                          {p.is_guest ? " (guest)" : ""}
                        </Text>
                        <Text type="supporting" size="lg">
                          เล่นแล้ว {Number(p.games_played)} เกม ·{" "}
                          {formatRest(minutes)}
                        </Text>
                      </VStack>
                      {isLongest ? (
                        <Badge variant="warning" label="พักนานสุด" />
                      ) : isLongRest(minutes) ? (
                        <Badge variant="warning" label="พักนาน" />
                      ) : null}
                    </HStack>
                  </Card>
                );
              })}
            </Grid>
          )}
        </VStack>
      </VStack>
    </VStack>
  );
}
