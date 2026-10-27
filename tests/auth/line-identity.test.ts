/**
 * WO-B1.c DoD — ผูก/ถอด LINE กับบัญชีที่ล็อกอินอยู่ (ADR-013 R2/R3/R5/R6)
 *
 *   · 🔴 ผูกได้เฉพาะตอนล็อกอินอยู่ · ไม่รับ user id / identity id จาก client
 *   · 🔴 ถอดไม่ได้ถ้าเป็นวิธีเข้าสู่ระบบเดียวที่เหลือ (บัญชี LINE-only)
 *   · 🔴 ซ่อนหลัง flag (fail-closed) · มีเพดาน `auth:line-link` / `auth:line-unlink`
 *   · 🔴 ไม่เขียน `auth.*` ตรง / ไม่ใช้ service-role ในเส้นทางนี้
 *   · 🔴 `/auth/callback` ของ flow ผูก: ล้มเหลวแล้วกลับ /profile?line=… ไม่ใช่ /sign-in
 *
 * ⚠️ ฝั่ง Supabase **mock** ทั้งหมด (ผลจริงของ `linkIdentity`/`unlinkIdentity` กับ `custom:line` บน cloud = spike S2
 *    ยังไม่พิสูจน์) — เทสต์นี้พิสูจน์ว่า *เรา* เรียก SDK ถูกและกันเงื่อนไขของเราเอง ไม่ได้พิสูจน์พฤติกรรมของ Supabase
 *    ข้อสมมติที่เทสต์พึ่ง: A1 `identity.provider === 'custom:line'` · A3 `error_code=identity_already_exists`
 *    · A4 Supabase redirect กลับ `redirectTo` พร้อม `code` เมื่อสำเร็จ
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_URL, pool, SERVICE_ROLE_KEY } from '../helpers/db';

// ── mock: session ของผู้ใช้ + auth API ของ Supabase ─────────────────────────────────────────────
const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  identities: [] as Array<Record<string, unknown>>,
  getUserIdentities: vi.fn(),
  linkIdentity: vi.fn(),
  unlinkIdentity: vi.fn(),
  headers: new Headers(),
  jar: new Map<string, string>(),
}));

vi.mock('@/lib/supabase/server', () => ({
  currentUser: async () => h.user,
  supabaseServer: async () => ({
    auth: {
      getUserIdentities: h.getUserIdentities,
      linkIdentity: h.linkIdentity,
      unlinkIdentity: h.unlinkIdentity,
      exchangeCodeForSession: async () => ({ error: null }),
    },
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    getAll: () => [],
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
    set: () => undefined,
  }),
}));

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-test-only';

const { myLineAccount, startLineLink, unlinkLineAccount } = await import('@/server/actions/line-identity');
const { GET: authCallback } = await import('@/app/auth/callback/route');
const identity = await import('@/lib/line/identity');
const { LINE_LINK_NEXT, parseLineProfileStatus } = await import('@/lib/line/platform-login');

const APP = 'https://gang-badminton.example.test';
const AUTHORIZE = `${API_URL}/auth/v1/user/identities/authorize?provider=custom%3Aline`;

const EMAIL = { identity_id: 'idn-email', provider: 'email', created_at: '2026-10-01T00:00:00Z' };
const LINE = {
  identity_id: 'idn-line',
  provider: 'custom:line',
  created_at: '2026-10-27T01:00:00Z',
  identity_data: { sub: 'U-SECRET-SUB-1234567890', name: 'ต้นไม้', picture: 'https://example.test/p.png' },
};

function ipHeaders(ip: string = `203.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`) {
  h.headers = new Headers({ 'x-forwarded-for': ip });
}

function loginAs(identities: Array<Record<string, unknown>>) {
  h.user = { id: crypto.randomUUID() };
  h.identities = identities;
  ipHeaders();
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINE_PLATFORM_LOGIN_ENABLED = 'true';
  process.env.APP_BASE_URL = APP;

  h.getUserIdentities.mockImplementation(async () => ({ data: { identities: h.identities }, error: null }));
  h.linkIdentity.mockImplementation(async () => ({
    data: { provider: 'custom:line', url: `${AUTHORIZE}&code_challenge=abc` },
    error: null,
  }));
  h.unlinkIdentity.mockImplementation(async () => ({ data: {}, error: null }));

  loginAs([EMAIL]);
});

afterAll(async () => {
  delete process.env.LINE_PLATFORM_LOGIN_ENABLED;
  delete process.env.APP_BASE_URL;
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('lib/line/identity — ตรรกะล้วน', () => {
  it('ไม่มี LINE → linked=false · ถอดไม่ได้', () => {
    expect(identity.summarizeLineAccount([EMAIL])).toMatchObject({ enabled: true, linked: false, canUnlink: false });
  });

  it('LINE + อีเมล → linked · ถอดได้', () => {
    expect(identity.summarizeLineAccount([EMAIL, LINE])).toMatchObject({
      linked: true,
      canUnlink: true,
      linkedAt: LINE.created_at,
      lineName: 'ต้นไม้',
    });
  });

  it('🔴 R5: บัญชี LINE-only → ถอดไม่ได้', () => {
    expect(identity.summarizeLineAccount([LINE])).toMatchObject({ linked: true, canUnlink: false });
  });

  it('🔴 ไม่คืน sub / identity_id / picture ไปให้ client', () => {
    const json = JSON.stringify(identity.summarizeLineAccount([EMAIL, LINE]));
    expect(json).not.toContain('U-SECRET-SUB');
    expect(json).not.toContain('idn-line');
    expect(json).not.toContain('example.test');
  });

  it('ชื่อจาก LINE: ตัดที่ 100 ตัว · ไม่ใช่ string = null', () => {
    const long = { ...LINE, identity_data: { name: 'ก'.repeat(500) } };
    expect(identity.summarizeLineAccount([EMAIL, long]).lineName).toHaveLength(100);
    expect(identity.summarizeLineAccount([EMAIL, { ...LINE, identity_data: { name: { x: 1 } } }]).lineName).toBeNull();
    expect(identity.summarizeLineAccount([EMAIL, { ...LINE, identity_data: undefined }]).lineName).toBeNull();
  });

  it('🔴 provider ที่ชื่อคล้าย (line / custom:line2 / google) ไม่ถูกนับเป็น LINE ของเรา', () => {
    for (const provider of ['line', 'custom:line2', 'custom:linex', 'google']) {
      expect(identity.findLineIdentity([{ ...LINE, provider }])).toBeNull();
    }
  });

  it('parseLineProfileStatus: whitelist เท่านั้น (ไม่หลุด prototype)', () => {
    for (const ok of ['linked', 'unlinked', 'denied', 'in_use', 'failed']) expect(parseLineProfileStatus(ok)).toBe(ok);
    for (const bad of [null, undefined, '', 'x', '<script>', '__proto__', 'constructor', 'toString']) {
      expect(parseLineProfileStatus(bad as string | null)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('ต้องล็อกอิน', () => {
  it.each([
    ['myLineAccount', () => myLineAccount()],
    ['startLineLink', () => startLineLink()],
    ['unlinkLineAccount', () => unlinkLineAccount()],
  ])('🔴 %s ไม่มี session → UNAUTHENTICATED และไม่แตะ Supabase auth', async (_name, call) => {
    h.user = null;
    const result = await call();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(h.getUserIdentities).not.toHaveBeenCalled();
    expect(h.linkIdentity).not.toHaveBeenCalled();
    expect(h.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('🔴 action ไม่รับ argument ใดๆ จาก client (user id / identity id มาจาก session เท่านั้น)', () => {
    expect(myLineAccount.length).toBe(0);
    expect(startLineLink.length).toBe(0);
    expect(unlinkLineAccount.length).toBe(0);
  });
});

describe('flag LINE_PLATFORM_LOGIN_ENABLED (fail-closed)', () => {
  beforeEach(() => {
    delete process.env.LINE_PLATFORM_LOGIN_ENABLED;
  });

  it('myLineAccount → enabled:false (ซ่อนส่วนนี้เงียบๆ) และไม่อ่าน identities', async () => {
    const result = await myLineAccount();
    expect(result).toMatchObject({ success: true, data: { enabled: false, linked: false } });
    expect(h.getUserIdentities).not.toHaveBeenCalled();
  });

  it.each([
    ['startLineLink', () => startLineLink(), 'linkIdentity'],
    ['unlinkLineAccount', () => unlinkLineAccount(), 'unlinkIdentity'],
  ] as const)('%s → FEATURE_DISABLED ไม่เรียก SDK', async (_n, call, spy) => {
    loginAs([EMAIL, LINE]);
    const result = await call();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('FEATURE_DISABLED');
    expect(h[spy]).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('myLineAccount', () => {
  it('คืนสรุปที่ปลอดภัย', async () => {
    loginAs([EMAIL, LINE]);
    const result = await myLineAccount();

    expect(result).toMatchObject({ success: true, data: { enabled: true, linked: true, canUnlink: true } });
    expect(JSON.stringify(result)).not.toContain('U-SECRET-SUB');
  });

  it('อ่าน identities ไม่ได้ → INTERNAL_ERROR (ไม่เดาว่า "ยังไม่ผูก")', async () => {
    h.getUserIdentities.mockResolvedValueOnce({ data: null, error: { code: 'x', status: 500, message: 'secret detail' } });
    const result = await myLineAccount();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('startLineLink', () => {
  it('🔴 เรียก linkIdentity(custom:line) ด้วย redirectTo จาก APP_BASE_URL + next ตายตัว + skipBrowserRedirect', async () => {
    const result = await startLineLink();

    expect(result).toMatchObject({ success: true });
    expect(h.linkIdentity).toHaveBeenCalledTimes(1);
    expect(h.linkIdentity).toHaveBeenCalledWith({
      provider: 'custom:line',
      options: {
        redirectTo: `${APP}/auth/callback?next=${encodeURIComponent(LINE_LINK_NEXT)}`,
        skipBrowserRedirect: true,
      },
    });
    if (result.success) expect(new URL(result.data.url).origin).toBe(new URL(API_URL).origin);
  });

  it('🔴 บัญชีที่ผูกแล้ว → VALIDATION_ERROR และไม่ยิง linkIdentity', async () => {
    loginAs([EMAIL, LINE]);
    const result = await startLineLink();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(h.linkIdentity).not.toHaveBeenCalled();
  });

  it('🔴 URL ที่ SDK คืนมาไม่ใช่ origin ของ Supabase เรา → ปฏิเสธ (ไม่พาผู้ใช้ออกนอกโดเมน)', async () => {
    h.linkIdentity.mockResolvedValueOnce({ data: { url: 'https://evil.example/authorize' }, error: null });
    const result = await startLineLink();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it('linkIdentity ล้ม (เช่น ยังไม่เปิด Manual Linking) → INTERNAL_ERROR ไม่รั่วข้อความดิบ', async () => {
    h.linkIdentity.mockResolvedValueOnce({
      data: { url: null },
      error: { code: 'manual_linking_disabled', status: 422, message: 'RAW-UPSTREAM-MESSAGE' },
    });
    const result = await startLineLink();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(result)).not.toContain('RAW-UPSTREAM-MESSAGE');
    }
  });

  it('หา origin ของแอปไม่ได้ → INTERNAL_ERROR (ไม่เดา)', async () => {
    delete process.env.APP_BASE_URL;
    h.headers = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    const result = await startLineLink();

    expect(result.success).toBe(false);
    expect(h.linkIdentity).not.toHaveBeenCalled();
  });
});

describe('unlinkLineAccount', () => {
  it('🔴 ถอด identity LINE ที่หาเองจาก session (ไม่ใช่ของ email)', async () => {
    loginAs([EMAIL, LINE]);
    const result = await unlinkLineAccount();

    expect(result).toMatchObject({ success: true, data: { removed: true } });
    expect(h.unlinkIdentity).toHaveBeenCalledTimes(1);
    expect(h.unlinkIdentity.mock.calls[0][0]).toMatchObject({ identity_id: 'idn-line', provider: 'custom:line' });
  });

  it('🔴 R5: บัญชี LINE-only → VALIDATION_ERROR และไม่ยิง unlinkIdentity', async () => {
    loginAs([LINE]);
    const result = await unlinkLineAccount();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(h.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('ยังไม่ได้ผูก → VALIDATION_ERROR และไม่ถอด identity อื่นแทน', async () => {
    loginAs([EMAIL]);
    const result = await unlinkLineAccount();

    expect(result.success).toBe(false);
    expect(h.unlinkIdentity).not.toHaveBeenCalled();
  });

  it('Supabase ปฏิเสธ → INTERNAL_ERROR ไม่รั่วข้อความดิบ', async () => {
    loginAs([EMAIL, LINE]);
    h.unlinkIdentity.mockResolvedValueOnce({ data: null, error: { code: 'single_identity_not_deletable', status: 422, message: 'RAW' } });
    const result = await unlinkLineAccount();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('RAW');
  });
});

describe('🔴 rate limit (นับจริงใน Postgres)', () => {
  it('auth:line-link ครั้งที่ 11 ของผู้ใช้+IP เดิมถูกตัด · ผู้ใช้อื่น IP เดิมไม่ติดด้วย', async () => {
    const user = { id: crypto.randomUUID() };
    h.user = user;
    h.identities = [EMAIL];
    const ip = '203.0.113.77';

    for (let i = 0; i < 10; i += 1) {
      ipHeaders(ip);
      expect((await startLineLink()).success, `ครั้งที่ ${i + 1}`).toBe(true);
    }

    ipHeaders(ip);
    const blocked = await startLineLink();
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error.code).toBe('RATE_LIMITED');

    h.user = { id: crypto.randomUUID() };
    ipHeaders(ip);
    expect((await startLineLink()).success).toBe(true);
  });

  it('auth:line-unlink ครั้งที่ 11 ถูกตัด', async () => {
    h.user = { id: crypto.randomUUID() };
    h.identities = [EMAIL, LINE];
    const ip = '203.0.113.78';

    for (let i = 0; i < 10; i += 1) {
      ipHeaders(ip);
      expect((await unlinkLineAccount()).success, `ครั้งที่ ${i + 1}`).toBe(true);
    }

    ipHeaders(ip);
    const blocked = await unlinkLineAccount();
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error.code).toBe('RATE_LIMITED');
  });
});

describe('🔴 R6 — ไม่เขียน auth.* ตรง / ไม่ใช้ service-role ในเส้นทางนี้', () => {
  const root = join(__dirname, '..', '..');
  const files = ['server/actions/line-identity.ts', 'lib/line/identity.ts', 'features/profile/LineAccountPanel.tsx', 'features/profile/LineAccountSection.tsx'];

  it.each(files)('%s', (file) => {
    const source = readFileSync(join(root, file), 'utf8');
    expect(source).not.toMatch(/supabaseAdmin/);
    expect(source).not.toMatch(/auth\.(users|identities)/);
    expect(source).not.toMatch(/\.rpc\(/);
    expect(source).not.toMatch(/link_line_account|member_line_links/); // ไม่ปนกับการผูกต่อก๊วน
  });

  it('ปุ่มผูกไม่ใช่ <form action> (CSP form-action self)', () => {
    const source = readFileSync(join(root, 'features/profile/LineAccountPanel.tsx'), 'utf8');
    expect(source).not.toMatch(/<form/);
    expect(source).toContain('window.location.href');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('/auth/callback — flow ผูก LINE', () => {
  const call = (qs: string) => authCallback(new NextRequest(`https://app.example.test/auth/callback?${qs}`));
  const next = `next=${encodeURIComponent(LINE_LINK_NEXT)}`;
  const loc = (res: Response) => res.headers.get('location');

  it('ผู้ใช้กดยกเลิกที่ LINE → /profile?line=denied', async () => {
    expect(loc(await call(`error=access_denied&${next}`))).toBe('https://app.example.test/profile?line=denied');
  });

  it('error_code=identity_already_exists → /profile?line=in_use (ไม่บอกว่าเป็นบัญชีของใคร)', async () => {
    const res = await call(`error=server_error&error_code=identity_already_exists&error_description=EVIL-DESC&${next}`);
    expect(loc(res)).toBe('https://app.example.test/profile?line=in_use');
    expect(loc(res)).not.toContain('EVIL');
  });

  it('error อื่น / ไม่มี code → /profile?line=failed', async () => {
    expect(loc(await call(`error=server_error&${next}`))).toBe('https://app.example.test/profile?line=failed');
    expect(loc(await call(next))).toBe('https://app.example.test/profile?line=failed');
  });

  it('สำเร็จ (มี code) → /profile?line=linked', async () => {
    expect(loc(await call(`code=abc&${next}`))).toBe('https://app.example.test/profile?line=linked');
  });

  it('🔴 next ที่ไม่ตรง marker เป๊ะ ไม่ถูกปฏิบัติเป็น flow ผูก (ยังไป /sign-in ตามเดิม)', async () => {
    for (const evil of ['/profile?line=linked&x=1', '/profile', '/profile?line=linkedX', '//evil.example']) {
      const res = await call(`error=access_denied&next=${encodeURIComponent(evil)}`);
      expect(loc(res)).toBe('https://app.example.test/sign-in?error=line_denied');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('SDK จริงของ supabase-js (fetch ถูก stub) — เราส่งอะไรออกไปจริง', () => {
  function fakeJwt(sub: string): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  }

  it('linkIdentity({provider:"custom:line"}) → GET /auth/v1/user/identities/authorize พร้อม JWT ของผู้ใช้ + PKCE S256', async () => {
    const userId = crypto.randomUUID();
    const calls: Array<{ url: URL; auth: string | null }> = [];
    const store = new Map<string, string>();

    const stubFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get('authorization') });

      if (url.pathname === '/auth/v1/user') {
        return new Response(JSON.stringify({ id: userId, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }), { status: 200 });
      }
      return new Response(JSON.stringify({ url: 'https://supabase.example/authorize?stub=1' }), { status: 200 });
    };

    const client = createClient(API_URL, 'anon-key-for-test-only', {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
      },
      global: { fetch: stubFetch },
    });

    const jwt = fakeJwt(userId);
    await client.auth.setSession({ access_token: jwt, refresh_token: 'refresh-stub' });

    const { data, error } = await client.auth.linkIdentity({
      provider: 'custom:line',
      options: { redirectTo: `${APP}/auth/callback`, skipBrowserRedirect: true },
    });

    expect(error).toBeNull();
    expect(data?.url).toBe('https://supabase.example/authorize?stub=1');

    const link = calls.find((c) => c.url.pathname === '/auth/v1/user/identities/authorize');
    expect(link, 'SDK ต้องยิง /user/identities/authorize').toBeDefined();
    expect(link!.url.searchParams.get('provider')).toBe('custom:line');
    expect(link!.url.searchParams.get('redirect_to')).toBe(`${APP}/auth/callback`);
    expect(link!.url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(link!.url.searchParams.get('code_challenge')).toBeTruthy();
    expect(link!.auth).toBe(`Bearer ${jwt}`); // 🔴 ผูกให้ "ผู้ใช้ที่ล็อกอินอยู่" ตาม JWT ไม่ใช่ใครก็ได้
    // verifier อยู่ใน storage ไม่ได้อยู่ใน URL
    expect([...store.keys()].some((k) => k.endsWith('-code-verifier'))).toBe(true);
  });
});
