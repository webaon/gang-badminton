/**
 * Timeline ของนัด — แปลง `event_logs` เป็นข้อความไทย **[WO-3.C]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 **ห้ามแสดง payload ดิบบนหน้าจอ**
 *
 *    payload ของบาง event มีของที่ไม่ควรโผล่: `correlation_id`, ยอดเงินรายคน,
 *    เหตุผลการคืนเงิน และในอนาคตอาจมีคีย์ใหม่ที่คนเพิ่มไม่ได้คิดถึงหน้า timeline
 *    ⇒ ที่นี่ใช้ **whitelist**: อ่านเฉพาะคีย์ที่ระบุไว้ คีย์อื่นถูกทิ้งเสมอ
 *    ⇒ เพิ่ม event ใหม่แล้วลืมมาแก้ที่นี่ = ขึ้นข้อความกลางๆ ไม่ใช่ payload หลุด
 *
 * 🔴 event ที่มี**ยอดเงินรายคน** ทำเครื่องหมาย `adminOnly` — สมาชิกทั่วไปไม่ควรเห็น
 *    ว่าเพื่อนถูกคืนเงินเท่าไหร่ (กติกาเดียวกับ `payments` ใน WO-2.9)
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework
 */

export type TimelineEvent = {
  id: string;
  eventType: string;
  createdAt: string;
  actorName: string | null;
  payload: Record<string, unknown>;
};

export type TimelineItem = {
  id: string;
  createdAt: string;
  title: string;
  detail: string | null;
  actorName: string | null;
  /** true = แสดงเฉพาะคนที่มีสิทธิ์ดูเรื่องเงินของก๊วน */
  adminOnly: boolean;
};

type Descriptor = {
  title: string;
  adminOnly?: boolean;
  /** อ่านได้เฉพาะคีย์ที่ฟังก์ชันนี้หยิบ — คีย์อื่นใน payload ถูกทิ้ง */
  detail?: (payload: Record<string, unknown>) => string | null;
};

/** อ่านค่าที่ปลอดภัยจาก payload — คืน null ถ้าไม่ใช่ string/number ธรรมดา */
function scalar(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value === 'string') return value.slice(0, 120);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

const DESCRIPTORS: Record<string, Descriptor> = {
  'session.transitioned': {
    title: 'เปลี่ยนสถานะนัด',
    detail: (p) => {
      const from = scalar(p, 'from_status');
      const to = scalar(p, 'to_status');
      return from && to ? `${from} → ${to}` : to;
    },
  },
  'session.invite_created': { title: 'สร้างลิงก์เชิญ' },
  'registration.created': {
    title: 'ลงชื่อเข้าร่วม',
    detail: (p) => scalar(p, 'status'),
  },
  'registration.cancelled': { title: 'ยกเลิกการลงชื่อ' },
  'registration.checked_in': { title: 'เช็คอิน' },
  'registration.no_show': {
    title: 'ทำเครื่องหมายว่าไม่มา',
    detail: (p) => scalar(p, 'from_status'),
  },
  'registration.checkin_token_issued': { title: 'ออก QR เช็คอิน' },
  'waitlist.promoted': { title: 'เลื่อนคิวรอขึ้นเป็นได้ที่' },
  'game.shuttles_corrected': {
    title: 'แก้จำนวนลูกที่ใช้',
    detail: (p) => {
      const before = scalar(p, 'before');
      const after = scalar(p, 'after');
      return before && after ? `${before} → ${after} ลูก` : null;
    },
  },
  'game.substituted': { title: 'สลับตัวผู้เล่น' },
  'session.charges_committed': {
    title: 'ปิดรอบและสร้างยอดเรียกเก็บ',
    adminOnly: true,
    detail: (p) => {
      const count = scalar(p, 'charge_count');
      return count ? `${count} รายการ` : null;
    },
  },
  'payment.created': { title: 'ออกใบจ่าย', adminOnly: true },
  'payment.transitioned': {
    title: 'สถานะการจ่ายเงินเปลี่ยน',
    adminOnly: true,
    detail: (p) => scalar(p, 'to_status'),
  },
  'payment.adjusted': {
    title: 'ปรับยอด',
    adminOnly: true,
    detail: (p) => {
      const type = scalar(p, 'type');
      const amount = scalar(p, 'amount');
      return type && amount ? `${type} ${amount} บาท` : type;
    },
  },
  'membership.fees_generated': { title: 'ออกบิลค่าสมาชิกรายเดือน', adminOnly: true },
};

/**
 * แปลง event เป็นรายการที่แสดงได้
 *
 * ⚠️ event ที่ไม่รู้จัก **ไม่ทิ้ง** แต่ขึ้นข้อความกลางๆ พร้อมชื่อ type
 *    (ทิ้งไปเลยจะทำให้ timeline โกหกว่าไม่มีอะไรเกิดขึ้น)
 */
export function describeEvent(event: TimelineEvent): TimelineItem {
  const descriptor = DESCRIPTORS[event.eventType];

  return {
    id: event.id,
    createdAt: event.createdAt,
    title: descriptor?.title ?? `เหตุการณ์: ${event.eventType}`,
    detail: descriptor?.detail?.(event.payload ?? {}) ?? null,
    actorName: event.actorName,
    adminOnly: descriptor?.adminOnly ?? false,
  };
}

/**
 * แปลงทั้งชุดแล้วกรองตามสิทธิ์
 *
 * @param canSeeMoney มีสิทธิ์ดูเรื่องเงินของก๊วนหรือไม่ (`payment.verify`)
 */
export function buildTimeline(
  events: readonly TimelineEvent[],
  canSeeMoney: boolean,
): TimelineItem[] {
  return events.map(describeEvent).filter((item) => canSeeMoney || !item.adminOnly);
}
