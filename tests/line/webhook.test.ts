/**
 * WO-4.B DoD — webhook ต่อก๊วน + ผูกบัญชี
 *
 *   · 🔴 ลายเซ็นไม่ถูก = 401 ทุกกรณี และตรวจจาก **raw body**
 *   · 🔴 ก๊วนที่ปิด `features.line` / ยังไม่ตั้งค่า → ปฏิเสธ
 *   · webhook ของก๊วน A ใช้ secret ของก๊วน B ไม่ผ่าน
 *   · `unfollow` = หยุดส่ง LINE ให้คนนั้น · `follow` = ปลดให้เอง
 *   · ผูกบัญชีซ้ำ/ข้ามก๊วนไม่ได้แถวซ้ำ · รหัสผูกบัญชีเป็น stateless (ไม่มีตารางรหัส)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { signLineBody, verifyLineSignature } from '@/lib/line/signature';
import { extractLinkCode, mintLinkCode, verifyLinkCode } from '@/lib/line/link-code';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.LINE_LINK_SECRET = 'test-link-secret-do-not-use-in-production';

const { handleLineWebhook } = await import('@/server/line/webhook');

const TOKEN = 'ACCESS-TOKEN-1234567890abcdefWXYZ';
const SECRET = 'channel-secret-abcdef123456';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`hook-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

/** ก๊วนที่ตั้งค่า LINE ครบและเปิดใช้งานแล้ว */
async function lineGang(opts: { enabled?: boolean; secret?: string } = {}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนไลน์-${crypto.randomUUID()}`,
  ]);

  await pool.query(`select public.set_gang_line_credentials($1, $2, $3, null, $4)`, [
    gang.id,
    TOKEN,
    opts.secret ?? SECRET,
    owner,
  ]);

  if (opts.enabled ?? true) {
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gang.id, owner]);
  }

  return { owner, gangId: gang.id, secret: opts.secret ?? SECRET };
}

async function member(gangId: string): Promise<string> {
  const userId = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gangId, userId],
  );
  return userId;
}

function body(events: unknown[]): string {
  return JSON.stringify({ destination: 'Uxxxx', events });
}

function messageEvent(lineUserId: string, text: string) {
  return { type: 'message', source: { type: 'user', userId: lineUserId }, message: { type: 'text', text } };
}

async function post(
  gangId: string,
  raw: string,
  signature: string | null,
): ReturnType<typeof handleLineWebhook> {
  return handleLineWebhook({
    gangId,
    rawBody: raw,
    signature,
    correlationId: `test-${crypto.randomUUID()}`,
  });
}

async function linkRow(gangId: string, lineUserId: string) {
  const {
    rows: [row],
  } = await pool.query<{ user_id: string; blocked_at: string | null }>(
    `select user_id, blocked_at from public.member_line_links
      where gang_id = $1 and line_user_id = $2`,
    [gangId, lineUserId],
  );
  return row ?? null;
}

describe('WO-4.B DoD — ลายเซ็น', () => {
  it('ลายเซ็นถูก → 200', async () => {
    const { gangId } = await lineGang();
    const raw = body([]);

    const result = await post(gangId, raw, signLineBody(raw, SECRET));
    expect(result.status).toBe(200);
  });

  it('🔴 ไม่มี header ลายเซ็น → 401', async () => {
    const { gangId } = await lineGang();
    const raw = body([]);

    expect((await post(gangId, raw, null)).status).toBe(401);
  });

  it('🔴 ลายเซ็นผิด → 401', async () => {
    const { gangId } = await lineGang();
    const raw = body([]);

    const result = await post(gangId, raw, signLineBody(raw, 'secret-ของคนอื่น-1234'));
    expect(result.status).toBe(401);
    expect(result.errorCode).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('🔴 body ถูกแก้ระหว่างทาง → 401 (ลายเซ็นผูกกับ raw body)', async () => {
    const { gangId } = await lineGang();
    const original = body([messageEvent('U-attacker', 'สวัสดี')]);
    const signature = signLineBody(original, SECRET);

    const tampered = body([messageEvent('U-attacker', 'สวัสดีแก้แล้ว')]);
    expect((await post(gangId, tampered, signature)).status).toBe(401);
  });

  it('🔴 เซ็นจาก JSON ที่ parse แล้ว stringify ใหม่ → ไม่ผ่าน (ต้องใช้ raw body เท่านั้น)', () => {
    const raw = '{"events": [ {"type":"follow"} ]}'; // มีช่องว่างแบบที่ LINE ส่งมา
    const signature = signLineBody(raw, SECRET);
    const reserialized = JSON.stringify(JSON.parse(raw));

    expect(verifyLineSignature(raw, signature, SECRET)).toBe(true);
    expect(verifyLineSignature(reserialized, signature, SECRET)).toBe(false);
  });

  it('🔴 ไม่มี channel secret = ไม่ผ่าน (fail-closed)', () => {
    const raw = body([]);
    expect(verifyLineSignature(raw, signLineBody(raw, SECRET), null)).toBe(false);
  });

  it('🔴 secret ของก๊วนอื่นใช้กับ webhook ก๊วนนี้ไม่ได้', async () => {
    const a = await lineGang();
    const b = await lineGang({ secret: 'channel-secret-ของก๊วนบี-999999' });

    const raw = body([]);
    expect((await post(a.gangId, raw, signLineBody(raw, b.secret))).status).toBe(401);
    expect((await post(a.gangId, raw, signLineBody(raw, a.secret))).status).toBe(200);
  });
});

describe('WO-4.B DoD — ก๊วนที่ยังไม่พร้อม', () => {
  it('ยังไม่ได้ตั้งค่า LINE → 404 (ไม่มี secret ให้ verify)', async () => {
    const owner = await newUser();
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วนไม่มีไลน์-${crypto.randomUUID()}`,
    ]);

    const raw = body([]);
    const result = await post(gang.id, raw, signLineBody(raw, SECRET));
    expect(result.status).toBe(404);
  });

  it('🔴 ปิด features.line อยู่ → 403 แม้ลายเซ็นถูก', async () => {
    const { gangId } = await lineGang({ enabled: false });
    const raw = body([]);

    const result = await post(gangId, raw, signLineBody(raw, SECRET));
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe('FEATURE_DISABLED');
  });

  it('body ที่ไม่ใช่ JSON → 400 (แต่ต้องผ่านลายเซ็นมาก่อน)', async () => {
    const { gangId } = await lineGang();
    const raw = 'ไม่ใช่ json';

    expect((await post(gangId, raw, signLineBody(raw, SECRET))).status).toBe(400);
  });
});

