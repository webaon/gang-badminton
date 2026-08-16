/**
 * WO-4.D DoD — LINE Login
 *
 *   · 🔴 `state` เซ็นไว้ + `nonce` ต้องตรงกับ cookie → callback ที่ไม่มี/ผิด ต้องปฏิเสธ
 *   · 🔴 ผูกได้เฉพาะผู้ใช้ที่ล็อกอินอยู่ และต้องเป็นคนเดียวกับใน state
 *   · LINE ใบเดียวผูกได้บัญชีเดียวต่อก๊วน
 *   · 🔴 เลิกผูกแล้วงาน LINE ที่ค้างในคิว **ไม่ถูกส่ง**
 *   · ❗ ไม่มีตารางเก็บ state/nonce (stateless ทั้งคู่)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';
import { mintLoginState, nonceMatches, verifyLoginState } from '@/lib/line/login-state';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.LINE_LINK_SECRET = 'test-link-secret-do-not-use-in-production';

const { handleLoginCallback } = await import('@/server/line/login');

const TOKEN = 'ACCESS-TOKEN-1234567890abcdefWXYZ';
const SECRET = 'channel-secret-abcdef123456';
const LOGIN_CHANNEL = '2001234567';
const LOGIN_SECRET = 'login-channel-secret-abcdef';

afterAll(async () => {
  await pool.end();
});

async function newUser(): Promise<string> {
  const {
    rows: [row],
  } = await pool.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [`login-${crypto.randomUUID()}@example.com`],
  );
  return row.id;
}

async function gangWithLogin(opts: { login?: boolean } = {}) {
  const owner = await newUser();
  const {
    rows: [gang],
  } = await pool.query<{ id: string }>(`select id from public.create_gang($1, $2)`, [
    owner,
    `ก๊วนล็อกอิน-${crypto.randomUUID()}`,
  ]);

  await pool.query(`select public.set_gang_line_credentials($1, $2, $3, null, $4)`, [
    gang.id,
    TOKEN,
    SECRET,
    owner,
  ]);
  await pool.query(`select public.set_gang_line_enabled($1, true, $2)`, [gang.id, owner]);

  if (opts.login ?? true) {
    await pool.query(`select public.set_gang_line_login($1, $2, $3, $4)`, [
      gang.id,
      LOGIN_CHANNEL,
      LOGIN_SECRET,
      owner,
    ]);
  }

  return { owner, gangId: gang.id };
}

async function member(gangId: string): Promise<string> {
  const userId = await newUser();
  await pool.query(
    `insert into public.gang_members (gang_id, user_id, role) values ($1, $2, 'member')`,
    [gangId, userId],
  );
  return userId;
}

/** แทน LINE จริง — คืน userId ที่กำหนดเอง */
function fakeExchange(lineUserId: string) {
  return async () => ({ lineUserId, displayName: 'ทดสอบ' });
}

async function callback(input: {
  gangId: string;
  userId: string;
  signedInAs?: string | null;
  lineUserId?: string;
  overrides?: Partial<{ state: string | null; nonceCookie: string | null; code: string | null }>;
}) {
  const { state, nonce } = mintLoginState(input.gangId, input.userId);

  return handleLoginCallback(
    {
      code: input.overrides?.code === undefined ? 'auth-code' : input.overrides.code,
      state: input.overrides?.state === undefined ? state : input.overrides.state,
      error: null,
      nonceCookie: input.overrides?.nonceCookie === undefined ? nonce : input.overrides.nonceCookie,
      redirectUri: 'https://example.com/api/line/login/callback',
      correlationId: `test-${crypto.randomUUID()}`,
    },
    {
      currentUserId: async () =>
        input.signedInAs === undefined ? input.userId : input.signedInAs,
      exchange: fakeExchange(input.lineUserId ?? `U-login-${crypto.randomUUID().slice(0, 8)}`),
    },
  );
}

async function linkedLineId(gangId: string, userId: string): Promise<string | null> {
  const {
    rows: [row],
  } = await pool.query<{ line_user_id: string }>(
    `select line_user_id from public.member_line_links where gang_id = $1 and user_id = $2`,
    [gangId, userId],
  );
  return row?.line_user_id ?? null;
}

