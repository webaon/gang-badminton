/**
 * ชนิดข้อมูลของระบบสิทธิ์ — pure TypeScript
 *
 * 🔴 `domain/` ห้าม import `next` / `react` / `@supabase/*` (CLAUDE.md §3)
 *    มี eslint rule บังคับอยู่ ถ้าเผลอ import จะ lint แดง
 */

/** role ในก๊วน — ตรงกับ CHECK constraint ของ `gang_members.role` */
export const GANG_ROLES = ['owner', 'admin', 'member'] as const;
export type GangRole = (typeof GANG_ROLES)[number];

/** role ในองค์กร — ตรงกับ CHECK constraint ของ `organization_members.role` */
export const ORG_ROLES = ['owner', 'admin'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * feature flags ต่อก๊วน — ตรงกับคีย์ใน `gangs.features`
 *
 * 🔴 CLAUDE.md §3: "UI ซ่อนปุ่มอย่างเดียว = flag ปลอม"
 *    ต้อง enforce ทั้งที่นี่และใน DB function ที่เกี่ยวข้อง
 */
export const FEATURES = ['line', 'discovery', 'guests', 'coupons', 'statistics'] as const;
export type Feature = (typeof FEATURES)[number];
export type GangFeatures = Record<Feature, boolean>;

/**
 * การกระทำทั้งหมดที่ระบบรู้จัก
 *
 * ตั้งชื่อเป็น `<ทรัพยากร>.<กริยา>` เพื่อให้ grep เจอง่ายและจัดกลุ่มได้
 * เพิ่ม action ใหม่ = เพิ่มที่นี่ก่อน แล้ว TypeScript จะบังคับให้ไปเติมใน
 * ตารางสิทธิ์ของทุก role เอง (ลืมไม่ได้ — build จะพัง)
 */
export const ACTIONS = [
  // ก๊วน / องค์กร
  'gang.view',
  'gang.update',
  'gang.member.view',
  'gang.member.manage',
  'gang.skill.manage',
  'gang.pricing.manage',
  'gang.finance.view',
  'gang.finance.manage',
  'statistics.view',
  'gang.join_request.manage',
  'gang.line.manage',
  'line.link.self',

  // นัดเล่น
  'session.view',
  'session.create',
  'session.update',
  'session.transition',
  'session.invite.manage',

  // การลงชื่อ
  'registration.create.self',
  'registration.create.other',
  'registration.create.guest',
  'registration.cancel.self',
  'registration.cancel.other',
  'registration.checkin',
  'registration.no_show',

  // วันเล่น
  'game.manage',

  // เงิน
  'billing.close',
  'payment.submit.self',
  'payment.verify',

  // อื่นๆ
  'announcement.view',
  'announcement.manage',
  'notification.view.self',
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * บริบทที่ใช้ตัดสินสิทธิ์
 *
 * `role = null` = ไม่ได้เป็นสมาชิกก๊วนนี้ (รวม guest และคนนอก)
 * `orgRole` มาแยกเพราะแอดมินองค์กรมีสิทธิ์แอดมินในทุกก๊วนขององค์กรนั้น
 * (ตรงกับที่ `is_gang_admin()` ใน migration 0010 ทำ)
 */
export type PermissionContext = {
  role: GangRole | null;
  orgRole?: OrgRole | null;
  features?: Partial<GangFeatures>;
};
