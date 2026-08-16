import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * `state` ของ LINE Login — **[WO-4.D]**
 *
 * ❗ กติกา Phase 4: ห้ามเพิ่มตาราง ⇒ ไม่มีที่เก็บ "state ที่ออกไปแล้ว"
 *    `state` จึงพกข้อมูลของตัวเองมาพร้อมลายเซ็น (แนวเดียวกับรหัสผูกบัญชีใน `link-code.ts`)
 *
 * payload = `<gangId>|<userId>|<nonce>|<expiresAtEpochSeconds>`
 *
 * 🔴 **ลายเซ็นอย่างเดียวไม่พอ** — คนร้ายที่ขอ `state` ของตัวเองมาได้ ก็เอาไปหลอกให้
 *    เหยื่อเปิด callback ได้ (login CSRF) ⇒ `nonce` ถูกเก็บคู่กันใน **cookie httpOnly**
 *    และ callback ต้องเจอทั้งสองฝั่งตรงกันถึงจะผ่าน
 *
 * 🔴 callback ยังตรวจซ้ำอีกชั้นว่า `userId` ใน state = ผู้ใช้ที่ล็อกอินอยู่จริง
 *    ⇒ ต่อให้ state หลุด ก็ผูกบัญชีให้คนอื่นไม่ได้
 */

const DEFAULT_TTL_SECONDS = 10 * 60;

export const LINE_LOGIN_NONCE_COOKIE = 'line_login_nonce';

function secret(): string {
  const value = process.env.LINE_LINK_SECRET;

  if (!value) {
    // 🔴 fail-closed — key เดียวกับรหัสผูกบัญชี (ดู .env.example)
    throw new Error('ตั้งค่า LINE_LINK_SECRET ก่อน (ดู .env.example)');
  }

  return value;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload, 'utf8').digest().subarray(0, 16).toString('base64url');
}

export type LoginState = {
  gangId: string;
  userId: string;
  nonce: string;
};

export function mintLoginState(
  gangId: string,
  userId: string,
  now: Date = new Date(),
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): { state: string; nonce: string; expiresAt: Date } {
  const nonce = randomBytes(16).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const payload = `${gangId}|${userId}|${nonce}|${Math.floor(expiresAt.getTime() / 1000)}`;

  return {
    state: `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`,
    nonce,
    expiresAt,
  };
}

/** คืน `null` ทุกกรณีที่ใช้ไม่ได้ — ❌ ห้ามแยกสาเหตุให้ปลายทางเห็น */
export function verifyLoginState(state: string, now: Date = new Date()): LoginState | null {
  const trimmed = state.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return null;

  let payload: string;
  try {
    payload = Buffer.from(trimmed.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = Buffer.from(sign(payload), 'utf8');
  const received = Buffer.from(trimmed.slice(dot + 1), 'utf8');

  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  const [gangId, userId, nonce, expiresAt] = payload.split('|');
  if (!gangId || !userId || !nonce || !expiresAt) return null;

  const expiresAtMs = Number(expiresAt) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return null;

  return { gangId, userId, nonce };
}

/** เทียบ nonce จาก cookie กับที่อยู่ใน state — timing-safe */
export function nonceMatches(fromState: string, fromCookie: string | null | undefined): boolean {
  if (!fromCookie) return false;

  const a = Buffer.from(fromState, 'utf8');
  const b = Buffer.from(fromCookie, 'utf8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
