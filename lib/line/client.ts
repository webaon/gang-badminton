import 'server-only';

/**
 * Messaging API client — **[WO-4.A]**
 *
 * 🔴 ตัดสินใจ: **ไม่ติดตั้ง `@line/bot-sdk`**
 *    baseline ระบุไลบรารีนี้ไว้ในลิสต์ แต่สิ่งที่เราต้องใช้จริงคือ HTTP call ไม่กี่เส้น
 *    (`/v2/bot/info` ที่นี่ · push message ใน WO-4.C) และ verify signature ที่เป็น
 *    HMAC-SHA256 ของ `node:crypto` ⇒ เพิ่ม dependency ใหม่พร้อม transitive ของมัน
 *    เพื่อสิ่งเหล่านี้ไม่คุ้ม (โปรเจกต์นี้มี `npm audit` ค้างอยู่แล้วใน BACKLOG)
 *    ⇒ ถ้าวันหนึ่งต้องใช้ Flex builder / webhook parser เต็มรูป ค่อยทบทวนใหม่
 *
 * 🔴 ห้าม log token และห้ามใส่ token ลงข้อความ error — error ของฟังก์ชันนี้ถูกส่งกลับ
 *    ไปโชว์ในหน้าตั้งค่า
 */

const LINE_API = 'https://api.line.me';

/** timeout สั้น — หน้าตั้งค่ารอไม่ได้นาน และปลายทางล่มเป็นเรื่องปกติ */
const TIMEOUT_MS = 8_000;

export type LineBotInfo = {
  displayName: string;
  basicId: string;
  premiumId: string | null;
};

export class LineApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LineApiError';
    this.status = status;
  }
}

/**
 * ข้อมูลบัญชี OA ของ token นี้ — ใช้เป็น "ปุ่มทดสอบการเชื่อมต่อ"
 *
 * เลือก endpoint นี้เพราะเป็น GET ที่ไม่ส่งข้อความหาใคร ⇒ กดทดสอบกี่ครั้งก็ไม่กินโควต้า
 */
export async function getBotInfo(accessToken: string): Promise<LineBotInfo> {
  let response: Response;

  try {
    response = await fetch(`${LINE_API}/v2/bot/info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    // ⚠️ ข้อความจาก fetch ไม่มี token อยู่แล้ว แต่ห่อใหม่ให้แน่ใจว่าไม่มีอะไรหลุดตามมา
    throw new LineApiError(0, err instanceof Error ? `ต่อ LINE ไม่ได้: ${err.message}` : 'ต่อ LINE ไม่ได้');
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LineApiError(
      response.status,
      response.status === 401
        ? 'token ไม่ถูกต้องหรือหมดอายุ'
        : `LINE ตอบ ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }

  const body = (await response.json()) as {
    displayName?: string;
    basicId?: string;
    premiumId?: string;
  };

  return {
    displayName: body.displayName ?? '(ไม่มีชื่อ)',
    basicId: body.basicId ?? '',
    premiumId: body.premiumId ?? null,
  };
}