describe('WO-4.B DoD — ผูกบัญชีด้วยรหัส stateless', () => {
  it('ส่งรหัสในแชต → ผูกบัญชีสำเร็จ', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);
    const { code } = mintLinkCode(gangId, userId);

    const raw = body([messageEvent('U-line-1', code)]);
    const result = await post(gangId, raw, signLineBody(raw, SECRET));

    expect(result.status).toBe(200);
    expect(result.handled).toBe(1);
    expect((await linkRow(gangId, 'U-line-1'))?.user_id).toBe(userId);
  });

  it('รหัสมีข้อความอื่นปนมาก็ยังใช้ได้ (ผู้ใช้วางทั้งประโยค)', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);
    const { code } = mintLinkCode(gangId, userId);

    const raw = body([messageEvent('U-line-2', `ผูกบัญชี ${code} ครับ`)]);
    await post(gangId, raw, signLineBody(raw, SECRET));

    expect((await linkRow(gangId, 'U-line-2'))?.user_id).toBe(userId);
  });

  it('🔴 รหัสของก๊วนอื่นใช้ไม่ได้ (gangId อยู่ในลายเซ็นของรหัส)', async () => {
    const a = await lineGang();
    const b = await lineGang();
    const userId = await member(a.gangId);

    const { code } = mintLinkCode(a.gangId, userId);
    expect(verifyLinkCode(code, b.gangId)).toBeNull();

    const raw = body([messageEvent('U-line-3', code)]);
    const result = await post(b.gangId, raw, signLineBody(raw, b.secret));

    expect(result.handled).toBe(0);
    expect(await linkRow(b.gangId, 'U-line-3')).toBeNull();
  });

  it('🔴 รหัสหมดอายุใช้ไม่ได้', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { code } = mintLinkCode(gangId, userId, past, 60);

    expect(verifyLinkCode(code, gangId)).toBeNull();
  });

  it('รหัสที่ถูกแก้แม้ตัวเดียวใช้ไม่ได้', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);
    const { code } = mintLinkCode(gangId, userId);

    const [payload, sig] = code.split('.');
    expect(verifyLinkCode(`${payload}.${sig.slice(0, -1)}X`, gangId)).toBeNull();
  });

  it('ข้อความที่ไม่มีรหัสถูกเมินเฉยๆ (ไม่ใช่ error)', async () => {
    const { gangId } = await lineGang();
    const raw = body([messageEvent('U-line-4', 'วันนี้เล่นกี่โมง')]);

    const result = await post(gangId, raw, signLineBody(raw, SECRET));
    expect(result.status).toBe(200);
    expect(result.ignored).toBe(1);
    expect(extractLinkCode('วันนี้เล่นกี่โมง')).toBeNull();
  });

  it('🔴 คนที่ไม่ใช่สมาชิกก๊วน ผูกไม่ได้', async () => {
    const { gangId } = await lineGang();
    const outsider = await newUser();
    const { code } = mintLinkCode(gangId, outsider);

    const raw = body([messageEvent('U-line-5', code)]);
    const result = await post(gangId, raw, signLineBody(raw, SECRET));

    expect(result.handled).toBe(0);
    expect(await linkRow(gangId, 'U-line-5')).toBeNull();
  });

  it('🔴 LINE ใบเดียวผูกกับสมาชิกสองคนในก๊วนเดียวกันไม่ได้', async () => {
    const { gangId } = await lineGang();
    const first = await member(gangId);
    const second = await member(gangId);

    const raw1 = body([messageEvent('U-shared', mintLinkCode(gangId, first).code)]);
    await post(gangId, raw1, signLineBody(raw1, SECRET));

    const raw2 = body([messageEvent('U-shared', mintLinkCode(gangId, second).code)]);
    const result = await post(gangId, raw2, signLineBody(raw2, SECRET));

    expect(result.handled).toBe(0);
    expect((await linkRow(gangId, 'U-shared'))?.user_id).toBe(first);
  });

  it('สมาชิกเปลี่ยนบัญชี LINE ได้ (แถวเดิมถูกย้าย ไม่ใช่เพิ่มแถวใหม่)', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);

    for (const lineId of ['U-old', 'U-new']) {
      const raw = body([messageEvent(lineId, mintLinkCode(gangId, userId).code)]);
      await post(gangId, raw, signLineBody(raw, SECRET));
    }

    const {
      rows: [count],
    } = await pool.query<{ n: string }>(
      `select count(*)::text n from public.member_line_links where gang_id = $1 and user_id = $2`,
      [gangId, userId],
    );

    expect(Number(count.n)).toBe(1);
    expect(await linkRow(gangId, 'U-old')).toBeNull();
    expect((await linkRow(gangId, 'U-new'))?.user_id).toBe(userId);
  });
});

