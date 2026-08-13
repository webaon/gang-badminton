/**
 * `can(ctx, action)` — 🔴 **แหล่งเดียว** ของ mapping role → สิทธิ์ (CLAUDE.md §3)
 *
 * ❌ ห้าม `if (role === 'admin')` กระจายตามไฟล์ ถ้าเจอที่ไหนให้ย้ายมาที่นี่
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 `can()` ไม่ใช่ชั้นความปลอดภัย — เป็นชั้น "ตอบให้ถูก"
 *
 * กำแพงจริงคือ RLS + EXECUTE grant ในฐานข้อมูล (WO-1.4) ซึ่งบังคับอยู่แล้ว
 * ต่อให้ `can()` พลาด `can()` มีไว้เพื่อ:
 *   1. ซ่อน/ปิดปุ่มใน UI ให้ตรงกับความจริง
 *   2. ตอบ `FORBIDDEN` ตั้งแต่ต้นทางแทนที่จะปล่อยให้ไปเจอ 0 แถวจาก RLS
 *      แล้วต้องเดาว่า "ไม่มีข้อมูล" หรือ "ไม่มีสิทธิ์"
 *
 * ⇒ **ห้ามใช้ `can()` แทน RLS** และห้ามผ่อน RLS เพราะ "เช็คที่ can() แล้ว"
 */
import type { Action, Feature, PermissionContext } from './types';
import { ACTIONS } from './types';

/**
 * สิทธิ์ของแต่ละ role — ประกาศเป็น `readonly Action[]` ต่อ role
 *
 * `member` = ฐาน · `admin` = member + งานจัดการ · `owner` = admin + ทุกอย่าง
 * เขียนแบบสะสมเพื่อไม่ให้ลืมว่า owner ต้องทำสิ่งที่ admin ทำได้
 */
const MEMBER: readonly Action[] = [
  'gang.view',
  'gang.member.view',
  'session.view',
  'registration.create.self',
  'registration.cancel.self',
  'payment.submit.self',
  'announcement.view',
  'notification.view.self',
];

const ADMIN: readonly Action[] = [
  ...MEMBER,
  'gang.update',
  'gang.member.manage',
  'gang.skill.manage',
  'gang.pricing.manage',
  'gang.finance.view',
  'session.create',
  'session.update',
  'session.transition',
  'session.invite.manage',
  'registration.create.other',
  'registration.create.guest',
  'registration.cancel.other',
  'registration.checkin',
  'registration.no_show',
  'game.manage',
  'billing.close',
  'payment.verify',
  'announcement.manage',
];

// owner ต่างจาก admin แค่เชิงความเป็นเจ้าของ (ลบก๊วน/ย้ายเจ้าของ) ซึ่งยังไม่มีใน MVP-0
const OWNER: readonly Action[] = [...ADMIN];

const ROLE_ACTIONS = {
  member: new Set<Action>(MEMBER),
  admin: new Set<Action>(ADMIN),
  owner: new Set<Action>(OWNER),
} as const;

/**
 * action ที่ต้องเปิด feature flag ก่อนถึงจะทำได้
 *
 * 🔴 ต้องตรงกับที่ DB function ตรวจ — `register_to_session()` ตรวจ `features.guests`
 *    ก่อนรับ guest อยู่แล้ว ถ้าที่นี่ไม่ตรวจด้วย UI จะโชว์ปุ่มที่กดแล้ว error เสมอ
 */
const FEATURE_GATED: Partial<Record<Action, Feature>> = {
  'registration.create.guest': 'guests',
  'session.invite.manage': 'guests',
};

/**
 * ตัดสินว่าทำได้หรือไม่
 *
 * ลำดับการตรวจ: feature flag ก่อน แล้วค่อย role
 * — flag ปิดแล้วต่อให้เป็น owner ก็ทำไม่ได้ เพราะก๊วนเลือกปิดฟีเจอร์นั้นเอง
 */
export function can(ctx: PermissionContext, action: Action): boolean {
  const requiredFeature = FEATURE_GATED[action];
  if (requiredFeature && ctx.features?.[requiredFeature] !== true) {
    return false;
  }

  // แอดมินขององค์กรที่เป็นเจ้าของก๊วน = แอดมินในก๊วนนั้น
  // (ตรงกับ is_gang_admin() ใน migration 0010 — ถ้าสองที่ไม่ตรงกันจะเกิดเคส
  //  "UI ให้กดได้แต่ DB ปฏิเสธ" หรือแย่กว่านั้นคือ "UI ซ่อนแต่ DB ยอม")
  const effectiveRole = ctx.role ?? (ctx.orgRole ? 'admin' : null);
  if (!effectiveRole) return false;

  return ROLE_ACTIONS[effectiveRole].has(action);
}

/** เวอร์ชันที่โยน error — ใช้ใน server action ที่อยากให้จบเลยถ้าไม่มีสิทธิ์ */
export function assertCan(ctx: PermissionContext, action: Action): void {
  if (!can(ctx, action)) {
    const err = new Error(`FORBIDDEN: ${action}`);
    (err as Error & { code?: string }).code = 'FORBIDDEN';
    throw err;
  }
}

/** ทุก action ที่ role นี้ทำได้ — ใช้ส่งไปให้ UI ตัดสินใจซ่อน/แสดงทีเดียว */
export function allowedActions(ctx: PermissionContext): Action[] {
  return ACTIONS.filter((a) => can(ctx, a));
}
