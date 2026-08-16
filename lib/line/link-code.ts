import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * รหัสผูกบัญชี LINE แบบ **stateless** — **[WO-4.B]**
 *
 * ❗ กติกาของ Phase 4: **ห้ามเพิ่มตารางนอก baseline** ⇒ ห้ามมีตาราง "รหัสผูกบัญชีที่ออกไปแล้ว"
 *    รหัสจึงต้อง **พกข้อมูลของตัวเอง** มาพร้อมลายเซ็น: ใครออก · ก๊วนไหน · หมดอายุเมื่อไหร่
 *
 * รูปแบบ: `<payload>.<sig>` (base64url ทั้งคู่)
 *   payload = `<userId>|<expiresAtEpochSeconds>`
 *   sig     = HMAC-SHA256(payload + gangId) ตัด 12 ไบต์แรก ด้วย key จาก env
 *
 * 🔴 `gangId` **ไม่ได้อยู่ใน payload แต่ถูกผูกเข้าไปในลายเซ็น** ⇒ รหัสของก๊วนหนึ่ง
 *    ใช้กับอีกก๊วนไม่ได้เลย โดยที่รหัสไม่ยาวขึ้น
 *
 * ⚠️ ผู้ใช้ต้อง **คัดลอกรหัสไปวางในแชต OA** (ยาวเกินกว่าจะพิมพ์เอง) — ยอมรับได้ในใบนี้
 *    เพราะ `WO-4.D` (LINE Login) จะทำให้ไม่ต้องพิมพ์อะไรเลย · หน้าเว็บมีปุ่มคัดลอกให้
 */

const DEFAULT_TTL_SECONDS = 15 * 60;

function secret(): string {
  const value = process.env.LINE_LINK_SECRET;

  if (!value) {
    // 🔴 fail-closed — ไม่มี key = ออกรหัสไม่ได้และตรวจรหัสไม่ผ่าน
    throw new Error('ตั้งค่า LINE_LINK_SECRET ก่อน (ดู .env.example)');
  }

  return value;
}

function sign(payload: string, gangId: string): string {
  return createHmac('sha256', secret())
    .update(`${payload}|${gangId}`, 'utf8')
    .digest()
    .subarray(0, 12)
    .toString('base64url');
}

export function mintLinkCode(
  gangId: string,
  userId: string,
  now: Date = new Date(),
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): { code: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const payload = `${userId}|${Math.floor(expiresAt.getTime() / 1000)}`;

  return {
    code: `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload, gangId)}`,
    expiresAt,
  };
}

/**
 * คืน `userId` ถ้ารหัสถูกต้องและยังไม่หมดอายุ · คืน `null` ทุกกรณีที่ใช้ไม่ได้
 *
 * ❌ ห้ามแยกข้อความว่า "รหัสผิด" กับ "รหัสหมดอายุ" ให้คนนอกเห็น — ที่นี่จึงคืน `null` เหมือนกันหมด
 */
export function verifyLinkCode(
  code: string,
  gangId: string,
  now: Date = new Date(),
): string | null {
  const trimmed = code.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return null;

  const encodedPayload = trimmed.slice(0, dot);
  const signature = trimmed.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = Buffer.from(sign(payload, gangId), 'utf8');
  const received = Buffer.from(signature, 'utf8');

  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  const [userId, expiresAt] = payload.split('|');
  if (!userId || !expiresAt) return null;

  const expiresAtMs = Number(expiresAt) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return null;

  return userId;
}

/** ดึงรหัสออกจากข้อความที่ผู้ใช้พิมพ์/วางในแชต (อาจมีข้อความอื่นปนมา) */
export function extractLinkCode(text: string): string | null {
  const match = text.match(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{12,}/);
  return match?.[0] ?? null;
}
