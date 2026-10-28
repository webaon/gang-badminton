/**
 * ตรรกะ "มุมมองสมาชิก" ของหน้านัด — WO-6.2 (pure · ไม่แตะ DB · ไม่คิดเงิน)
 *
 * 🔴 ที่นี่ **ไม่ตัดสินสิทธิ์และไม่คำนวณเงิน/ค่าปรับ** — สิทธิ์มาจาก `can()` ที่หน้า (server) ส่งมาเป็น flag
 *    ส่วนผลของการลงชื่อ/ยกเลิกจริงตัดสินใน DB function (`register_to_session` / `cancel_registration`)
 *    ไฟล์นี้แค่จัดข้อมูลที่ server ส่งมาให้เป็นรูปที่ UI แสดงได้ (นับ/ลำดับ/เลือกปุ่มหลัก/จับชื่อซ้ำ)
 */

export type RegistrationStatus = 'confirmed' | 'checked_in' | 'waitlist' | 'cancelled' | 'no_show';

export type RosterRow = {
  id: string;
  /** null = guest */
  userId: string | null;
  /** ชื่อที่แสดง: displayName ของสมาชิก หรือ guest_name ของ guest */
  name: string;
  status: RegistrationStatus | string;
  ordering: number;
  /**
   * เวลาที่ลงชื่อ (ISO) — ใช้เรียงคนที่ "ได้ที่แล้ว"
   * ⚠️ `ordering` มีความหมายเฉพาะ waitlist (ต่อท้ายคิว) — แถวที่ได้ที่ ordering = 0 ทั้งหมด จึงเรียงด้วยค่านี้แทน
   */
  registeredAt?: string;
};

const ACTIVE: ReadonlySet<string> = new Set(['confirmed', 'checked_in', 'waitlist']);
const SEATED: ReadonlySet<string> = new Set(['confirmed', 'checked_in']);

export function isActive(status: string): boolean {
  return ACTIVE.has(status);
}

export function isSeated(status: string): boolean {
  return SEATED.has(status);
}

export type Roster = {
  /** confirmed + checked_in เรียงตาม ordering */
  seated: RosterRow[];
  /** waitlist เรียงตาม ordering (ตำแหน่งแรก = คิวที่ 1) */
  waitlist: RosterRow[];
};

export function buildRoster(rows: readonly RosterRow[]): Roster {
  // คิวรอ: ตาม ordering (ต่อท้ายคิว) · คนที่ได้ที่: ตามเวลาลงชื่อ (ordering เป็น 0 ทั้งหมด) แล้วค่อย ordering/id กันเสมอ
  const byQueue = (a: RosterRow, b: RosterRow) => a.ordering - b.ordering || a.id.localeCompare(b.id);
  const byRegisteredAt = (a: RosterRow, b: RosterRow) =>
    (a.registeredAt ?? '').localeCompare(b.registeredAt ?? '') || byQueue(a, b);
  return {
    seated: rows.filter((r) => isSeated(r.status)).sort(byRegisteredAt),
    waitlist: rows.filter((r) => r.status === 'waitlist').sort(byQueue),
  };
}

/** ลำดับคิวของแถวนี้ (เริ่มที่ 1) · ไม่อยู่ในคิว = null */
export function waitlistPosition(roster: Roster, registrationId: string): number | null {
  const idx = roster.waitlist.findIndex((r) => r.id === registrationId);
  return idx === -1 ? null : idx + 1;
}

/** ลำดับที่ในรายชื่อที่ได้ที่แล้ว (เริ่มที่ 1) */
export function seatPosition(roster: Roster, registrationId: string): number | null {
  const idx = roster.seated.findIndex((r) => r.id === registrationId);
  return idx === -1 ? null : idx + 1;
}

export type PrimaryAction =
  /** ยังไม่ได้ลง + มีที่ว่าง */
  | { kind: 'register' }
  /** ยังไม่ได้ลง + นัดเต็ม → ลงแล้วจะเข้าคิว (server ตัดสินจริง ปุ่มแค่บอกล่วงหน้า) */
  | { kind: 'join_waitlist'; nextPosition: number }
  /** ลงแล้ว (ได้ที่) → ปุ่มหลักคือยกเลิก */
  | { kind: 'cancel'; seat: number | null }
  /** อยู่ในคิว → บอกลำดับ + ยกเลิก */
  | { kind: 'cancel_waitlist'; position: number }
  /** ลงชื่อไม่ได้ (นัดไม่เปิด / ไม่มีสิทธิ์) */
  | { kind: 'none'; reason: 'not_open' | 'no_permission' };

/**
 * ปุ่มหลัก **เดียว** ตามสถานะของฉัน (hi-fi 19)
 *
 * `canRegister` = ผลของ `can()` + สถานะนัดที่หน้าคำนวณฝั่ง server — ที่นี่ไม่ตีความสิทธิ์ซ้ำ
 */
