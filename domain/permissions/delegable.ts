/**
 * สิทธิ์ที่ "มอบให้สมาชิกทั่วไปผ่านชุดสิทธิ์" ได้ + preset ระบบ — pure TypeScript (ADR-015)
 *
 * 🔴 ไฟล์นี้เป็น **แหล่งอ้างอิงฝั่ง TS** ของรายการที่ DB ถือไว้เป็นของตัวเอง:
 *    - `public.is_delegable_action(text)`        ↔ DELEGABLE_ACTIONS
 *    - แถว seed ใน `public.gang_roles` (system)  ↔ ROLE_PRESETS
 *    มีเทสต์ (tests/sessions/gang-roles.test.ts) ยิง DB จริงเทียบสองฝั่งทุก action — ถ้าฝั่งใดเพิ่มแล้วอีกฝั่งลืม เทสต์แดง
 *
 * หลักการ (ADR-015 §Decision 4):
 *  - รายการเป็น "ปิด" (allow-list) ไม่ใช่ "ทุก action ยกเว้น…" ⇒ action ใหม่ที่เพิ่มใน ACTIONS ไม่ delegable โดยอัตโนมัติ
 *  - ทุกตัวต้องเป็นสิ่งที่ admin ทำได้อยู่แล้ว (delegated ⊂ admin) — ชุดสิทธิ์ไม่สร้างสิทธิ์ใหม่ที่ไม่มีเจ้าของ
 *  - ห้ามมีสิทธิ์ที่นำไปสู่ escalation: จัดการสมาชิก/ชุดสิทธิ์, โอนความเป็นเจ้าของ, แก้ก๊วน, ตั้งค่า LINE, อนุมัติคำขอเข้าก๊วน,
 *    เปลี่ยนสูตรราคา/ระดับฝีมือ (เปลี่ยนกติกาคิดเงิน)
 *
 * ⚠️ `statistics.view` ไม่อยู่ในรายการ: member มีอยู่แล้วในความหมาย "ดูของตัวเอง" (RLS ตัดสินว่าเห็นของใคร) —
 *    การมอบ "ดูทั้งก๊วน" ต้องเป็นสิทธิ์ชื่อใหม่ที่แยกความหมาย ⇒ รอเจ้าของงานตัดสิน (ADR-015 Q6)
 */
import type { Action } from './types';

export const DELEGABLE_ACTIONS = [
  // การเงิน
  'payment.verify',
  'credit.read.other',
  'credit.overpayment.record',
  'credit.payout.record',
  'credit.return_charge',
  'credit.topup',
  'gang.finance.view',
  'gang.finance.manage',
  'billing.close',
  // จัดนัด / ลงชื่อ / วันเล่น
  'session.create',
  'session.update',
  'session.transition',
  'session.invite.manage',
  'registration.create.other',
  'registration.create.guest',
  'registration.cancel.other',
  'registration.promote.other',
  'registration.checkin',
  'registration.no_show',
  'game.manage',
  // อื่นๆ
  'announcement.manage',
] as const satisfies readonly Action[];

export type DelegableAction = (typeof DELEGABLE_ACTIONS)[number];

/** action ที่ "ห้าม" delegate เด็ดขาด — เทสต์ยืนยันว่า DB ปฏิเสธทุกตัว (ต่อให้ owner ใส่ใน permissions เอง) */
export const NEVER_DELEGABLE_ACTIONS = [
  'gang.member.manage', // ตั้ง role/ชุดสิทธิ์ให้ตัวเองหรือคนอื่น = escalation
  'gang.ownership.transfer',
  'gang.update',
  'gang.line.manage', // credentials ของ LINE OA
  'gang.join_request.manage',
  'gang.pricing.manage', // เปลี่ยนสูตรคิดเงินของทั้งก๊วน
  'gang.skill.manage',
] as const satisfies readonly Action[];

/** preset ระบบ (gang_id = null ใน gang_roles · ทุกก๊วนใช้ร่วม · แก้ไม่ได้ผ่านแอป) */
export const ROLE_PRESETS = {
  /** เหรัญญิก — ตรวจสลิป/เครดิต/รายงานการเงิน · ❌ ไม่มี credit.topup (ให้เครดิต=สร้างหนี้ก๊วนโดยไม่มีเงินเข้า) ❌ ไม่มี billing.close (Q2ก) */
  treasurer: [
    'payment.verify',
    'credit.read.other',
    'credit.overpayment.record',
    'credit.payout.record',
    'credit.return_charge',
    'gang.finance.view',
    'gang.finance.manage',
  ],
  /** ผู้จัดคิว — จัดนัด/ลงชื่อ/เช็คอิน/วันเล่น · ❌ ไม่มีเงิน ❌ ไม่มีประกาศ/เทมเพลต (Q2ก) */
  scheduler: [
    'session.create',
    'session.update',
    'session.transition',
    'session.invite.manage',
    'registration.create.other',
    'registration.create.guest',
    'registration.cancel.other',
    'registration.promote.other',
    'registration.checkin',
    'registration.no_show',
    'game.manage',
  ],
} as const satisfies Record<string, readonly DelegableAction[]>;

export type RolePresetKey = keyof typeof ROLE_PRESETS;

const DELEGABLE_SET: ReadonlySet<string> = new Set(DELEGABLE_ACTIONS);

export function isDelegableAction(action: string): action is DelegableAction {
  return DELEGABLE_SET.has(action);
}
