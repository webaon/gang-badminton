/**
 * ประกอบ path ของไฟล์ใน Supabase Storage — **ที่เดียวในระบบ**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 [D-15] ทำไมต้องรวมไว้ที่เดียว
 *
 * `storage.objects` ไม่มีคอลัมน์ `gang_id` ⇒ RLS policy ตรวจสิทธิ์จาก **ชื่อไฟล์**
 * โดยอ่านโฟลเดอร์แรกด้วย `(storage.foldername(name))[1]` แล้วเอาไปเทียบกับ
 * `is_gang_member()` / `is_gang_admin()` (ดู migration 0011)
 *
 * ⇒ **path ผิด = สิทธิ์ผิดทันที** ไม่ใช่แค่ไฟล์อยู่ผิดที่
 *   - วางสลิปของก๊วน A ไว้ใต้โฟลเดอร์ก๊วน B = แอดมินก๊วน B เปิดดูได้
 *   - ถ้าปล่อยให้ client ส่ง path มาเอง = ใครก็เขียนไฟล์ใต้ก๊วนใครก็ได้
 *
 * ⇒ กติกา: **server เป็นคนประกอบ path เสมอ ห้ามรับ path จาก client**
 *   client ส่งได้แค่ "ไฟล์" กับ "ตัวตนของสิ่งที่ไฟล์นั้นสังกัด" (gang id, payment id, …)
 */

export const BUCKETS = {
  paymentSlips: 'payment-slips',
  avatars: 'avatars',
  gangAssets: 'gang-assets',
  announcementImages: 'announcement-images',
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

/** UUID v1-v8 รูปแบบมาตรฐาน */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) {
    // ถ้าหลุดมาได้แปลว่ามีคนเอา input ดิบจาก client มาต่อ path — ต้องดังตั้งแต่ตรงนี้
    throw new Error(`storage path: ${label} ต้องเป็น UUID เท่านั้น (ได้ "${value}")`);
  }
  return value.toLowerCase();
}

/**
 * ทำชื่อไฟล์ให้ปลอดภัย
 *
 * 🔴 นี่คือด่านที่กัน path traversal — ถ้าปล่อย `../` ผ่านไปได้
 *    `<gangA>/../<gangB>/slip.jpg` จะทำให้ `foldername()[1]` กลายเป็นก๊วน A
 *    ทั้งที่ไฟล์ไปโผล่ใต้ก๊วน B ⇒ ตรวจสิทธิ์ผิดฝั่ง
 *
 * เก็บเฉพาะ [a-z0-9._-] ตัดที่เหลือทิ้ง แล้วบังคับให้ไม่ว่างและไม่ขึ้นต้นด้วยจุด
 */
export function safeFileName(input: string): string {
  const base = input.split(/[/\\]/).pop() ?? '';

  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+/, '') // กัน ".." และไฟล์ซ่อน
    .slice(0, 100);

  return cleaned === '' ? 'file' : cleaned;
}

/**
 * `payment-slips/<gang_id>/<payment_id>/<file>`
 *
 * bucket private — อ่านได้เฉพาะเจ้าของสลิปกับแอดมินของก๊วนตาม path[1]
 */
export function paymentSlipPath(
  gangId: string,
  paymentId: string,
  fileName: string,
): string {
  return [
    assertUuid(gangId, 'gangId'),
    assertUuid(paymentId, 'paymentId'),
    safeFileName(fileName),
  ].join('/');
}

/**
 * `avatars/<user_id>/<file>`
 *
 * ⚠️ bucket **public** — ใครมี URL ก็เปิดดูได้โดยไม่ผ่าน RLS
 */
export function avatarPath(userId: string, fileName: string): string {
  return [assertUuid(userId, 'userId'), safeFileName(fileName)].join('/');
}

/**
 * `gang-assets/<gang_id>/<file>`
 *
 * ⚠️ bucket **public** — ห้ามเอาของที่เป็นความลับมาวาง
 */
export function gangAssetPath(gangId: string, fileName: string): string {
  return [assertUuid(gangId, 'gangId'), safeFileName(fileName)].join('/');
}

/** `announcement-images/<gang_id>/<file>` — สมาชิกก๊วนนั้นอ่านได้ */
export function announcementImagePath(gangId: string, fileName: string): string {
  return [assertUuid(gangId, 'gangId'), safeFileName(fileName)].join('/');
}

/**
 * อ่าน tenant key (โฟลเดอร์แรก) กลับจาก path — ให้ตรงกับที่ policy ใช้
 * มีไว้ให้ฝั่ง server ตรวจซ้ำก่อนเรียก storage API
 */
export function tenantKeyOf(path: string): string | null {
  const first = path.split('/')[0];
  return first && UUID_RE.test(first) ? first.toLowerCase() : null;
}