export function primaryAction(input: {
  roster: Roster;
  mine: { id: string; status: string } | null;
  maxPlayers: number;
  sessionOpen: boolean;
  canRegister: boolean;
}): PrimaryAction {
  const { roster, mine, maxPlayers, sessionOpen, canRegister } = input;

  if (mine) {
    if (mine.status === 'waitlist') {
      return { kind: 'cancel_waitlist', position: waitlistPosition(roster, mine.id) ?? roster.waitlist.length };
    }
    if (isSeated(mine.status)) {
      return { kind: 'cancel', seat: seatPosition(roster, mine.id) };
    }
  }

  if (!sessionOpen) return { kind: 'none', reason: 'not_open' };
  if (!canRegister) return { kind: 'none', reason: 'no_permission' };

  if (roster.seated.length >= maxPlayers) {
    return { kind: 'join_waitlist', nextPosition: roster.waitlist.length + 1 };
  }
  return { kind: 'register' };
}

/** จำนวนที่ว่าง (ไม่ติดลบ) */
export function seatsLeft(seatedCount: number, maxPlayers: number): number {
  return Math.max(0, maxPlayers - seatedCount);
}

/** เปอร์เซ็นต์เติมของ meter (0–100) */
export function fillPercent(seatedCount: number, maxPlayers: number): number {
  if (maxPlayers <= 0) return 0;
  return Math.min(100, Math.round((seatedCount / maxPlayers) * 100));
}

// ───────────────────────── ชื่อซ้ำ (UI เท่านั้น ไม่บล็อก) ─────────────────────────

/** ทำให้ชื่อเทียบกันได้: ตัดช่องว่างหัวท้าย/ซ้อน, ตัวพิมพ์เล็ก, NFC (วรรณยุกต์ไทยพิมพ์ต่างลำดับ) */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('th-TH');
}

/**
 * id ของแถวที่ชื่อซ้ำกับแถวอื่นที่ยังอยู่ในนัด (กัน guest "Ford" 3 แถว)
 * เฉพาะเมื่อมี **guest** อยู่ในกลุ่มชื่อนั้น — สมาชิกสองคนชื่อเล่นเหมือนกันเป็นเรื่องปกติ ไม่ต้องเตือน
 */
export function duplicateGuestRowIds(rows: readonly RosterRow[]): Set<string> {
  const groups = new Map<string, RosterRow[]>();
  for (const r of rows) {
    if (!isActive(r.status)) continue;
    const key = normalizeName(r.name);
    if (key === '') continue;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const ids = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2 || !list.some((r) => r.userId === null)) continue;
    for (const r of list) ids.add(r.id);
  }
  return ids;
}

// ───────────────────────── ลิสต์นัด ─────────────────────────

export type SessionLite = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
};

/** นัดที่ "ยังไม่จบ" = ยังไม่ถึงเวลาจบ และไม่ได้ยกเลิก/เก็บเข้าคลัง */
export function isUpcoming(s: SessionLite, now: Date): boolean {
  if (['cancelled', 'archived', 'settled'].includes(s.status)) return false;
  return new Date(s.endsAt).getTime() >= now.getTime();
}

export type SessionBuckets<T extends SessionLite> = {
  /** เรียงใกล้ที่สุดก่อน */
  upcoming: T[];
  /** เรียงล่าสุดก่อน */
  past: T[];
};

export function bucketSessions<T extends SessionLite>(sessions: readonly T[], now: Date): SessionBuckets<T> {
  const upcoming = sessions
    .filter((s) => isUpcoming(s, now))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const past = sessions
    .filter((s) => !isUpcoming(s, now))
    .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
  return { upcoming, past };
}

/**
 * นัดถัดไปที่จะเอาไปทำเป็นการ์ดเด่น: นัดที่ฉันลงชื่ออยู่ (ใกล้สุด) มาก่อน ไม่มีก็นัดที่เปิดรับใกล้สุด
 */
export function pickFeatured<T extends SessionLite>(
  upcoming: readonly T[],
  isMine: (s: T) => boolean,
): T | null {
  return upcoming.find(isMine) ?? upcoming.find((s) => s.status === 'open') ?? upcoming[0] ?? null;
}

// ───────────────────────── แท็บลิสต์นัด ─────────────────────────

export const SESSION_TABS = ['upcoming', 'mine', 'past'] as const;
export type SessionTab = (typeof SESSION_TABS)[number];

/** `?tab=` มาจาก query string — ค่าที่ไม่รู้จักตกเป็นแท็บแรกเสมอ */
export function parseSessionTab(raw: string | undefined | null): SessionTab {
  return (SESSION_TABS as readonly string[]).includes(raw ?? '') ? (raw as SessionTab) : 'upcoming';
}
