/**
 * WO-B1.a DoD — เข้าสู่ระบบด้วย LINE ระดับแพลตฟอร์ม (ADR-013) · ส่วนที่ไม่ต้องใช้ provider จริง
 *
 *   · 🔴 ปิดเป็นค่าเริ่มต้น (fail-closed) — flag ไม่ตั้ง/ค่าอื่น = FEATURE_DISABLED
 *   · 🔴 ใช้ PKCE (code_challenge + code verifier ลง cookie) · redirect_to ใช้ APP_BASE_URL และ `next` ผ่าน safeNext
 *   · 🔴 มีเพดาน `auth:line-start` 20/ชม./IP ที่ตัดจริง
 *   · 🔴 `/auth/callback` แปลง `?error=` ของ provider เป็น code ตายตัว ไม่ส่งข้อความดิบต่อ
 *   · 🔴 `/sign-in?error=` ไม่ echo ค่าที่ส่งมา
 *   · ❗ ไม่ยิง LINE จริง — ฝั่ง Supabase ใช้ local (สร้าง URL ฝั่ง SDK ไม่ต้องมี provider)
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

// ── mock next/headers: cookie jar + request headers ที่เทสต์คุมเองได้ ─────────────────────────
const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...state.jar].map(([name, value]) => ({ name, value })),
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name) } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
  }),
  headers: async () => state.headers,
}));

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-test-only';

const { startLineSignIn } = await import('@/server/actions/auth');
const { GET: authCallback } = await import('@/app/auth/callback/route');
const { resolveAppOrigin } = await import('@/lib/url/app-origin');
const { signInErrorText, SIGN_IN_ERRORS_TH } = await import('@/features/auth/sign-in-errors');
const { isLinePlatformLoginEnabled } = await import('@/lib/line/platform-login');

const APP = 'https://gang-badminton.example.test';

function uniqueIp(): string {
  // TEST-NET-3 + สุ่ม ⇒ ถังนับของแต่ละเทสต์ไม่ชนกัน (ตารางนับใช้ร่วมกับเทสต์ชุดอื่น)
  const n = crypto.getRandomValues(new Uint8Array(2));
  return `203.0.${n[0]}.${n[1]}`;
}

function request(ip: string = uniqueIp()): void {
  state.headers = new Headers({ 'x-forwarded-for': ip, host: 'ignored.example.test' });
}

beforeEach(() => {
  state.jar.clear();
  process.env.LINE_PLATFORM_LOGIN_ENABLED = 'true';
  process.env.APP_BASE_URL = APP;
  request();
});

afterAll(async () => {
  delete process.env.LINE_PLATFORM_LOGIN_ENABLED;
  delete process.env.APP_BASE_URL;
  await pool.end();
});

describe('flag — ปิดเป็นค่าเริ่มต้น (fail-closed)', () => {
  it.each([undefined, '', 'false', '1', 'TRUE', 'yes'])('LINE_PLATFORM_LOGIN_ENABLED=%j → ปิด', (value) => {
    expect(isLinePlatformLoginEnabled({ LINE_PLATFORM_LOGIN_ENABLED: value })).toBe(false);
  });

  it("เปิดเฉพาะ 'true' ตรงตัว", () => {
    expect(isLinePlatformLoginEnabled({ LINE_PLATFORM_LOGIN_ENABLED: 'true' })).toBe(true);
  });

  it('🔴 flag ปิด → startLineSignIn ตอบ FEATURE_DISABLED และไม่เขียน cookie PKCE', async () => {
    delete process.env.LINE_PLATFORM_LOGIN_ENABLED;

    const result = await startLineSignIn('/gangs');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('FEATURE_DISABLED');
    expect(state.jar.size).toBe(0);
  });
});

describe('startLineSignIn — URL ที่ออกไป', () => {
  it('🔴 ชี้ไป authorize ของ Supabase เรา + provider=custom:line + PKCE (S256) + redirect_to จาก APP_BASE_URL', async () => {
    const result = await startLineSignIn('/gangs');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const url = new URL(result.data.url);
    expect(url.origin).toBe(new URL(API_URL).origin);
    expect(url.pathname).toBe('/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('custom:line');
    expect(url.searchParams.get('redirect_to')).toBe(`${APP}/auth/callback?next=%2Fgangs`);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
  });

  it('🔴 code verifier ของ PKCE ถูกเขียนลง cookie (และไม่หลุดไปใน URL)', async () => {
    const result = await startLineSignIn();
    expect(result.success).toBe(true);
    if (!result.success) return;

    const verifierCookie = [...state.jar].find(([name]) => name.endsWith('-auth-token-code-verifier'));
    expect(verifierCookie).toBeDefined();

    const verifier = decodeURIComponent(verifierCookie![1]).replace(/^base64-/, '').replace(/^"|"$/g, '');
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(result.data.url).not.toContain(verifier);
  });

  it.each(['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    '🔴 next=%j (open redirect) → ไม่ถูกฝังใน redirect_to',
    async (evil) => {
      const result = await startLineSignIn(evil);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const redirectTo = new URL(result.data.url).searchParams.get('redirect_to') ?? '';
      expect(redirectTo.startsWith(`${APP}/auth/callback`)).toBe(true);
      expect(redirectTo).not.toContain('evil');
      expect(redirectTo).not.toContain('javascript');
    },
  );

  it('ไม่มี next → redirect_to ไม่มี query', async () => {
    const result = await startLineSignIn();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(new URL(result.data.url).searchParams.get('redirect_to')).toBe(`${APP}/auth/callback`);
  });
});

describe('🔴 rate limit `auth:line-start` = 20/ชม./IP', () => {
  it('ครั้งที่ 21 จาก IP เดียวกันถูกตัด (RATE_LIMITED) · IP อื่นยังผ่าน', async () => {
    const ip = uniqueIp();

    for (let i = 0; i < 20; i += 1) {
      request(ip);
      const ok = await startLineSignIn();
      expect(ok.success, `ครั้งที่ ${i + 1}`).toBe(true);
    }

    request(ip);
    const blocked = await startLineSignIn();
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.error.code).toBe('RATE_LIMITED');

    request(uniqueIp());
    expect((await startLineSignIn()).success).toBe(true);
  });
});

describe('resolveAppOrigin', () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it('APP_BASE_URL มาก่อน header เสมอ (กันเข้าผ่าน alias แล้ว redirectTo หลุด allow-list)', () => {
    expect(
      resolveAppOrigin(h({ origin: 'https://alias.example', host: 'other.example' }), {
        APP_BASE_URL: 'https://main.example/',
      }),
    ).toBe('https://main.example');
  });

  it('ไม่ตั้ง APP_BASE_URL → origin header → forwarded host', () => {
    expect(resolveAppOrigin(h({ origin: 'https://a.example' }), {})).toBe('https://a.example');
    expect(
      resolveAppOrigin(h({ 'x-forwarded-host': 'b.example', 'x-forwarded-proto': 'https' }), {}),
    ).toBe('https://b.example');
  });

  it('🔴 ค่าที่ไม่ใช่ http(s) หรือพัง → ไม่ใช้ (คืน null แทนการเดา)', () => {
    expect(resolveAppOrigin(h({}), { APP_BASE_URL: 'javascript:alert(1)' })).toBeNull();
    expect(resolveAppOrigin(h({ origin: 'ftp://x.example' }), {})).toBeNull();
    expect(resolveAppOrigin(h({}), {})).toBeNull();
  });
});

describe('/auth/callback — error จาก provider', () => {
  const call = (qs: string) => authCallback(new NextRequest(`https://app.example.test/auth/callback?${qs}`));

  it('access_denied (ผู้ใช้กดยกเลิกที่ LINE) → /sign-in?error=line_denied', async () => {
    const res = await call('error=access_denied&error_description=User+denied');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.example.test/sign-in?error=line_denied');
  });

  it('🔴 error อื่น → oauth_failed และ error_description ดิบไม่ตามไปด้วย', async () => {
    const res = await call(
      `error=server_error&error_code=unexpected_failure&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
    );
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://app.example.test/sign-in?error=oauth_failed');
    expect(location).not.toContain('script');
  });

  it('ไม่มี code ไม่มี error → missing_code (พฤติกรรมเดิม)', async () => {
    const res = await call('next=%2Fgangs');
    expect(res.headers.get('location')).toBe('https://app.example.test/sign-in?error=missing_code');
  });
});

describe('/sign-in?error= — ข้อความตายตัว', () => {
  it('code ที่รู้จักทุกตัวมีข้อความไทย', () => {
    for (const code of Object.keys(SIGN_IN_ERRORS_TH)) {
      expect(signInErrorText(code)).toMatch(/[\u0E00-\u0E7F]/);
    }
  });

  it.each(['', undefined, 'whatever', '<script>alert(1)</script>', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    '🔴 code แปลก %j → null (ไม่ echo ไม่หลุด prototype)',
    (code) => {
      expect(signInErrorText(code)).toBeNull();
    },
  );

  it('callback ส่งได้แค่ code ที่ /sign-in รู้จัก', () => {
    for (const code of ['line_denied', 'oauth_failed', 'missing_code', 'invalid_code', 'rate_limited']) {
      expect(signInErrorText(code)).not.toBeNull();
    }
  });
});