describe('WO-4.B DoD — follow / unfollow', () => {
  it('🔴 unfollow → ทำเครื่องหมายว่าส่งไม่ได้ (ไม่ลบความสัมพันธ์ทิ้ง)', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);

    const linkBody = body([messageEvent('U-block', mintLinkCode(gangId, userId).code)]);
    await post(gangId, linkBody, signLineBody(linkBody, SECRET));

    const raw = body([{ type: 'unfollow', source: { type: 'user', userId: 'U-block' } }]);
    await post(gangId, raw, signLineBody(raw, SECRET));

    const row = await linkRow(gangId, 'U-block');
    expect(row?.user_id).toBe(userId);
    expect(row?.blocked_at).not.toBeNull();
  });

  it('follow กลับ → ปลดเองโดยไม่ต้องผูกใหม่', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);

    const linkBody = body([messageEvent('U-refollow', mintLinkCode(gangId, userId).code)]);
    await post(gangId, linkBody, signLineBody(linkBody, SECRET));

    for (const type of ['unfollow', 'follow']) {
      const raw = body([{ type, source: { type: 'user', userId: 'U-refollow' } }]);
      await post(gangId, raw, signLineBody(raw, SECRET));
    }

    expect((await linkRow(gangId, 'U-refollow'))?.blocked_at).toBeNull();
  });

  it('follow ของคนที่ยังไม่เคยผูกบัญชี → ไม่ใช่ error', async () => {
    const { gangId } = await lineGang();
    const raw = body([{ type: 'follow', source: { type: 'user', userId: 'U-stranger' } }]);

    expect((await post(gangId, raw, signLineBody(raw, SECRET))).status).toBe(200);
  });

  it('event หลายอันในก้อนเดียวถูกจัดการครบ', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);

    const raw = body([
      messageEvent('U-multi', mintLinkCode(gangId, userId).code),
      { type: 'follow', source: { type: 'user', userId: 'U-multi' } },
      { type: 'join', source: { type: 'group', groupId: 'G-1' } },
    ]);

    const result = await post(gangId, raw, signLineBody(raw, SECRET));
    expect(result.handled).toBe(2);
    expect(result.ignored).toBe(1); // event ที่ไม่มี userId
  });
});

describe('WO-4.B — ด่านของฐานข้อมูล', () => {
  it('🔴 ผู้ใช้เรียกฟังก์ชันผูกบัญชีตรงไม่ได้', async () => {
    const { gangId, owner } = await lineGang();

    const { asRole } = await import('../helpers/db');
    await asRole('authenticated', owner, async (c) => {
      await expect(
        c.query(`select public.link_line_account($1, $2, 'U-hack')`, [gangId, owner]),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('🔴 สมาชิกเขียน `member_line_links` ตรงไม่ได้', async () => {
    const { gangId } = await lineGang();
    const userId = await member(gangId);

    const { asRole } = await import('../helpers/db');
    await asRole('authenticated', userId, async (c) => {
      await expect(
        c.query(
          `insert into public.member_line_links (gang_id, user_id, line_user_id)
           values ($1, $2, 'U-self')`,
          [gangId, userId],
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });
  });

  it('สมาชิกอ่านแถวของตัวเองได้ แต่ของคนอื่นไม่ได้', async () => {
    const { gangId } = await lineGang();
    const mine = await member(gangId);
    const other = await member(gangId);

    for (const [userId, lineId] of [
      [mine, 'U-mine'],
      [other, 'U-other'],
    ] as const) {
      const raw = body([messageEvent(lineId, mintLinkCode(gangId, userId).code)]);
      await post(gangId, raw, signLineBody(raw, SECRET));
    }

    const { visibleCount } = await import('../helpers/db');
    const sql = 'select 1 from public.member_line_links where gang_id = $1 and user_id = $2';

    expect(await visibleCount(mine, sql, [gangId, mine])).toBe(1);
    expect(await visibleCount(mine, sql, [gangId, other])).toBe(0);
  });
});
