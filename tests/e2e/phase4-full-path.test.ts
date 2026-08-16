/**
 * 🎉 Phase 4 checkpoint — E2E ตาม `AGENT-EXECUTION.md` (WO-4.F)
 *
 *   ตั้งค่า LINE (Vault) → ผูกบัญชีผ่าน webhook จริง → ประกาศหนึ่งใบ →
 *   ได้ทั้งแถว `in_app` และ `line` → worker ส่งจริง → `notification_logs` นับโควต้าถูก →
 *   โควต้าเต็ม/เลิกผูก แล้วไม่มีแถว `line` อีก · และก๊วนที่ **ไม่ได้ต่อ LINE** ต้องทำงานเหมือนเดิม
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ ขอบเขตเดียวกับ E2E ของ Phase ก่อนๆ: เดินผ่าน **DB functions + domain + server จริง**
 *    ต่างกันตรงที่ปลายทาง LINE ถูกแทนด้วย `fetch` ปลอม (ยิง API จริงในเทสต์ไม่ได้)
 *    ⇒ ทุกอย่าง**ก่อนและหลัง** การยิงเป็นของจริงหมด: คิว · worker · backoff · `notification_logs`
 *
 * ⚠️ เส้นเต็มของ MVP-0 / Phase 2.5 / Phase 3 ต้องยังผ่าน — อยู่ใน `npm test` ชุดเดียวกัน
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { signLineBody } from '@/lib/line/signature';
import { mintLinkCode } from '@/lib/line/link-code';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.LINE_LINK_SECRET = 'test-link-secret-do-not-use-in-production';

const { handleLineWebhook } = await import('@/server/line/webhook');
const { dispatchNotifications } = await import('@/server/cron/notifications');

const TOKEN = 'ACCESS-TOKEN-1234567890abcdefWXYZ';
const SECRET = 'channel-secret-abcdef123456';

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await pool.end();
});

/**
 * LINE ปลอม — จำทุก push ที่ถูกยิงออกไป
 *
 * ⚠️ **ต้องส่ง request อื่นต่อให้ `fetch` ตัวจริง** — `supabase-js` ก็ใช้ `fetch` เหมือนกัน
 *    ดักทั้งหมดเมื่อไหร่ RPC ทุกตัวจะพังทันที (เสียเวลาไปแล้วรอบหนึ่ง)
 */
function stubLine(options: { fail?: boolean } = {}) {
  const pushes: { to: string; text: string }[] = [];
  const realFetch = globalThis.fetch;

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes('/v2/bot/message/push')) {
      const body = JSON.parse(String(init?.body)) as {
        to: string;
        messages: { text: string }[];
      };
      pushes.push({ to: body.to, text: body.messages[0].text });

      return options.fail
        ? new Response('{"message":"บอทถูกระงับ"}', { status: 403 })
        : new Response('{}', { status: 200 });
    }

    if (url.startsWith('https://api.line.me') || url.startsWith('https://access.line.me')) {
      throw new Error(`เทสต์นี้ไม่ควรยิงไปที่ ${url}`);
    }

    // ที่เหลือ (Supabase REST/RPC) ปล่อยผ่านไปของจริง
    return realFetch(input, init);
  });

  return pushes;
}

