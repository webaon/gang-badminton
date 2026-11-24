import { describe, expect, it } from 'vitest';

import {
  bucketSessions,
  buildRoster,
  duplicateGuestRowIds,
  fillPercent,
  normalizeName,
  pickFeatured,
  primaryAction,
  seatsLeft,
  waitlistPosition,
  type RosterRow,
} from '@/domain/sessions/member-view';

const row = (id: string, status: string, ordering: number, userId: string | null = id, name = id): RosterRow => ({
  id,
  userId,
  name,
  status,
  ordering,
});

describe('buildRoster / waitlistPosition', () => {
  it('คนที่ได้ที่ (ordering = 0 ทั้งหมดใน DB) เรียงตามเวลาลงชื่อ ไม่ใช่ ordering', () => {
    const at = (id: string, registeredAt: string): RosterRow => ({ ...row(id, 'confirmed', 0), registeredAt });
    const roster = buildRoster([
      at('late', '2026-08-01T10:05:00Z'),
      at('first', '2026-08-01T10:00:00Z'),
      at('mid', '2026-08-01T10:03:00Z'),
    ]);
    expect(roster.seated.map((r) => r.id)).toEqual(['first', 'mid', 'late']);
  });

  it('แยก seated กับ waitlist ตาม ordering และตัด cancelled/no_show ทิ้ง', () => {
    const roster = buildRoster([
      row('c', 'waitlist', 30),
      row('a', 'confirmed', 10),
      row('x', 'cancelled', 1),
      row('b', 'checked_in', 20),
      row('d', 'waitlist', 25),
      row('n', 'no_show', 2),
    ]);
    expect(roster.seated.map((r) => r.id)).toEqual(['a', 'b']);
    expect(roster.waitlist.map((r) => r.id)).toEqual(['d', 'c']);
    expect(waitlistPosition(roster, 'd')).toBe(1);
    expect(waitlistPosition(roster, 'c')).toBe(2);
    expect(waitlistPosition(roster, 'a')).toBeNull();
  });
});

describe('primaryAction — ปุ่มหลักเดียวตามสถานะของฉัน', () => {
  const full = buildRoster([row('a', 'confirmed', 1), row('b', 'confirmed', 2), row('w', 'waitlist', 3)]);
  const open = buildRoster([row('a', 'confirmed', 1)]);

  it('ยังไม่ได้ลง + มีที่ → register', () => {
    expect(primaryAction({ roster: open, mine: null, maxPlayers: 2, sessionOpen: true, canRegister: true })).toEqual({
      kind: 'register',
    });
  });

  it('นัดเต็ม (ได้ที่ครบ) → join_waitlist บอกลำดับถัดไป', () => {
    expect(primaryAction({ roster: full, mine: null, maxPlayers: 2, sessionOpen: true, canRegister: true })).toEqual({
      kind: 'join_waitlist',
      nextPosition: 2,
    });
  });

  it('ลงแล้วได้ที่ → cancel พร้อมลำดับที่', () => {
    expect(
      primaryAction({ roster: full, mine: { id: 'b', status: 'confirmed' }, maxPlayers: 2, sessionOpen: true, canRegister: true }),
    ).toEqual({ kind: 'cancel', seat: 2 });
  });

  it('อยู่ในคิว → cancel_waitlist บอกลำดับ', () => {
    expect(
      primaryAction({ roster: full, mine: { id: 'w', status: 'waitlist' }, maxPlayers: 2, sessionOpen: true, canRegister: true }),
    ).toEqual({ kind: 'cancel_waitlist', position: 1 });
  });

  it('ลงแล้วยังยกเลิกได้แม้นัดไม่ open (เช่น in_play) — ปุ่มยังเป็น cancel (server ตัดสินจริง)', () => {
    expect(
      primaryAction({ roster: open, mine: { id: 'a', status: 'confirmed' }, maxPlayers: 2, sessionOpen: false, canRegister: false }),
    ).toMatchObject({ kind: 'cancel' });
  });

  it('นัดไม่เปิด / ไม่มีสิทธิ์ → none พร้อมเหตุผล และ "ไม่มีปุ่มลงชื่อ"', () => {
    expect(primaryAction({ roster: open, mine: null, maxPlayers: 2, sessionOpen: false, canRegister: true })).toEqual({
      kind: 'none',
      reason: 'not_open',
    });
    expect(primaryAction({ roster: open, mine: null, maxPlayers: 2, sessionOpen: true, canRegister: false })).toEqual({
      kind: 'none',
      reason: 'no_permission',
    });
  });

  it('แถวของฉันที่ cancelled ไม่นับว่าลงอยู่ (หน้าส่ง mine=null ให้ แต่กันไว้ด้วย)', () => {
    expect(
      primaryAction({ roster: open, mine: { id: 'z', status: 'cancelled' }, maxPlayers: 2, sessionOpen: true, canRegister: true }),
    ).toEqual({ kind: 'register' });
  });
});

