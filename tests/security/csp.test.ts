/**
 * WO-5.B DoD — security headers + CSP
 *
 *   · 🔴 production: `script-src` **ไม่มี** `unsafe-inline` / `unsafe-eval`
 *   · 🔴 หน้า static ต้องได้นโยบายที่สคริปต์ของมันรันได้จริง (nonce ใช้ไม่ได้กับ prerender)
 *   · `connect-src` มาจาก `NEXT_PUBLIC_SUPABASE_URL` — ไม่ hardcode และต้องมี `wss:` ด้วย
 *   · HSTS เฉพาะ production
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  buildContentSecurityPolicy,
  staticSecurityHeaders,
  supabaseOrigins,
  STATIC_ROUTES,
} from '@/lib/security/csp';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SUPABASE = 'https://abcdefgh.supabase.co';

function policy(overrides: Partial<Parameters<typeof buildContentSecurityPolicy>[0]> = {}) {
  return buildContentSecurityPolicy({
    nonce: 'TESTNONCE',
    supabaseUrl: SUPABASE,
    isProduction: true,
    ...overrides,
  });
}

/** ดึงค่าของ directive หนึ่งออกมาเทียบ */
function directive(csp: string, name: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `)) ?? '';
}

describe('WO-5.B DoD — script-src', () => {
  it('🔴 production: มี nonce + strict-dynamic และ **ไม่มี** unsafe-inline/unsafe-eval', () => {
    const scriptSrc = directive(policy(), 'script-src');

    expect(scriptSrc).toContain("'nonce-TESTNONCE'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('dev มี unsafe-eval ได้ (HMR ของ Next ใช้ eval) แต่ยังไม่มี unsafe-inline', () => {
    const scriptSrc = directive(policy({ isProduction: false }), 'script-src');

    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('🔴 หน้า static: ใช้ unsafe-inline ได้ แต่ **ห้ามมี strict-dynamic**', () => {
    // ถ้ามี strict-dynamic ปนมา มันจะ "ยกเลิก" unsafe-inline ทิ้ง ⇒ สคริปต์ของหน้าโดนบล็อกทั้งหน้า
    const scriptSrc = directive(policy({ isStaticRoute: true }), 'script-src');

    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('strict-dynamic');
    expect(scriptSrc).not.toContain('nonce-');
  });

  it('หน้า static ที่ประกาศไว้ต้องตรงกับของจริง — ตอนนี้มีหน้าแรกหน้าเดียว', () => {
    expect([...STATIC_ROUTES]).toEqual(['/']);
    // หน้าแรกยังเป็น ISR อยู่จริง (ถ้าวันหนึ่งกลายเป็น dynamic ต้องถอดออกจากลิสต์)
    expect(source('app/page.tsx')).toMatch(/export const revalidate\s*=\s*\d+/);
  });
});

describe('WO-5.B DoD — ปลายทางที่ browser คุยด้วยได้', () => {
  it('🔴 connect-src มาจาก env ไม่ใช่ hardcode และมี wss: ด้วย', () => {
    const connect = directive(policy(), 'connect-src');

    expect(connect).toContain('https://abcdefgh.supabase.co');
    expect(connect).toContain('wss://abcdefgh.supabase.co');

    // เปลี่ยน env → ค่าใน CSP เปลี่ยนตาม (พิสูจน์ว่าไม่ได้ฝังโดเมนไว้ในโค้ด)
    const other = directive(policy({ supabaseUrl: 'https://zzz.supabase.co' }), 'connect-src');
    expect(other).toContain('https://zzz.supabase.co');
    expect(other).not.toContain('abcdefgh');
  });

  it('local (http) ได้ ws: ไม่ใช่ wss:', () => {
    expect(supabaseOrigins('http://127.0.0.1:54321')).toEqual([
      'http://127.0.0.1:54321',
      'ws://127.0.0.1:54321',
    ]);
  });

  it('🔴 env เพี้ยน → ไม่เติมอะไรเลย (ห้ามกลายเป็น wildcard)', () => {
    expect(supabaseOrigins('ไม่ใช่ url')).toEqual([]);
    expect(directive(policy({ supabaseUrl: 'ไม่ใช่ url' }), 'connect-src')).toBe(
      "connect-src 'self'",
    );
  });

  it('img-src รองรับ data:/blob: (QR PromptPay + preview ก่อนอัป) และ Storage', () => {
    const img = directive(policy(), 'img-src');
    expect(img).toContain('data:');
    expect(img).toContain('blob:');
    expect(img).toContain('https://abcdefgh.supabase.co');
  });
});

describe('WO-5.B DoD — กันฝัง iframe และ header อื่น', () => {
  it('🔴 frame-ancestors none (LIFF ไม่กระทบ — LINE ใช้ WebView ไม่ใช่ iframe)', () => {
    expect(directive(policy(), 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy(), 'object-src')).toBe("object-src 'none'");
    expect(directive(policy(), 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy(), 'form-action')).toBe("form-action 'self'");
  });

  it('upgrade-insecure-requests เฉพาะ production', () => {
    expect(policy()).toContain('upgrade-insecure-requests');
    expect(policy({ isProduction: false })).not.toContain('upgrade-insecure-requests');
  });

  it('🔴 HSTS เฉพาะ production (ตั้งบน localhost แล้วเบราว์เซอร์จะจำไปตลอด)', () => {
    const keys = (production: boolean) => staticSecurityHeaders(production).map((h) => h.key);

    expect(keys(true)).toContain('Strict-Transport-Security');
    expect(keys(false)).not.toContain('Strict-Transport-Security');
  });

  it('header พื้นฐานครบตาม §Security Checklist', () => {
    const headers = Object.fromEntries(staticSecurityHeaders(true).map((h) => [h.key, h.value]));

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    // แอปไม่ใช้กล้องผ่านเบราว์เซอร์เลย (WO-2.5-F ใช้กล้องเนทีฟ) ⇒ ปิดหมด
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });
});

describe('WO-5.B — การต่อสายในแอป (กันพลาดแบบที่เคยพลาดมาแล้ว)', () => {
  const proxy = source('proxy.ts');
  const config = source('next.config.ts');
  const supabaseMiddleware = source('lib/supabase/middleware.ts');

  it('proxy ตั้ง CSP และสร้าง nonce ใหม่ทุก request', () => {
    expect(proxy).toMatch(/Content-Security-Policy/);
    expect(proxy).toMatch(/randomUUID\(\)/);
    expect(proxy).toMatch(/isStaticRoute/);
  });

  it('🔴 nonce ถูกส่งต่อผ่าน `request: { headers }` — ไม่งั้น script ไม่มี nonce ทั้งหน้า', () => {
    // เคสที่เคยพลาดจริงตอนทำ WO-5.B: ส่ง `{ request }` เฉยๆ แล้ว header ที่เพิ่งเซ็ตหายไป
    expect(proxy).toMatch(/requestHeaders\.set\('x-nonce'/);
    expect(supabaseMiddleware).toMatch(/request:\s*\{\s*headers:/);
  });

  it('next.config ใช้ชุด header เดียวกับที่เทสต์ตรวจ', () => {
    expect(config).toMatch(/staticSecurityHeaders/);
  });
});
