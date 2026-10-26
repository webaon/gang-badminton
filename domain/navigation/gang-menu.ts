/**
 * เมนูของโครงแอปใต้ `/gangs/[gangId]/*` — **[WO-6.1a]** · pure TypeScript (ห้าม import next/react/supabase)
 *
 * 🔴 เมนูถูกสร้างจาก `can()` เท่านั้น — ห้ามเทียบ role ตรงๆ ที่นี่
 *    และ**ซ่อนเมนูไม่ใช่การกันสิทธิ์**: แต่ละหน้ายังตรวจสิทธิ์ฝั่ง server ของตัวเองเหมือนเดิม
 *    (กำแพงจริงคือ RLS + EXECUTE grant) เมนูมีไว้ไม่ให้ผู้ใช้เห็นทางที่กดแล้วโดนเด้งกลับ
 *
 * ที่มา: hi-fi H17 (tab bar มือถือ) · H10 (sidebar เดสก์ท็อป) — ดู docs/phase6-redesign-plan.md §10
 */
import { can } from '../permissions/can';
import type { Action, PermissionContext } from '../permissions/types';

/** ชื่อไอคอนที่ shell รู้จัก (วาดใน `components/ui/NavIcons.tsx`) — domain ไม่รู้จัก SVG */
export type NavIconKey =
  | 'calendar'
  | 'wallet'
  | 'trophy'
  | 'user'
  | 'home'
  | 'users'
  | 'chart'
  | 'megaphone'
  | 'settings'
  | 'chat'
  | 'repeat'
  | 'inbox'
  | 'star';

export type MenuItemId =
  | 'dashboard'
  | 'sessions'
  | 'templates'
  | 'members'
  | 'join-requests'
  | 'payments'
  | 'membership'
  | 'reports'
  | 'announcements'
  | 'stats'
  | 'settings'
  | 'line'
  | 'profile';

export type MenuItem = {
  id: MenuItemId;
  label: string;
  href: string;
  icon: NavIconKey;
  /**
   * `false` = ลิงก์ที่ไปหน้าเดียวกับเมนูอื่น จึงไม่ขึ้นสถานะ "กำลังเปิดอยู่" ซ้ำ
   * (แดชบอร์ดชี้ไป `sessions` ไปก่อน จนกว่าหน้า #10 จะเสร็จใน WO-6.5)
   */
  selectable: boolean;
};

type Def = {
  id: MenuItemId;
  label: string;
  icon: NavIconKey;
  /** `null` = ไม่ต้องใช้สิทธิ์เฉพาะ (แค่เป็นสมาชิกก๊วน) · array = มีสิทธิ์ข้อใดข้อหนึ่งก็เห็น */
  action: Action | readonly Action[] | null;
  /** path ต่อท้าย `/gangs/:gangId/` — หรือ path เต็มถ้า `absolute` */
  path: string;
  absolute?: boolean;
  selectable?: boolean;
};

/** tab bar มือถือ (hi-fi H17): นัด · ยอดเงิน · อันดับ · ฉัน */
const TAB_DEFS: readonly Def[] = [
  { id: 'sessions', label: 'นัด', icon: 'calendar', action: 'session.view', path: 'sessions' },
  // ⚠️ ผูก `payment.verify` เพราะหน้า payments ของวันนี้เป็นหน้าแอดมิน (redirect ถ้าไม่ใช่)
  //    สมาชิกจึงเห็นแค่ 3 แท็บ (นัด/อันดับ/ฉัน)
  //    WO-6.3 จะเปลี่ยนเป็นหน้ายอดของฉันสำหรับทุกคน — เปลี่ยน action บรรทัดนี้บรรทัดเดียว
  { id: 'payments', label: 'ยอดเงิน', icon: 'wallet', action: 'payment.verify', path: 'payments' },
  { id: 'stats', label: 'อันดับ', icon: 'trophy', action: 'statistics.view', path: 'stats' },
  { id: 'profile', label: 'ฉัน', icon: 'user', action: null, path: '/profile', absolute: true },
];