describe('ตัวเลขที่ว่าง', () => {
  it('seatsLeft ไม่ติดลบ · fillPercent จำกัด 0–100', () => {
    expect(seatsLeft(14, 16)).toBe(2);
    expect(seatsLeft(20, 16)).toBe(0);
    expect(fillPercent(8, 16)).toBe(50);
    expect(fillPercent(20, 16)).toBe(100);
    expect(fillPercent(3, 0)).toBe(0);
  });
});

describe('duplicateGuestRowIds — เตือนชื่อ guest ซ้ำ (UI เท่านั้น)', () => {
  it('guest "Ford" 3 แถว (พิมพ์เล็กใหญ่/ช่องว่างต่างกัน) ถูกจับทั้ง 3', () => {
    const rows = [
      row('g1', 'confirmed', 1, null, 'Ford'),
      row('g2', 'confirmed', 2, null, ' ford '),
      row('g3', 'waitlist', 3, null, 'FORD'),
      row('m1', 'confirmed', 4, 'u1', 'ฟ้า'),
    ];
    expect([...duplicateGuestRowIds(rows)].sort()).toEqual(['g1', 'g2', 'g3']);
  });

  it('guest ชื่อซ้ำกับสมาชิก → เตือนทั้งคู่', () => {
    const rows = [row('m', 'confirmed', 1, 'u', 'เอิร์ธ'), row('g', 'confirmed', 2, null, 'เอิร์ธ')];
    expect([...duplicateGuestRowIds(rows)].sort()).toEqual(['g', 'm']);
  });

  it('สมาชิกชื่อเล่นซ้ำกันเอง (ไม่มี guest) ไม่เตือน', () => {
    const rows = [row('a', 'confirmed', 1, 'u1', 'บอส'), row('b', 'confirmed', 2, 'u2', 'บอส')];
    expect(duplicateGuestRowIds(rows).size).toBe(0);
  });

  it('แถวที่ยกเลิกแล้วไม่นับ', () => {
    const rows = [row('g1', 'cancelled', 1, null, 'Ford'), row('g2', 'confirmed', 2, null, 'Ford')];
    expect(duplicateGuestRowIds(rows).size).toBe(0);
  });

  it('normalizeName: ตัดช่องว่างหัวท้าย/ซ้อน + ตัวพิมพ์เล็ก', () => {
    expect(normalizeName('  น้ำ ')).toBe('น้ำ');
    expect(normalizeName('A   B')).toBe('a b');
  });
});

describe('bucketSessions / pickFeatured', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  const s = (id: string, start: string, end: string, status = 'open') => ({ id, startsAt: start, endsAt: end, status });
  const list = [
    s('past', '2026-07-30T12:00:00Z', '2026-07-30T15:00:00Z', 'settled'),
    s('later', '2026-08-09T03:00:00Z', '2026-08-09T06:00:00Z'),
    s('soon', '2026-08-03T12:00:00Z', '2026-08-03T15:00:00Z'),
    s('cancelled', '2026-08-04T12:00:00Z', '2026-08-04T15:00:00Z', 'cancelled'),
    s('ongoing', '2026-08-01T10:00:00Z', '2026-08-01T14:00:00Z', 'in_play'),
  ];

  it('upcoming เรียงใกล้สุดก่อน (รวมนัดที่กำลังเล่น) · past เรียงล่าสุดก่อน และมี cancelled/settled', () => {
    const { upcoming, past } = bucketSessions(list, now);
    expect(upcoming.map((x) => x.id)).toEqual(['ongoing', 'soon', 'later']);
    expect(past.map((x) => x.id)).toEqual(['cancelled', 'past']);
  });

  it('pickFeatured: นัดที่ฉันลงอยู่มาก่อน ไม่มีก็นัด open ใกล้สุด ไม่มีเลยก็ null', () => {
    const { upcoming } = bucketSessions(list, now);
    expect(pickFeatured(upcoming, (x) => x.id === 'later')?.id).toBe('later');
    expect(pickFeatured(upcoming, () => false)?.id).toBe('soon');
    expect(pickFeatured([], () => false)).toBeNull();
  });
});