describe('WO-4.D — state / nonce (pure)', () => {
  it('state ที่เราออกเอง verify ผ่าน', () => {
    const { state, nonce } = mintLoginState('g-1', 'u-1');
    const verified = verifyLoginState(state);

    expect(verified).toEqual({ gangId: 'g-1', userId: 'u-1', nonce });
  });

  it('🔴 state ที่ถูกแก้ verify ไม่ผ่าน', () => {
    const { state } = mintLoginState('g-1', 'u-1');
    expect(verifyLoginState(`${state.slice(0, -1)}X`)).toBeNull();
    expect(verifyLoginState('ไม่ใช่ state')).toBeNull();
  });

  it('🔴 state หมดอายุใช้ไม่ได้', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { state } = mintLoginState('g-1', 'u-1', past, 60);
    expect(verifyLoginState(state)).toBeNull();
  });

  it('nonce เทียบแบบ timing-safe และไม่มี cookie = ไม่ผ่าน', () => {
    const { nonce } = mintLoginState('g-1', 'u-1');
    expect(nonceMatches(nonce, nonce)).toBe(true);
    expect(nonceMatches(nonce, 'อย่างอื่น')).toBe(false);
    expect(nonceMatches(nonce, null)).toBe(false);
  });

  it('nonce ของแต่ละครั้งไม่ซ้ำกัน', () => {
    const a = mintLoginState('g-1', 'u-1').nonce;
    const b = mintLoginState('g-1', 'u-1').nonce;
    expect(a).not.toBe(b);
  });
});

describe('WO-4.D DoD — callback ปฏิเสธเคสที่ไม่ปลอดภัย', () => {
  it('ผูกสำเร็จเมื่อครบทุกเงื่อนไข', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    const result = await callback({ gangId, userId, lineUserId: 'U-ok-1' });

    expect(result).toEqual({ ok: true, gangId });
    expect(await linkedLineId(gangId, userId)).toBe('U-ok-1');
  });

  it('🔴 ไม่มี state → ปฏิเสธ', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    const result = await callback({ gangId, userId, overrides: { state: null } });

    expect(result.ok).toBe(false);
    expect(await linkedLineId(gangId, userId)).toBeNull();
  });

  it('🔴 nonce ไม่ตรงกับ cookie → ปฏิเสธ (กัน login CSRF)', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    const result = await callback({
      gangId,
      userId,
      overrides: { nonceCookie: 'nonce-ของเบราว์เซอร์อื่น' },
    });

    expect(result).toMatchObject({ ok: false, reason: 'nonce_mismatch' });
    expect(await linkedLineId(gangId, userId)).toBeNull();
  });

  it('🔴 ไม่มี cookie เลย → ปฏิเสธ', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    const result = await callback({ gangId, userId, overrides: { nonceCookie: null } });
    expect(result).toMatchObject({ ok: false, reason: 'nonce_mismatch' });
  });

  it('🔴 ไม่ได้ล็อกอิน → ไม่ผูกให้ใคร', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    const result = await callback({ gangId, userId, signedInAs: null });

    expect(result).toMatchObject({ ok: false, reason: 'not_signed_in' });
    expect(await linkedLineId(gangId, userId)).toBeNull();
  });

  it('🔴 คนที่ล็อกอินไม่ใช่คนใน state → ปฏิเสธ (state หลุดก็ผูกข้ามคนไม่ได้)', async () => {
    const { gangId } = await gangWithLogin();
    const victim = await member(gangId);
    const attacker = await member(gangId);

    const result = await callback({ gangId, userId: victim, signedInAs: attacker });

    expect(result).toMatchObject({ ok: false, reason: 'wrong_user' });
    expect(await linkedLineId(gangId, victim)).toBeNull();
    expect(await linkedLineId(gangId, attacker)).toBeNull();
  });

  it('ก๊วนที่ยังไม่ตั้งค่า LINE Login → ปฏิเสธ', async () => {
    const { gangId } = await gangWithLogin({ login: false });
    const userId = await member(gangId);

    const result = await callback({ gangId, userId });
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
  });

  it('ผู้ใช้กดยกเลิกที่หน้า LINE → ไม่ใช่ error ของระบบ', async () => {
    const result = await handleLoginCallback(
      {
        code: null,
        state: null,
        error: 'access_denied',
        nonceCookie: null,
        redirectUri: 'https://example.com/api/line/login/callback',
        correlationId: 'test',
      },
      { currentUserId: async () => 'u-1' },
    );

    expect(result).toMatchObject({ ok: false, reason: 'denied' });
  });

  it('🔴 LINE ใบเดียวผูกกับสมาชิกสองคนในก๊วนเดียวกันไม่ได้', async () => {
    const { gangId } = await gangWithLogin();
    const first = await member(gangId);
    const second = await member(gangId);

    await callback({ gangId, userId: first, lineUserId: 'U-shared-login' });
    const result = await callback({ gangId, userId: second, lineUserId: 'U-shared-login' });

    expect(result).toMatchObject({ ok: false, reason: 'link_failed' });
    expect(await linkedLineId(gangId, second)).toBeNull();
  });

  it('ผูกสำเร็จแล้วมีข้อความยืนยันเข้าคิว (เส้นทางเดียวกับผูกด้วยรหัสในแชต)', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    await callback({ gangId, userId, lineUserId: 'U-notify-1' });

    const { rows } = await pool.query<{ channel: string }>(
      `select channel from public.notifications
        where gang_id = $1 and recipient_id = $2 and event_type = 'line.linked'`,
      [gangId, userId],
    );

    // in_app + line (fan-out ของ WO-4.C เพราะเพิ่งผูกบัญชีไปเมื่อกี้)
    expect(rows.map((r) => r.channel).sort()).toEqual(['in_app', 'line']);
  });
});

