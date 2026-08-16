/**
 * ข้อความ LINE ต่อ event — **[WO-4.C]**
 *
 * 🔴 **whitelist ต่อ event type** เหมือน `domain/reports/timeline.ts`
 *    ⇒ เพิ่ม event ใหม่แล้วลืมมาแก้ที่นี่ = ได้ข้อความกลางๆ **ไม่ใช่ payload หลุดเข้าแชต**
 *
 * 🔴 ❌ **ห้ามใส่ยอดเงินรายคน** ลงข้อความ (ข้อจำกัด Phase 4)
 *    แม้ push จะเข้าแชตส่วนตัว แต่หน้าจอ LINE ถูกคนข้างๆ เห็นได้ง่ายกว่าหน้าเว็บที่ต้องล็อกอิน
 *    ⇒ บอกแค่ "มียอดที่ต้องจ่าย" แล้วให้ไปดูในแอป
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework
 */

/** อ่านค่าที่ปลอดภัยจาก payload — คืน null ถ้าไม่ใช่ string/number ธรรมดา */
function scalar(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value === 'string') return value.slice(0, 80);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

type Builder = (payload: Record<string, unknown>) => string;

const MESSAGES: Record<string, Builder> = {
  'session.opened': (p) => withTitle('เปิดรับสมัครนัดใหม่แล้ว', p),
  'session.reminder': (p) => withTitle('ใกล้ถึงเวลานัดแล้ว', p),
  'waitlist.promoted': (p) => withTitle('คิวถึงคุณแล้ว — ได้ที่เล่นแล้ว', p),
  'announcement.published': (p) => {
    const title = scalar(p, 'title');
    return title ? `ประกาศใหม่จากก๊วน: ${title}` : 'มีประกาศใหม่จากก๊วน';
  },
  // 🔴 ไม่มีตัวเลขเงินในสองอันนี้โดยตั้งใจ
  'payment.due': () => 'มียอดที่ต้องจ่าย — เปิดแอปเพื่อดูรายละเอียดและ QR',
  'payment.overdue': () => 'ยังมียอดค้างจ่ายอยู่ — เปิดแอปเพื่อดูรายละเอียด',
  'gang.join_requested': () => 'มีคนขอเข้าก๊วน — เปิดแอปเพื่ออนุมัติ',
  'gang.join_decided': (p) =>
    scalar(p, 'status') === 'approved'
      ? 'คำขอเข้าก๊วนของคุณได้รับการอนุมัติแล้ว'
      : 'คำขอเข้าก๊วนของคุณถูกปฏิเสธ',
  // [WO-4.B ค้างไว้] ข้อความยืนยันหลังผูกบัญชีสำเร็จ — ตอบผ่านคิว ไม่ใช่ตอบใน webhook
  'line.linked': () => 'ผูกบัญชีเรียบร้อยแล้ว — จากนี้จะได้รับแจ้งเตือนของก๊วนทาง LINE',
  'line.test': () => 'ข้อความทดสอบจากระบบ Gang Badminton — ถ้าเห็นข้อความนี้แปลว่าตั้งค่าถูกต้องแล้ว',
};

function withTitle(prefix: string, payload: Record<string, unknown>): string {
  const title = scalar(payload, 'session_title') ?? scalar(payload, 'title');
  return title ? `${prefix}: ${title}` : prefix;
}

/**
 * ข้อความที่จะส่งเข้า LINE
 *
 * event ที่ไม่รู้จัก **ไม่ทิ้ง** แต่ขึ้นข้อความกลางๆ — การเงียบไปเฉยๆ จะทำให้ผู้ใช้
 * พลาดเรื่องสำคัญโดยไม่มีใครรู้ว่าเกิดอะไรขึ้น
 */
export function lineMessageFor(
  eventType: string,
  payload: Record<string, unknown> | null | undefined,
): string {
  const build = MESSAGES[eventType];
  const safePayload = payload ?? {};

  return build ? build(safePayload) : 'มีการอัปเดตใหม่จากก๊วน — เปิดแอปเพื่อดูรายละเอียด';
}

/** event type ที่มีข้อความเฉพาะของตัวเอง (ใช้ในเทสต์เพื่อกันการลืมอัปเดต) */
export const LINE_MESSAGE_EVENT_TYPES = Object.keys(MESSAGES);
