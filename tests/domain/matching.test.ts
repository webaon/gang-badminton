/**
 * WO-2.6 DoD — Matching Engine ครบ 4 ข้อตาม baseline §Verification
 *
 *   1. เล่นน้อย + รอนานได้ลงก่อน
 *   2. skill ใกล้กันถูกจับคู่กัน
 *   3. ไม่ซ้ำ 4 คนเดิมติดกัน
 *   4. คนไม่หาร 4 ลงตัว จัดได้โดยไม่ทิ้งใครค้างถาวร
 *
 * pure unit test — ไม่แตะ DB ไม่ mock อะไรเลย
 */
import { describe, it, expect } from 'vitest';
import {
  assignCourts,
  avoidRepeat,
  balanceSkill,
  buildQueue,
  planMatches,
} from '@/domain/matching/pipeline';
import type { MatchPlayer } from '@/domain/matching/types';

function player(
  id: string,
  overrides: Partial<Omit<MatchPlayer, 'registrationId'>> = {},
): MatchPlayer {
  return {
    registrationId: id,
    // ⚠️ ห้ามใช้ `?? 2` ตรงนี้ — `null` เป็นค่าที่มีความหมาย ("ยังไม่จัดระดับ")
    //    `null ?? 2` จะกลายเป็น 2 ⇒ เคสคนไม่มีระดับจะไม่เคยถูกทดสอบเลย
    skillRank: 'skillRank' in overrides ? (overrides.skillRank as number | null) : 2,
    gamesPlayed: overrides.gamesPlayed ?? 0,
    waitingSince: overrides.waitingSince ?? 0,
  };
}

/** ผู้เล่น n คน ชื่อ p01..pNN ฝีมือวนตามที่กำหนด */
function roster(n: number, skills: number[] = [1, 2, 3]): MatchPlayer[] {
  return Array.from({ length: n }, (_, i) =>
    player(`p${String(i + 1).padStart(2, '0')}`, { skillRank: skills[i % skills.length] }),
  );
}

