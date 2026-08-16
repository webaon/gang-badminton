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

/**
 * ส่งข้อความหาผู้ใช้คนเดียว — **[WO-4.C]**
 *
 * ⚠️ push **กินโควต้าของก๊วน** (ต่างจาก `/v2/bot/info` ที่เป็น GET)
 *    ⇒ ผู้เรียกต้องตรวจโควต้าก่อนเสมอ และบันทึกผลลง `notification_logs` ผ่าน
 *      `mark_notification_sent()` (ตัวนับโควต้าอ่านจากที่นั่นที่เดียว)
 *
 * 🔴 โยน `LineApiError` เมื่อส่งไม่สำเร็จ — worker จะเอาไปเข้า backoff เดิม
 *    ❌ ห้าม "กลืน" แล้ว mark sent เพราะจะกลายเป็นข้อความที่หายไปเงียบๆ
 */
export async function pushTextMessage(
  accessToken: string,
  to: string,
  text: string,
): Promise<void> {
  let response: Response;

  try {
    response = await fetch(`${LINE_API}/v2/bot/message/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    throw new LineApiError(0, err instanceof Error ? `ส่ง LINE ไม่ได้: ${err.message}` : 'ส่ง LINE ไม่ได้');
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LineApiError(
      response.status,
      `LINE ตอบ ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// LINE Login (OAuth 2.1) — **[WO-4.D]**
// ---------------------------------------------------------------------------

const LINE_AUTH = 'https://access.line.me';

/** URL ที่พาผู้ใช้ไปหน้า "อนุญาต" ของ LINE */
export function loginAuthorizeUrl(input: {
  channelId: string;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.channelId,
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: 'profile openid',
    nonce: input.nonce,
  });

  return `${LINE_AUTH}/oauth2/v2.1/authorize?${params.toString()}`;
}

/**
 * แลก `code` เป็น access token แล้วอ่านโปรไฟล์เพื่อเอา **`userId` ของ LINE**
 *
 * 🔴 ทำ **ฝั่ง server เท่านั้น** (ใช้ channel secret) และ ❌ **ห้าม log `id_token`/token ใดๆ**
 *
 * ⚠️ อ่าน `userId` จาก `/v2/profile` แทนการถอด `id_token` เอง — ได้ค่าเดียวกันโดยไม่ต้อง
 *    verify JWT เอง (ซึ่งพลาดแล้วกลายเป็นช่องโหว่ทันที)
 */
export async function exchangeLoginCode(input: {
  code: string;
  redirectUri: string;
  channelId: string;
  channelSecret: string;
}): Promise<{ lineUserId: string; displayName: string }> {
  const tokenResponse = await fetch(`${LINE_API}/oauth2/v2.1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.channelId,
      client_secret: input.channelSecret,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!tokenResponse.ok) {
    throw new LineApiError(tokenResponse.status, `แลก code กับ LINE ไม่สำเร็จ (${tokenResponse.status})`);
  }

  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new LineApiError(0, 'LINE ไม่ได้คืน access token');

  const profileResponse = await fetch(`${LINE_API}/v2/profile`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!profileResponse.ok) {
    throw new LineApiError(profileResponse.status, `อ่านโปรไฟล์ LINE ไม่สำเร็จ (${profileResponse.status})`);
  }

  const profile = (await profileResponse.json()) as { userId?: string; displayName?: string };
  if (!profile.userId) throw new LineApiError(0, 'LINE ไม่ได้คืน userId');

  return { lineUserId: profile.userId, displayName: profile.displayName ?? '' };
}
