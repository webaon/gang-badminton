/**
 * Matching Engine — pipeline
 *
 *   Queue → SelectPlayers → BalanceSkill → AvoidRepeat → PairTeams → CourtAssignment
 *
 * (baseline ระบุ 5 ขั้น — `PairTeams` เพิ่มเข้ามาตาม **ADR-003** เพราะ baseline
 *  ไม่เคยระบุว่าใครคู่กับใครในคอร์ท ทั้งที่ `games` มีช่องผู้เล่น 4 ช่องเรียงกัน
 *  pipeline ออกแบบมาให้เสียบขั้นเพิ่มได้อยู่แล้ว จึงไม่ต้องรื้อของเดิม)
 *
 * ทุกขั้นเป็น pure function แยกกัน (baseline §สถาปัตยกรรม) ⇒ เสียบขั้นใหม่เพิ่มได้
 * โดยไม่ต้องรื้อของเดิม และทดสอบทีละขั้นได้
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ผลลัพธ์ต้อง **deterministic**
 *
 * input เดียวกันต้องได้แผนเดียวกันเสมอ — ทุกการเรียงมีตัวตัดสินสุดท้ายเป็น
 * `registrationId` ⇒ ไม่มีการสุ่ม ไม่ขึ้นกับลำดับที่ข้อมูลมาจาก DB
 *
 * เหตุผล: แอดมินลากสลับคู่แล้วหน้าจอ refresh ต้องไม่เห็นคู่เปลี่ยนเอง
 * (baseline: "แอดมินลากสลับ override ได้เสมอ")
 *
 * ⚠️ ไม่มี Constraint stage (คู่ห้ามเจอกัน/tag) — baseline §ADR "ไม่รับ" ระบุว่า
 *    ต้นทุนจริงคือ data model ของ constraint ไม่ใช่ engine ⇒ รอจนมีก๊วนต้องการจริง
 */
import type { Foursome, MatchInput, MatchPlan, MatchPlayer, PlannedGame } from './types';

const PLAYERS_PER_GAME = 4;

// ---------------------------------------------------------------------------
// ขั้นที่ 1 — Queue
// ---------------------------------------------------------------------------

/**
 * เรียงคิว: **เล่นน้อยก่อน → รอนานก่อน**
 *
 * ลำดับนี้คือหัวใจของความยุติธรรมทั้งระบบ — คนที่ยังไม่ได้เล่นต้องได้ลงก่อน
 * คนที่เพิ่งลงไป ไม่ว่าจะฝีมือดีแค่ไหน
 */
export function buildQueue(players: readonly MatchPlayer[]): MatchPlayer[] {
  return [...players].sort(
    (a, b) =>
      a.gamesPlayed - b.gamesPlayed ||
      a.waitingSince - b.waitingSince ||
      // ตัวตัดสินสุดท้ายเพื่อให้ผลคงที่เสมอ
      a.registrationId.localeCompare(b.registrationId),
  );
}

// ---------------------------------------------------------------------------
// ขั้นที่ 2 — SelectPlayers
// ---------------------------------------------------------------------------

/**
 * หยิบคนจากหัวคิวเท่าที่จัดเกมได้จริง
 *
 * 🔴 หยิบเป็นจำนวนที่หาร 4 ลงตัวเท่านั้น — เศษที่เหลือนั่งพักรอบนี้
 *    แต่ไม่ได้ถูกทิ้งถาวร เพราะ `gamesPlayed` ของเขาไม่เพิ่ม
 *    ⇒ รอบหน้าเขาจะอยู่หัวคิวโดยอัตโนมัติ (ดูเทสต์ "ไม่มีใครค้างถาวร")
 */
export function selectPlayers(
  queue: readonly MatchPlayer[],
  availableCourts: number,
): { selected: MatchPlayer[]; benched: MatchPlayer[] } {
  const courts = Math.max(0, Math.floor(availableCourts));
  const capacity = courts * PLAYERS_PER_GAME;
  const playable = Math.min(queue.length - (queue.length % PLAYERS_PER_GAME), capacity);

  return {
    selected: queue.slice(0, playable),
    benched: queue.slice(playable),
  };
}

// ---------------------------------------------------------------------------
// ขั้นที่ 3 — BalanceSkill
// ---------------------------------------------------------------------------

