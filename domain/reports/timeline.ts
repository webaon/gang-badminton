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
  // [WO-6.5c] event_type จริงที่ register_to_session() insert คือสองคีย์นี้ ไม่ใช่
  // 'registration.created' ข้างบน (ของเดิมไม่ตรงกับ DB เลยมาตั้งแต่ต้น — คงคีย์เดิมไว้
  // เผื่อมีข้อมูลเก่า/อ้างอิงที่อื่น แต่เพิ่มคีย์จริงให้ใช้งานได้จริงจากนี้)
  'registration.confirmed': { title: 'ลงชื่อเข้าร่วม (ได้ที่เล่น)' },
  'registration.waitlisted': { title: 'ลงชื่อเข้าร่วม (เข้าคิวรอ)' },
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
  // [WO-6.5c] event_type จริงจาก substitute_game_player() คือคีย์นี้ (ของเดิม 'game.substituted'
  // ข้างบนไม่ตรงกับ DB เหมือนกัน — คงไว้เผื่อข้อมูลเก่า)
  'game.player_substituted': { title: 'สลับตัวผู้เล่น' },
  'session.charges_committed': {
    title: 'ปิดรอบและสร้างยอดเรียกเก็บ',
    adminOnly: true,
    detail: (p) => {
      const count = scalar(p, 'charge_count');
      return count ? `${count} รายการ` : null;
    },
  },
  // [WO-6.5c] event_type จริงจาก close_session_with_charges() คือคีย์นี้ (ของเดิมข้างบนไม่ตรงกับ DB
  // เหมือนกัน — คงไว้เผื่อข้อมูลเก่า)
  'session.closed_with_charges': {
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
  // [WO-3.E] คำขอเข้าก๊วน — ไม่มีข้อความที่ผู้ขอพิมพ์อยู่ใน payload ตั้งแต่ต้นทางแล้ว
  'gang.join_requested': { title: 'มีคนขอเข้าก๊วน' },
  'gang.join_approved': { title: 'รับเข้าก๊วน' },
  'gang.join_rejected': { title: 'ปฏิเสธคำขอเข้าก๊วน' },
  'gang.join_cancelled': { title: 'ผู้ขอยกเลิกคำขอเข้าก๊วน' },

  // [WO-6.5c] เพิ่มจาก grep event_type จริงทั้งหมดเทียบ DESCRIPTORS (planner อนุมัติ 31 ต.ค. 2026) —
  // event ของสมาชิก/สังคมทั่วไป (ไม่มีเงิน/ไม่ใช่ config ของแอดมิน) ⇒ adminOnly: false
  'gang.created': { title: 'สร้างก๊วน' },
  'gang.member_added': { title: 'เพิ่มสมาชิกใหม่' },
  'gang.member_left': { title: 'ออกจากก๊วน' },
  'gang.ownership_transferred': { title: 'โอนความเป็นเจ้าของก๊วน' },
  'announcement.published': { title: 'เผยแพร่ประกาศ' },
  'line.account_linked': { title: 'ผูกบัญชี LINE' },
  'line.account_unlinked': { title: 'เลิกผูกบัญชี LINE' },

  // [WO-6.5c] การตั้งค่า/ปฏิบัติการของแอดมิน (LINE credentials, block) ⇒ adminOnly: true
  // (เครื่องมือแอดมิน ไม่ใช่เรื่องเงิน แต่ก็ไม่ใช่สิ่งที่สมาชิกทั่วไปต้องเห็นในไทม์ไลน์)
  'gang.line_config_updated': { title: 'แก้ไขการตั้งค่า LINE', adminOnly: true },
  'gang.line_toggled': { title: 'เปิด/ปิดการเชื่อม LINE', adminOnly: true },
  'gang.line_config_cleared': { title: 'ลบการตั้งค่า LINE', adminOnly: true },
  'gang.line_login_updated': { title: 'แก้ไขการตั้งค่า LINE Login', adminOnly: true },
  'line.blocked': { title: 'ปิดกั้นบัญชี LINE', adminOnly: true },
  'line.unblocked': { title: 'ปลดบล็อกบัญชี LINE', adminOnly: true },

  // [WO-6.5c] audit.* ทุกตัว = ยอดเงิน/สิทธิ์ของคนอื่น ⇒ adminOnly: true เสมอ (กติกาเดียวกับที่
  // DESCRIPTORS เดิมใช้กับ payment.*/session.charges_committed)
  'audit.waitlist_promoted_by_admin': { title: 'แอดมินเลื่อนคิวรอให้', adminOnly: true },
  'audit.registration_penalty_waived': { title: 'ยกเว้นค่าปรับยกเลิกให้', adminOnly: true },
  'audit.credit_overpayment_recorded': {
    title: 'บันทึกโอนเกินเข้าเครดิต',
    adminOnly: true,
    detail: (p) => {
      const amount = scalar(p, 'amount');
      return amount ? `${amount} บาท` : null;
    },
  },
  'audit.credit_applied': { title: 'หักเครดิตชำระหนี้', adminOnly: true },
  'audit.credit_topup': {
    title: 'เติมเครดิตให้สมาชิก',
    adminOnly: true,
    detail: (p) => scalar(p, 'reason'),
  },
  'audit.credit_cash_payout': {
    title: 'จ่ายคืนเครดิตเป็นเงินสด',
    adminOnly: true,
    detail: (p) => scalar(p, 'reason'),
  },
  'audit.credit_charge_returned': {
    title: 'ลดหนี้ย้ายเข้าเครดิต',
    adminOnly: true,
    detail: (p) => scalar(p, 'reason'),
  },
  'audit.payment_received_amount_set': { title: 'บันทึกยอดที่โอนจริง', adminOnly: true },
  'audit.role_assigned': {
    title: 'มอบชุดสิทธิ์',
    adminOnly: true,
    detail: (p) => scalar(p, 'role_key'),
  },
  'audit.role_revoked': {
    title: 'ถอนชุดสิทธิ์',
    adminOnly: true,
    detail: (p) => scalar(p, 'role_key'),
  },
};

/** export เฉพาะให้เทสต์ drift-detector (tests/domain/timeline-event-coverage.test.ts) ใช้เทียบกับ event_type จริงใน DB — ไม่ใช่ public API ของโมดูลนี้ */
export const DESCRIPTORS_FOR_TEST: Readonly<Record<string, Descriptor>> = DESCRIPTORS;

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
