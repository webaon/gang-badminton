import 'server-only';

import { timingSafeEqual } from 'node:crypto';

/**
 * ตรวจว่า request มาจาก scheduler จริง ไม่ใช่ใครก็ได้ที่เดา URL เจอ
 *
 * Vercel Cron ส่ง header `Authorization: Bearer <CRON_SECRET>` มาให้เอง
 * (ค่าเดียวกับ env `CRON_SECRET` ของโปรเจกต์)
 *
 * 🔴 ใช้ timing-safe compare — `===` บน string เปรียบเทียบแบบ short-circuit
 *    ⇒ เวลาที่ใช้ต่างกันตามจำนวนตัวอักษรที่ตรง ซึ่งเดา secret ทีละตัวได้
 *
 * 🔴 ไม่มี CRON_SECRET ตั้งไว้ = ปฏิเสธทุก request (fail-closed)
 *    ห้ามทำเป็น "ถ้าไม่ตั้งก็ปล่อยผ่าน" เพราะ endpoint นี้แตะข้อมูลทุกก๊วน
 */
export function isAuthorizedCronRequest(headers: Headers): boolean {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    console.error('[cron] ไม่ได้ตั้ง CRON_SECRET — ปฏิเสธ request ทั้งหมด');
    return false;
  }

  const auth = headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return false;

  return safeEqual(auth.slice('Bearer '.length), expected);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  // timingSafeEqual โยน error ถ้าความยาวไม่เท่ากัน — เทียบความยาวก่อน
  // (ความยาวของ secret ไม่ใช่ความลับที่มีค่าพอจะต้องปิด)
  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}
