import { LINE_PLATFORM_PROVIDER, type LineProfileStatus } from './platform-login';

/**
 * ตรรกะล้วนของ "ผูก/ถอด LINE ระดับบัญชี" — **[WO-B1.c · ADR-013 R2/R3/R5]**
 *
 * ไม่แตะเครือข่าย/DB เลย ⇒ เทสต์ได้ตรงๆ · ข้อมูลเข้ามาจาก `supabase.auth.getUserIdentities()`
 *
 * ⚠️ **ข้อสมมติที่ยังไม่พิสูจน์บน cloud (ADR-013 §10 S2 / §10.1):**
 *    A1  identity ของ Custom OIDC มี `provider === 'custom:line'` (ตรงกับ identifier ที่ตั้งใน dashboard)
 *    A2  `identity_data.name` เป็นชื่อจาก LINE (key ที่แท้จริงคือ S3) — ใช้แสดงผลเท่านั้น ไม่ใช้ตัดสินสิทธิ์
 *    ถ้า A1 ผิด `findLineIdentity()` จะหาไม่เจอ ⇒ UI ขึ้น "ยังไม่ได้ผูก" และถอดไม่ได้ (fail-safe ไม่ใช่ fail-open)
 */

export type IdentityLike = {
  identity_id: string;
  provider: string;
  created_at?: string;
  identity_data?: Record<string, unknown>;
};

export type LineAccountState = {
  /** flag `LINE_PLATFORM_LOGIN_ENABLED` — false = ซ่อนทั้งส่วนบนหน้าโปรไฟล์ */
  enabled: boolean;
  linked: boolean;
  /** มีวิธีเข้าสู่ระบบอื่นเหลืออยู่ ⇒ ถอด LINE แล้วไม่ล็อกตัวเองออก */
  canUnlink: boolean;
  linkedAt: string | null;
  /** ชื่อจาก LINE สำหรับแสดงผล (ตัดความยาวแล้ว) */
  lineName: string | null;
};

export const DISABLED_STATE: LineAccountState = {
  enabled: false,
  linked: false,
  canUnlink: false,
  linkedAt: null,
  lineName: null,
};

export function findLineIdentity<T extends IdentityLike>(identities: readonly T[]): T | null {
  return identities.find((identity) => identity.provider === LINE_PLATFORM_PROVIDER) ?? null;
}

/** จำนวน identity ที่ **ไม่ใช่** LINE (email, google, …) */
export function otherIdentityCount(identities: readonly IdentityLike[]): number {
  return identities.filter((identity) => identity.provider !== LINE_PLATFORM_PROVIDER).length;
}

/**
 * 🔴 ADR-013 R5: ถอด LINE ได้เมื่อมีวิธีอื่นเหลืออย่างน้อย 1 ทาง
 *
 * ⚠️ "มี identity อื่น" ≠ "เข้าได้จริงแน่นอน" — เช่น identity อีเมลที่ไม่เคยตั้งรหัสผ่าน
 *    และระบบไม่มี SMTP ส่งลิงก์ ⇒ ฟอร์มสมัครของเราบังคับรหัสผ่านอยู่แล้ว จึงยอมรับความเสี่ยงนี้
 *    (Supabase เองก็บังคับ ≥ 2 identities ก่อน unlink ซ้ำอีกชั้น)
 */
export function canUnlinkLine(identities: readonly IdentityLike[]): boolean {
  return findLineIdentity(identities) !== null && otherIdentityCount(identities) >= 1;
}

const MAX_NAME = 100;

function safeName(data: Record<string, unknown> | undefined): string | null {
  const raw = data?.name ?? data?.full_name;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_NAME);
}

/** 🔴 ไม่คืน `sub` / identity_id / ข้อมูลดิบใดๆ ไปให้ client */
export function summarizeLineAccount(identities: readonly IdentityLike[]): LineAccountState {
  const line = findLineIdentity(identities);

  return {
    enabled: true,
    linked: line !== null,
    canUnlink: canUnlinkLine(identities),
    linkedAt: line?.created_at ?? null,
    lineName: line ? safeName(line.identity_data) : null,
  };
}

/**
 * เลือกแบนเนอร์สถานะที่จะโชว์บน `/profile` — **[WO-B1.c · QA ข้อเล็ก]**
 *
 * 🔴 `?line=` พิมพ์เองใน URL ได้ ⇒ แบนเนอร์ที่ "ยืนยันผล" ต้องตรงกับสถานะจริงที่ `myLineAccount()` รายงาน
 *    · `linked`   โชว์เมื่อผูกอยู่จริงเท่านั้น
 *    · `unlinked` โชว์เมื่อไม่ได้ผูกอยู่จริงเท่านั้น
 *    · `denied` / `in_use` / `failed` ไม่ยืนยันสถานะบัญชี จึงโชว์ได้ (ข้อความตายตัวจาก whitelist)
 * สถานะที่เกิดจากการกดในหน้า (`local`) เชื่อได้ — มาจากผลของ action จริง
 */
export function pickProfileBanner(
  local: LineProfileStatus | null,
  fromUrl: LineProfileStatus | null,
  linkedNow: boolean,
): LineProfileStatus | null {
  if (local) return local;
  if (fromUrl === 'linked') return linkedNow ? 'linked' : null;
  if (fromUrl === 'unlinked') return linkedNow ? null : 'unlinked';
  return fromUrl;
}