async function signUp(name: string): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), $1, jsonb_build_object('display_name', $2::text))
     returning id`,
    [`p4-${crypto.randomUUID()}@example.com`, name],
  );
  return row.id;
}

/**
 * รัน worker จนคิวหมด
 *
 * ⚠️ `dispatchNotifications()` หยิบงานของ **ทั้งฐานข้อมูล** ครั้งละ 25 แถวและเรียงตามเวลา
 *    ⇒ ของค้างจากเทสต์อื่นอาจกินโควต้าของ batch จนงานของเทสต์นี้ไม่ถูกหยิบ
 *    (เทสต์ไม่ล้างข้อมูลระหว่างรัน — ดู STATE.md §5)
 */
async function drainQueue(maxRounds = 30): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const result = await dispatchNotifications(crypto.randomUUID());
    if (result.claimed === 0) return;
  }
}

async function notificationsOf(gangId: string, eventType: string) {
  const { rows } = await pool.query<{
    channel: string;
    recipient_id: string;
    status: string;
    last_error: string | null;
  }>(
    `select channel, recipient_id, status, last_error from public.notifications
      where gang_id = $1 and event_type = $2`,
    [gangId, eventType],
  );
  return rows;
}

describe('🎉 Phase 4 checkpoint — เส้นเต็มของ LINE', () => {
  it('ตั้งค่า → ผูกบัญชี → ประกาศ → ส่งจริง → โควต้า → เลิกผูก ครบเส้น', async () => {
    const pushes = stubLine();

    // ── 1. ก๊วน + ตั้งค่า LINE ผ่าน Vault (WO-4.A) ────────────────────────
    const owner = await signUp('เจ้าของก๊วน');
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วน E2E LINE ${crypto.randomUUID()}`,
    ]);

    await pool.query(`select public.set_gang_line_credentials($1, $2, $3, 'liff-e2e', $4)`, [
      gang.id,
      TOKEN,
      SECRET,
      owner,
    ]);

    // 🔴 ตารางต้องไม่มี plaintext เลย
    const {
      rows: [config],
    } = await pool.query<{ dump: string }>(
      `select to_jsonb(c)::text as dump from public.gang_line_configs c where gang_id = $1`,
      [gang.id],
    );
    expect(config.dump).not.toContain(TOKEN);
    expect(config.dump).not.toContain(SECRET);

    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gang.id, owner]);

    // ── 2. สมาชิกสองคน: คนหนึ่งผูก LINE อีกคนไม่ผูก ───────────────────────
    const linkedMember = await signUp('คนที่ผูกไลน์');
    const plainMember = await signUp('คนที่ไม่ผูก');

    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role)
       values ($1, $2, 'member'), ($1, $3, 'member')`,
      [gang.id, linkedMember, plainMember],
    );

    // ผูกผ่าน **webhook จริง** (WO-4.B): ส่งรหัสในแชต + ลายเซ็นถูกต้อง
    const { code } = mintLinkCode(gang.id, linkedMember);
    const rawBody = JSON.stringify({
      destination: 'Uxxxx',
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: 'U-e2e-linked' },
          message: { type: 'text', text: code },
        },
      ],
    });

    const webhookResult = await handleLineWebhook({
      gangId: gang.id,
      rawBody,
      signature: signLineBody(rawBody, SECRET),
      correlationId: crypto.randomUUID(),
    });

    expect(webhookResult.status).toBe(200);
    expect(webhookResult.handled).toBe(1);

    // ลายเซ็นผิดต้องไม่ผ่านเด็ดขาด
    const badSignature = await handleLineWebhook({
      gangId: gang.id,
      rawBody,
      signature: signLineBody(rawBody, 'secret-ปลอม-123456'),
      correlationId: crypto.randomUUID(),
    });
    expect(badSignature.status).toBe(401);

    // ── 3. ประกาศหนึ่งใบ → fan-out สองช่องทาง (WO-3.D + WO-4.C) ──────────
    const {
      rows: [announcement],
    } = await pool.query<{ id: string }>(
      `insert into public.announcements (gang_id, title, body, created_by)
       values ($1, 'นัดพิเศษเสาร์นี้', 'เจอกันที่สนามเดิม', $2)
       returning id`,
      [gang.id, owner],
    );

    await pool.query(`select public.publish_announcement($1, $2)`, [announcement.id, owner]);

    const queued = await notificationsOf(gang.id, 'announcement.published');

    // เจ้าของ + สมาชิกสองคน = in_app 3 ใบ · line เฉพาะคนที่ผูกบัญชี 1 ใบ
    expect(queued.filter((n) => n.channel === 'in_app')).toHaveLength(3);
    const lineRows = queued.filter((n) => n.channel === 'line');
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0].recipient_id).toBe(linkedMember);

    // ── 4. worker ส่งจริง (WO-4.C) ───────────────────────────────────────
    await drainQueue();

    // ยิงไปที่บัญชี LINE ที่ผูกไว้ ด้วยข้อความของ event นั้น
    const announcementPush = pushes.find((p) => p.text.includes('นัดพิเศษเสาร์นี้'));
    expect(announcementPush?.to).toBe('U-e2e-linked');

    const lineRowAfterSend = (await notificationsOf(gang.id, 'announcement.published')).find(
      (n) => n.channel === 'line',
    );
    expect(lineRowAfterSend?.status).toBe('sent');

    // ข้อความยืนยันการผูกบัญชี (ของที่ WO-4.B ค้างไว้ แล้ว 4.C ปิด) ต้องถูกส่งด้วย
    expect(pushes.some((p) => p.text.includes('ผูกบัญชีเรียบร้อย'))).toBe(true);

    // ── 5. โควต้านับจาก notification_logs (WO-4.C) ───────────────────────
    const quota = async () => {
      const {
        rows: [row],
      } = await pool.query<{ used: number; monthly_quota: number | null; is_over: boolean }>(
        `select used, monthly_quota, is_over from public.line_quota_status($1)`,
        [gang.id],
      );
      return row;
    };

    const afterSend = await quota();
    // นับเฉพาะที่ยิงไปหาบัญชีของก๊วนนี้ (ประกาศ + ข้อความยืนยันการผูกบัญชี)
    expect(afterSend.used).toBe(pushes.filter((p) => p.to === 'U-e2e-linked').length);
    expect(afterSend.monthly_quota).toBe(200);
    expect(afterSend.is_over).toBe(false);

    // 🔴 โควต้าเต็ม → ไม่มีแถว line เกิดอีก (in_app ยังเข้าปกติ)
    await pool.query(`select public.set_gang_line_quota($1, $2, $3)`, [
      gang.id,
      afterSend.used,
      owner,
    ]);
    expect((await quota()).is_over).toBe(true);

    await pool.query(`select public.enqueue_notifications($1::jsonb)`, [
      JSON.stringify([
        {
          gang_id: gang.id,
          recipient_id: linkedMember,
          event_type: 'session.opened',
          payload: { session_title: 'ซ้อมวันอาทิตย์' },
          dedupe_key: `p4-quota:${crypto.randomUUID()}`,
        },
      ]),
    ]);

    const afterQuotaFull = await notificationsOf(gang.id, 'session.opened');
    expect(afterQuotaFull.filter((n) => n.channel === 'line')).toHaveLength(0);
    expect(afterQuotaFull.filter((n) => n.channel === 'in_app')).toHaveLength(1);

    // ── 6. เลิกผูกบัญชี → ไม่มีแถว line อีก (WO-4.D) ─────────────────────
    await pool.query(`select public.set_gang_line_quota($1, null, $2)`, [gang.id, owner]);
    await pool.query(`select public.unlink_line_account($1, $2)`, [gang.id, linkedMember]);

    await pool.query(`select public.enqueue_notifications($1::jsonb)`, [
      JSON.stringify([
        {
          gang_id: gang.id,
          recipient_id: linkedMember,
          event_type: 'payment.due',
          payload: {},
          dedupe_key: `p4-unlinked:${crypto.randomUUID()}`,
        },
      ]),
    ]);

    const afterUnlink = await notificationsOf(gang.id, 'payment.due');
    expect(afterUnlink.filter((n) => n.channel === 'line')).toHaveLength(0);
    expect(afterUnlink.filter((n) => n.channel === 'in_app')).toHaveLength(1);
  });

  it('🔴 ก๊วนที่ไม่ได้ต่อ LINE เลย ทำงานเหมือนเดิมทุกประการ', async () => {
    const pushes = stubLine();

    const owner = await signUp('เจ้าของก๊วนไม่มีไลน์');
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วนไม่มีไลน์ ${crypto.randomUUID()}`,
    ]);

    const member = await signUp('สมาชิก');
    await pool.query(
      `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
      [gang.id, member],
    );

    const {
      rows: [announcement],
    } = await pool.query<{ id: string }>(
      `insert into public.announcements (gang_id, title, body, created_by)
       values ($1, 'ประกาศธรรมดา', 'เนื้อหา', $2) returning id`,
      [gang.id, owner],
    );
    await pool.query(`select public.publish_announcement($1, $2)`, [announcement.id, owner]);

    const queued = await notificationsOf(gang.id, 'announcement.published');
    expect(queued).toHaveLength(2);
    expect(queued.every((n) => n.channel === 'in_app')).toBe(true);

    await drainQueue();

    // ⚠️ ไม่ assert `pushes.length === 0` แบบรวม — worker หยิบงานของ **ทั้งฐานข้อมูล**
    //    ซึ่งมีของค้างจากเทสต์อื่นได้ ⇒ ข้อสรุปที่เชื่อถือได้คือ "ก๊วนนี้ไม่มี LINE เลย"
    expect(pushes.every((p) => p.text !== 'ประกาศธรรมดา')).toBe(true);

    // ไม่มีแถวหรือ log ของ channel line ของก๊วนนี้
    const {
      rows: [logs],
    } = await pool.query<{ n: string }>(
      `select count(*)::text n from public.notification_logs where gang_id = $1 and channel = 'line'`,
      [gang.id],
    );
    expect(Number(logs.n)).toBe(0);
  });

  it('LINE ตอบ error → เข้า backoff เดิม ไม่ mark sent หลอกๆ และไม่กินโควต้า', async () => {
    stubLine({ fail: true });

    const owner = await signUp('เจ้าของก๊วนไลน์ล่ม');
    const {
      rows: [gang],
    } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
      owner,
      `ก๊วนไลน์ล่ม ${crypto.randomUUID()}`,
    ]);

    await pool.query(`select public.set_gang_line_credentials($1, $2, $3, null, $4)`, [
      gang.id,
      TOKEN,
      SECRET,
      owner,
    ]);
    await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gang.id, owner]);
    await pool.query(`select public.link_line_account($1, $2, 'U-e2e-fail')`, [gang.id, owner]);

    await pool.query(`select public.enqueue_notifications($1::jsonb)`, [
      JSON.stringify([
        {
          gang_id: gang.id,
          recipient_id: owner,
          event_type: 'session.reminder',
          payload: { session_title: 'ซ้อมเย็นนี้' },
          dedupe_key: `p4-fail:${crypto.randomUUID()}`,
        },
      ]),
    ]);

    await drainQueue();

    const rows = await notificationsOf(gang.id, 'session.reminder');
    const lineRow = rows.find((n) => n.channel === 'line')!;

    // กลับเข้าคิวรอ retry พร้อมเหตุผล — ไม่ใช่ sent
    expect(lineRow.status).toBe('pending');
    expect(lineRow.last_error).toContain('403');

    // in_app ของงานเดียวกันยังส่งถึงตามปกติ
    expect(rows.find((n) => n.channel === 'in_app')?.status).toBe('sent');

    // ส่งไม่สำเร็จ = ไม่กินโควต้า
    const {
      rows: [quota],
    } = await pool.query<{ used: number }>(`select used from public.line_quota_status($1)`, [
      gang.id,
    ]);
    expect(quota.used).toBe(0);
  });
});