/**
 * ค่าฝีมือที่ใช้คำนวณ — คนที่ยังไม่จัดระดับใช้ค่ากลางของกลุ่ม
 *
 * ทำไมไม่ใช้ 0: ถ้าให้ 0 คนที่ยังไม่จัดระดับจะไปกองรวมกับมือใหม่ทั้งหมด
 * ซึ่งเป็นการเดาที่แรงเกินไป — ค่ากลางแปลว่า "ไม่รู้" ได้ตรงกว่า
 */
function effectiveSkill(player: MatchPlayer, fallback: number): number {
  return player.skillRank ?? fallback;
}

function medianSkill(players: readonly MatchPlayer[]): number {
  const ranked = players
    .map((p) => p.skillRank)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);

  if (ranked.length === 0) return 0;
  const mid = Math.floor(ranked.length / 2);
  return ranked.length % 2 === 0 ? (ranked[mid - 1] + ranked[mid]) / 2 : ranked[mid];
}

/**
 * จัดคนที่เลือกมาแล้วให้ฝีมือใกล้กันอยู่ก๊วนเดียวกัน
 *
 * วิธี: เรียงตามฝีมือแล้วหั่นทีละ 4 — คนที่ฝีมือใกล้กันจะติดกันในลิสต์อยู่แล้ว
 * เรียบง่ายและได้ผลดีกว่าที่คิด เพราะกลุ่มที่เลือกมามีขนาดเล็ก (คอร์ทละ 4)
 */
export function balanceSkill(selected: readonly MatchPlayer[]): Foursome[] {
  const fallback = medianSkill(selected);

  const bySkill = [...selected].sort(
    (a, b) =>
      effectiveSkill(a, fallback) - effectiveSkill(b, fallback) ||
      a.registrationId.localeCompare(b.registrationId),
  );

  const foursomes: Foursome[] = [];
  for (let i = 0; i + PLAYERS_PER_GAME <= bySkill.length; i += PLAYERS_PER_GAME) {
    const chunk = bySkill.slice(i, i + PLAYERS_PER_GAME).map((p) => p.registrationId);
    foursomes.push(chunk as unknown as Foursome);
  }
  return foursomes;
}

// ---------------------------------------------------------------------------
// ขั้นที่ 4 — AvoidRepeat
// ---------------------------------------------------------------------------

/** คีย์ของกลุ่มผู้เล่นที่ไม่สนใจลำดับ */
function groupKey(players: readonly string[]): string {
  return [...players].sort().join('|');
}

/**
 * แก้กลุ่มที่ซ้ำกับเกมล่าสุด ด้วยการสลับคนข้ามคอร์ท
 *
 * 🔴 "ไม่ซ้ำ 4 คนเดิม" หมายถึงชุดสี่คนเดิมทั้งชุด ไม่ใช่ห้ามเจอคนเดิมเลย
 *    (ในก๊วน 8 คน ห้ามเจอคนเดิมเลยเป็นไปไม่ได้)
 *
 * ถ้ามีคอร์ทเดียวก็สลับกับใครไม่ได้ ⇒ คืนของเดิม — engine ไม่ควรทำให้แผนแย่ลง
 * เพียงเพื่อเลี่ยงการซ้ำที่เลี่ยงไม่ได้จริงๆ
 */
export function avoidRepeat(
  foursomes: readonly Foursome[],
  recentGames: readonly (readonly string[])[] = [],
): Foursome[] {
  if (foursomes.length < 2 || recentGames.length === 0) return [...foursomes];

  const recent = new Set(recentGames.map(groupKey));
  const result = foursomes.map((f) => [...f] as string[]);

  for (let a = 0; a < result.length; a++) {
    if (!recent.has(groupKey(result[a]))) continue;

    let fixed = false;

    for (let b = 0; b < result.length && !fixed; b++) {
      if (a === b) continue;

      for (let i = 0; i < PLAYERS_PER_GAME && !fixed; i++) {
        for (let j = 0; j < PLAYERS_PER_GAME && !fixed; j++) {
          const candidateA = [...result[a]];
          const candidateB = [...result[b]];
          [candidateA[i], candidateB[j]] = [candidateB[j], candidateA[i]];

          // สลับแล้วต้องไม่สร้างการซ้ำอันใหม่ขึ้นมาแทน
          if (!recent.has(groupKey(candidateA)) && !recent.has(groupKey(candidateB))) {
            result[a] = candidateA;
            result[b] = candidateB;
            fixed = true;
          }
        }
      }
    }
    // สลับยังไงก็ยังซ้ำ = ยอมรับตามเดิม ดีกว่าไม่จัดเกมให้เล่น
  }

  return result.map((players) => players as unknown as Foursome);
}