describe('DoD 1 — เล่นน้อยก่อน แล้วรอนานก่อน', () => {
  it('คนที่เล่นน้อยกว่าอยู่หัวคิวเสมอ แม้จะเพิ่งมา', () => {
    const queue = buildQueue([
      player('เล่นเยอะ', { gamesPlayed: 5, waitingSince: 0 }),
      player('เล่นน้อย', { gamesPlayed: 1, waitingSince: 999 }),
      player('ยังไม่เล่น', { gamesPlayed: 0, waitingSince: 999 }),
    ]);

    expect(queue.map((p) => p.registrationId)).toEqual(['ยังไม่เล่น', 'เล่นน้อย', 'เล่นเยอะ']);
  });

  it('เล่นเท่ากัน → คนที่รอนานกว่าได้ก่อน', () => {
    const queue = buildQueue([
      player('รอสั้น', { gamesPlayed: 2, waitingSince: 500 }),
      player('รอนาน', { gamesPlayed: 2, waitingSince: 100 }),
    ]);

    expect(queue.map((p) => p.registrationId)).toEqual(['รอนาน', 'รอสั้น']);
  });

  it('เท่ากันทุกอย่าง → เรียงคงที่ (deterministic)', () => {
    const players = [player('b'), player('a'), player('c')];
    expect(buildQueue(players).map((p) => p.registrationId)).toEqual(['a', 'b', 'c']);
    // เรียกซ้ำด้วย input ลำดับต่างกัน ต้องได้ผลเดิม
    expect(buildQueue([...players].reverse()).map((p) => p.registrationId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('🔴 คนที่เล่นน้อยที่สุดต้องได้ลงจริงในแผน ไม่ใช่แค่อยู่หัวคิว', () => {
    const players = [
      ...roster(4).map((p) => ({ ...p, gamesPlayed: 3 })),
      player('คนใหม่', { gamesPlayed: 0 }),
    ];

    const plan = planMatches({ players, availableCourts: 1 });
    const playing = plan.games.flatMap((g) => g.players);

    expect(playing).toContain('คนใหม่');
    expect(plan.benched).toHaveLength(1);
  });
});

describe('DoD 2 — skill ใกล้กันถูกจับคู่กัน', () => {
  it('มือใหม่อยู่คอร์ทเดียวกัน มือหนักอยู่อีกคอร์ท', () => {
    const players = [
      player('ใหม่1', { skillRank: 1 }),
      player('หนัก1', { skillRank: 3 }),
      player('ใหม่2', { skillRank: 1 }),
      player('หนัก2', { skillRank: 3 }),
      player('ใหม่3', { skillRank: 1 }),
      player('หนัก3', { skillRank: 3 }),
      player('ใหม่4', { skillRank: 1 }),
      player('หนัก4', { skillRank: 3 }),
    ];

    const foursomes = balanceSkill(players);
    expect(foursomes).toHaveLength(2);

    const [groupA, groupB] = foursomes.map((f) => [...f].sort());
    expect(groupA.every((id) => id.startsWith('ใหม่'))).toBe(true);
    expect(groupB.every((id) => id.startsWith('หนัก'))).toBe(true);
  });

  it('ช่วงฝีมือในแต่ละคอร์ทต้องแคบที่สุดเท่าที่ทำได้', () => {
    const players = [1, 1, 2, 2, 3, 3, 4, 4].map((rank, i) =>
      player(`p${i}`, { skillRank: rank }),
    );
    const skillOf = new Map(players.map((p) => [p.registrationId, p.skillRank as number]));

    for (const group of balanceSkill(players)) {
      const ranks = group.map((id) => skillOf.get(id)!);
      // แต่ละคอร์ทต่างกันไม่เกิน 1 ระดับ
      expect(Math.max(...ranks) - Math.min(...ranks)).toBeLessThanOrEqual(1);
    }
  });

  it('🔴 คนที่ยังไม่จัดระดับใช้ค่ากลาง ไม่ถูกเหมาว่าเป็นมือใหม่', () => {
    // ค่ากลางของกลุ่มนี้คือ 10 (จาก 9,9,9,10,10,10,10)
    //   - ถ้าใช้ค่ากลาง → 'z-ไม่รู้' ไปอยู่กลุ่มมือ 10
    //   - ถ้าเหมาเป็น 0  → จะถูกดันไปอยู่หัวลิสต์ = กลุ่มมือ 9
    // ตั้งชื่อขึ้นต้นด้วย z เพื่อให้แพ้ tie-break เสมอ ⇒ ผลลัพธ์ไม่กำกวม
    const players = [
      player('a-9-1', { skillRank: 9 }),
      player('a-9-2', { skillRank: 9 }),
      player('a-9-3', { skillRank: 9 }),
      player('b-10-1', { skillRank: 10 }),
      player('b-10-2', { skillRank: 10 }),
      player('b-10-3', { skillRank: 10 }),
      player('b-10-4', { skillRank: 10 }),
      player('z-ไม่รู้', { skillRank: null }),
    ];

    const groups = balanceSkill(players);
    const withUnranked = groups.find((g) => g.includes('z-ไม่รู้'))!;

    expect(withUnranked.filter((id) => id.startsWith('b-10')).length).toBe(3);
    expect(withUnranked.some((id) => id.startsWith('a-9'))).toBe(false);
  });
});

describe('DoD 3 — ไม่ซ้ำ 4 คนเดิมติดกัน', () => {
  it('กลุ่มที่ซ้ำกับเกมล่าสุดถูกสลับให้ต่างออกไป', () => {
    const foursomes = [
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
    ] as unknown as Parameters<typeof avoidRepeat>[0];

    const result = avoidRepeat(foursomes, [['a', 'b', 'c', 'd']]);

    const keys = result.map((f) => [...f].sort().join('|'));
    expect(keys).not.toContain('a|b|c|d');
    // ต้องยังมีสองกลุ่ม กลุ่มละ 4 คน และไม่มีใครหายหรือซ้ำ
    expect(result).toHaveLength(2);
    expect(result.flatMap((f) => f).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('สลับแล้วต้องไม่สร้างการซ้ำอันใหม่ขึ้นมาแทน', () => {
    const foursomes = [
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
    ] as unknown as Parameters<typeof avoidRepeat>[0];

    const recent = [
      ['a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'e'], // ทางเลือกที่ชัดที่สุดถูกปิดไว้
    ];

    const keys = avoidRepeat(foursomes, recent).map((f) => [...f].sort().join('|'));
    expect(keys).not.toContain('a|b|c|d');
    expect(keys).not.toContain('a|b|c|e');
  });

  it('คอร์ทเดียว สลับกับใครไม่ได้ → คืนของเดิม ไม่ทำให้แผนพัง', () => {
    const one = [['a', 'b', 'c', 'd']] as unknown as Parameters<typeof avoidRepeat>[0];
    expect(avoidRepeat(one, [['a', 'b', 'c', 'd']])).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('ไม่มีประวัติ → ไม่แตะแผน', () => {
    const foursomes = [
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
    ] as unknown as Parameters<typeof avoidRepeat>[0];
    expect(avoidRepeat(foursomes, [])).toEqual(foursomes);
  });

  it('เล่นต่อกันหลายรอบใน 8 คน → ไม่มีชุดสี่คนเดิมซ้ำติดกัน', () => {
    let players = roster(8, [1, 1, 2, 2, 3, 3, 4, 4]);
    const history: string[][] = [];

    for (let round = 0; round < 6; round++) {
      const plan = planMatches({
        players,
        availableCourts: 2,
        recentGames: history.slice(0, 2),
      });

      const keys = plan.games.map((g) => [...g.players].sort().join('|'));
      const previous = history.slice(0, 2).map((g) => [...g].sort().join('|'));

      for (const key of keys) {
        expect(previous, `รอบ ${round} จับชุดเดิมซ้ำ`).not.toContain(key);
      }

      history.unshift(...plan.games.map((g) => [...g.players]));

      const playing = new Set(plan.games.flatMap((g) => g.players));
      players = players.map((p) =>
        playing.has(p.registrationId)
          ? { ...p, gamesPlayed: p.gamesPlayed + 1, waitingSince: round + 1 }
          : p,
      );
    }
  });
});

describe('DoD 4 — คนไม่หาร 4 ลงตัว ไม่มีใครค้างถาวร', () => {
  it('10 คน 2 คอร์ท → ลง 8 พัก 2 ครบถ้วนไม่มีใครหาย', () => {
    const plan = planMatches({ players: roster(10), availableCourts: 2 });

    expect(plan.games).toHaveLength(2);
    expect(plan.benched).toHaveLength(2);

    const everyone = [...plan.games.flatMap((g) => g.players), ...plan.benched].sort();
    expect(everyone).toHaveLength(10);
    expect(new Set(everyone).size, 'มีคนถูกจัดซ้ำสองคอร์ท').toBe(10);
  });

  it('6 คน 2 คอร์ท → จัดได้แค่ 1 เกม (ไม่ยัดคอร์ทที่คนไม่ครบ)', () => {
    const plan = planMatches({ players: roster(6), availableCourts: 2 });
    expect(plan.games).toHaveLength(1);
    expect(plan.benched).toHaveLength(2);
  });

  it('คนน้อยกว่า 4 → ไม่มีเกม ทุกคนพัก', () => {
    const plan = planMatches({ players: roster(3), availableCourts: 2 });
    expect(plan.games).toHaveLength(0);
    expect(plan.benched).toHaveLength(3);
  });

  it('🔴 เล่น 12 รอบด้วย 10 คน → ทุกคนได้ลง และจำนวนเกมต่างกันไม่เกิน 1', () => {
    // นี่คือข้อที่พิสูจน์ว่า "ไม่ทิ้งใครค้างถาวร" จริง
    let players = roster(10);

    for (let round = 0; round < 12; round++) {
      const plan = planMatches({ players, availableCourts: 2 });
      const playing = new Set(plan.games.flatMap((g) => g.players));

      players = players.map((p) =>
        playing.has(p.registrationId)
          ? { ...p, gamesPlayed: p.gamesPlayed + 1, waitingSince: round + 1 }
          : p,
      );
    }

    const counts = players.map((p) => p.gamesPlayed);
    expect(Math.min(...counts), 'มีคนไม่ได้ลงเลย').toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts), 'จำนวนเกมเหลื่อมกันเกินไป').toBeLessThanOrEqual(1);
  });

  it('คอร์ทไม่พอ → จำกัดตามคอร์ท ไม่ใช่ตามจำนวนคน', () => {
    const plan = planMatches({ players: roster(20), availableCourts: 3 });
    expect(plan.games).toHaveLength(3);
    expect(plan.benched).toHaveLength(8);
  });

  it('ไม่มีคอร์ทว่าง → ไม่มีเกม', () => {
    const plan = planMatches({ players: roster(8), availableCourts: 0 });
    expect(plan.games).toHaveLength(0);
    expect(plan.benched).toHaveLength(8);
  });
});

describe('assignCourts + ความคงที่ของผลลัพธ์', () => {
  it('เลขคอร์ทเริ่มที่ 1 และไม่ซ้ำ', () => {
    const games = assignCourts([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
    ] as unknown as Parameters<typeof assignCourts>[0]);

    expect(games.map((g) => g.courtNo)).toEqual([1, 2]);
  });

  it('🔴 input เดียวกัน (สลับลำดับ) → แผนเดียวกันเสมอ', () => {
    const players = roster(12, [1, 2, 3, 4]);

    const a = planMatches({ players, availableCourts: 3 });
    const b = planMatches({ players: [...players].reverse(), availableCourts: 3 });

    expect(a).toEqual(b);
  });
});