/** sidebar เดสก์ท็อป + drawer มือถือ (hi-fi H10) */
const SIDE_DEFS: readonly Def[] = [
  {
    id: 'dashboard',
    label: 'แดชบอร์ด',
    icon: 'home',
    action: 'gang.finance.view',
    path: 'sessions',
    selectable: false,
  },
  { id: 'sessions', label: 'นัด', icon: 'calendar', action: 'session.view', path: 'sessions' },
  { id: 'templates', label: 'ตารางประจำ', icon: 'repeat', action: 'session.create', path: 'templates' },
  { id: 'members', label: 'สมาชิก', icon: 'users', action: 'gang.member.view', path: 'members' },
  {
    id: 'join-requests',
    label: 'คำขอเข้าก๊วน',
    icon: 'inbox',
    action: 'gang.join_request.manage',
    path: 'join-requests',
  },
  { id: 'payments', label: 'เก็บเงิน', icon: 'wallet', action: 'payment.verify', path: 'payments' },
  {
    id: 'membership',
    label: 'บิลรายเดือน',
    icon: 'star',
    action: 'gang.finance.view',
    path: 'membership',
  },
  { id: 'reports', label: 'รายงาน', icon: 'chart', action: 'gang.finance.view', path: 'reports' },
  {
    id: 'announcements',
    label: 'ประกาศ',
    icon: 'megaphone',
    action: 'announcement.view',
    path: 'announcements',
  },
  { id: 'stats', label: 'สถิติ', icon: 'trophy', action: 'statistics.view', path: 'stats' },
  { id: 'settings', label: 'ตั้งค่า', icon: 'settings', action: 'gang.update', path: 'settings' },
  {
    id: 'line',
    label: 'LINE',
    icon: 'chat',
    // แอดมิน = ตั้งค่า LINE ของก๊วน · สมาชิก = ผูกบัญชี LINE ของตัวเอง (เห็นเฉพาะก๊วนที่เปิด features.line)
    action: ['gang.line.manage', 'line.link.self'],
    path: 'line',
  },
  { id: 'profile', label: 'โปรไฟล์ของฉัน', icon: 'user', action: null, path: '/profile', absolute: true },
];

export type GangMenu = {
  /** แท็บล่างบนมือถือ */
  tabs: MenuItem[];
  /** sidebar เดสก์ท็อป และ drawer บนมือถือ */
  side: MenuItem[];
};

function allowed(ctx: PermissionContext, action: Def['action']): boolean {
  if (action === null) return true;
  return (Array.isArray(action) ? action : [action as Action]).some((a) => can(ctx, a));
}

function build(defs: readonly Def[], ctx: PermissionContext, gangId: string): MenuItem[] {
  return defs
    .filter((d) => allowed(ctx, d.action))
    .map((d) => ({
      id: d.id,
      label: d.label,
      href: d.absolute ? d.path : `/gangs/${gangId}/${d.path}`,
      icon: d.icon,
      selectable: d.selectable ?? true,
    }));
}

/**
 * สร้างเมนูตามสิทธิ์ + feature flag ของก๊วน
 *
 * ไม่ใช่สมาชิก (`gang.view` ไม่ผ่าน) ⇒ เมนูว่างทั้งคู่ — shell จะไม่แสดงอะไรเลย
 * ปล่อยให้แต่ละหน้าตอบ 404/redirect เองเหมือนเดิม
 */
export function buildGangMenu(ctx: PermissionContext, gangId: string): GangMenu {
  if (!can(ctx, 'gang.view')) return { tabs: [], side: [] };

  return { tabs: build(TAB_DEFS, ctx, gangId), side: build(SIDE_DEFS, ctx, gangId) };
}

/**
 * เมนูไหน "กำลังเปิดอยู่" — อ่านจาก pathname
 *
 * เลือกอันที่ href เป็นคำนำหน้า (ตามขอบ segment) ของ pathname และ**ยาวที่สุด**
 * เช่น `/gangs/g1/sessions/s9/pay` → `sessions` · `/gangs/g1/sessionsX` ไม่ตรง
 * รายการ `selectable: false` ไม่เข้าร่วม ⇒ คืน `null` ถ้าไม่มีอันไหนตรง
 */
export function activeMenuId(pathname: string, items: readonly MenuItem[]): MenuItemId | null {
  const path = pathname.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  let best: MenuItem | null = null;

  for (const item of items) {
    if (!item.selectable) continue;
    const href = item.href.replace(/\/+$/, '');
    const matches = path === href || path.startsWith(`${href}/`);
    if (matches && (!best || href.length > best.href.length)) best = item;
  }

  return best?.id ?? null;
}