// ---------------------------------------------------------------------------
// ขั้นที่ 5 — PairTeams  [ADR-003]
// ---------------------------------------------------------------------------

/**
 * แบ่งทีมภายในคอร์ท: **มือแข็งสุดคู่กับมืออ่อนสุด**
 *
 * 🔴 ข้อตกลงที่ต้องยึดทั้งระบบ (ADR-003):
 *    `players[0] & players[1]` = ทีม A · `players[2] & players[3]` = ทีม B
 *    ตรงกับคอลัมน์ `games.player1..player4`
 *
 * เหตุผลของการจับแข็ง+อ่อน: ทำให้ผลรวมฝีมือสองฝั่งใกล้กันที่สุด ⇒ เกมสูสี
 * และมือใหม่ได้เล่นกับมือเก่า ซึ่งเป็นวิธีที่ก๊วนจริงใช้กัน
 *
 * ⚠️ ต้องรันขั้นนี้ **หลัง** `avoidRepeat` — ถ้าจัดทีมก่อน การสลับคนข้ามคอร์ท
 *    เพื่อเลี่ยงคู่ซ้ำจะทำลายสมดุลทีมที่เพิ่งจัดไป
 */
export function pairTeams(
  foursomes: readonly Foursome[],
  players: readonly MatchPlayer[],
): Foursome[] {
  const fallback = medianSkill(players);
  const skillOf = new Map(players.map((p) => [p.registrationId, effectiveSkill(p, fallback)]));

  return foursomes.map((foursome) => {
    const bySkill = [...foursome].sort(
      (a, b) => (skillOf.get(a) ?? 0) - (skillOf.get(b) ?? 0) || a.localeCompare(b),
    );

    // [อ่อนสุด, กลาง1, กลาง2, แข็งสุด] → ทีม A = อ่อนสุด+แข็งสุด · ทีม B = สองคนกลาง
    return [bySkill[0], bySkill[3], bySkill[1], bySkill[2]] as unknown as Foursome;
  });
}

/**
 * อ่านทีมออกจากผลลัพธ์ — ใช้ตัวนี้แทนการ index เอง
 *
 * ทุกที่ที่ต้องรู้ว่าใครอยู่ฝั่งไหน (UI, การเขียนลง `games`) ต้องเรียกผ่านนี้
 * ⇒ ถ้าวันหนึ่งข้อตกลงเปลี่ยน แก้ที่เดียว
 */
export function teamsOf(players: Foursome): { teamA: [string, string]; teamB: [string, string] } {
  return {
    teamA: [players[0], players[1]],
    teamB: [players[2], players[3]],
  };
}


// ---------------------------------------------------------------------------
// ขั้นที่ 6 — CourtAssignment
// ---------------------------------------------------------------------------

/** ใส่เลขคอร์ทให้แต่ละกลุ่ม เริ่มที่ 1 */
export function assignCourts(foursomes: readonly Foursome[]): PlannedGame[] {
  return foursomes.map((players, index) => ({ courtNo: index + 1, players }));
}

// ---------------------------------------------------------------------------
// ประกอบทั้ง pipeline
// ---------------------------------------------------------------------------

export function planMatches(input: MatchInput): MatchPlan {
  const queue = buildQueue(input.players);
  const { selected, benched } = selectPlayers(queue, input.availableCourts);
  const balanced = balanceSkill(selected);
  const deduped = avoidRepeat(balanced, input.recentGames);
  // จัดทีมเป็นขั้นสุดท้ายก่อนใส่เลขคอร์ท — หลังการสลับเพื่อเลี่ยงคู่ซ้ำเรียบร้อยแล้ว
  const paired = pairTeams(deduped, selected);

  return {
    games: assignCourts(paired),
    benched: benched.map((p) => p.registrationId),
  };
}