describe('WO-4.D DoD — เลิกผูกแล้วต้องหยุดส่งทันที', () => {
  it('🔴 งาน LINE ที่ค้างในคิวถูกปิด ไม่ถูกส่งอีก', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);
    await callback({ gangId, userId, lineUserId: 'U-unlink-1' });

    await pool.query(`select public.enqueue_notifications($1::jsonb)`, [
      JSON.stringify([
        {
          gang_id: gangId,
          recipient_id: userId,
          event_type: 'session.opened',
          payload: {},
          dedupe_key: `unlink-test:${crypto.randomUUID()}`,
        },
      ]),
    ]);

    const pendingLine = async () => {
      const {
        rows: [row],
      } = await pool.query<{ n: string }>(
        `select count(*)::text n from public.notifications
          where gang_id = $1 and recipient_id = $2 and channel = 'line' and status = 'pending'`,
        [gangId, userId],
      );
      return Number(row.n);
    };

    expect(await pendingLine()).toBeGreaterThan(0);

    await pool.query(`select public.unlink_line_account($1, $2)`, [gangId, userId]);

    expect(await pendingLine()).toBe(0);
    expect(await linkedLineId(gangId, userId)).toBeNull();

    const {
      rows: [closed],
    } = await pool.query<{ status: string; last_error: string }>(
      `select status, last_error from public.notifications
        where gang_id = $1 and recipient_id = $2 and channel = 'line'
        order by created_at desc limit 1`,
      [gangId, userId],
    );
    expect(closed.status).toBe('failed');
    expect(closed.last_error).toContain('เลิกผูก');
  });

  it('เลิกผูกแล้วผูกใหม่ได้', async () => {
    const { gangId } = await gangWithLogin();
    const userId = await member(gangId);

    await callback({ gangId, userId, lineUserId: 'U-relink-1' });
    await pool.query(`select public.unlink_line_account($1, $2)`, [gangId, userId]);
    await callback({ gangId, userId, lineUserId: 'U-relink-2' });

    expect(await linkedLineId(gangId, userId)).toBe('U-relink-2');
  });
});

describe('WO-4.D — credentials ของ Login channel', () => {
  it('🔴 secret ของ Login channel ไม่ถูกเก็บเป็น plaintext ในตาราง', async () => {
    const { gangId } = await gangWithLogin();

    const {
      rows: [row],
    } = await pool.query<{ dump: string }>(
      `select to_jsonb(c)::text as dump from public.gang_line_configs c where gang_id = $1`,
      [gangId],
    );

    expect(row.dump).not.toContain(LOGIN_SECRET);
    // channel id ไม่ใช่ความลับ (อยู่ใน URL ที่ผู้ใช้เห็น) จึงเก็บตรงๆ ได้
    expect(row.dump).toContain(LOGIN_CHANNEL);
  });

  it('สถานะที่หน้าจอเห็นมีแค่ 4 ตัวท้ายของ secret', async () => {
    const { gangId } = await gangWithLogin();

    const {
      rows: [row],
    } = await pool.query<{
      has_login_channel: boolean;
      login_channel_id: string;
      secret_last4: string;
    }>(`select * from public.gang_line_login_status($1)`, [gangId]);

    expect(row.has_login_channel).toBe(true);
    expect(row.login_channel_id).toBe(LOGIN_CHANNEL);
    expect(row.secret_last4).toBe(LOGIN_SECRET.slice(-4));
  });

  it('🔴 ผู้ใช้เรียกฟังก์ชันที่คืน secret ตรงไม่ได้', async () => {
    const { gangId, owner } = await gangWithLogin();
    const { asRole } = await import('../helpers/db');

    await asRole('authenticated', owner, async (c) => {
      await expect(c.query(`select public.get_gang_line_login($1)`, [gangId])).rejects.toThrow(
        /permission denied/i,
      );
    });
  });
});
