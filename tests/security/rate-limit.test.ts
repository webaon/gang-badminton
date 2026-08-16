/**
 * WO-5.C DoD — rate limit ของทางเข้าสาธารณะ + secret/log hygiene
 *
 *   · 🔴 เกินเพดาน = `RATE_LIMITED` (ไม่ใช่ 500) และ **fail-closed** เมื่อตัวนับพัง
 *   · 🔴 ทุกทางเข้าสาธารณะมีเพดานจริงในโค้ด และตรงกับที่เขียนใน `docs/rate-limits.md`
 *   · 🔴 grep gate — ไม่มี secret/token plaintext ในโค้ด และไม่มีที่ไหน log ค่าเหล่านั้น
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { enforceRateLimit, withinRateLimit, clientIp } = await import(
  '@/server/security/rate-limit'
);

afterAll(async () => {
  await pool.end();
});

const root = fileURLToPath(new URL('../../', import.meta.url));

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** ไฟล์ source ทั้งหมดของแอป (ไม่รวมเทสต์/ของ generate) */
function sourceFiles(): string[] {
  const dirs = ['app', 'features', 'lib', 'server', 'domain', 'shared'];
  const found: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = join(dir, entry);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(rel);
    }
  };

  dirs.forEach(walk);
  return found;
}

/**
 * ตัดเอา "อาร์กิวเมนต์ของ console.*" ออกมาแบบนับวงเล็บจริง
 *
 * ⚠️ ใช้ regex จับระยะใกล้ๆ ไม่ได้ — `console.warn('...', { correlationId })` ที่มีบรรทัด
 *    `p_guest_token: token` อยู่ถัดไปสิบบรรทัด จะกลายเป็น false positive ทันที
 *    (เจอมาแล้วตอนเขียนเทสต์นี้) ⇒ ต้องดูเฉพาะสิ่งที่อยู่ **ในวงเล็บของ console เอง**
 */
function consoleCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /console\.(log|info|warn|error|debug)\(/g;

  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;

    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }

    calls.push(source.slice(match.index, i));
  }

  return calls;
}

function headersWith(ip: string): Headers {
  return new Headers({ 'x-forwarded-for': ip });
}

describe('WO-5.C DoD — ตัดจริงเมื่อเกินเพดาน', () => {
  it('🔴 เกินเพดาน → RATE_LIMITED (ไม่ใช่ 500)', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const scope = `test:${crypto.randomUUID()}`;
    const options = { scope, headers: headersWith(ip), limit: 3, window: '1 hour' };

    for (let i = 0; i < 3; i++) {
      await expect(enforceRateLimit(options)).resolves.toBeUndefined();
    }

    await expect(enforceRateLimit(options)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('คนละ IP นับคนละถัง', async () => {
    const scope = `test:${crypto.randomUUID()}`;
    const base = { scope, limit: 1, window: '1 hour' };

    await enforceRateLimit({ ...base, headers: headersWith('203.0.113.10') });
    // IP เดิมเกินแล้ว
    await expect(
      enforceRateLimit({ ...base, headers: headersWith('203.0.113.10') }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // IP อื่นยังผ่าน
    await expect(
      enforceRateLimit({ ...base, headers: headersWith('203.0.113.11') }),
    ).resolves.toBeUndefined();
  });

  it('คนละ scope นับคนละถัง (ทางเข้าหนึ่งเต็มไม่ลามไปอีกทาง)', async () => {
    const ip = '203.0.113.55';
    const suffix = crypto.randomUUID();

    await enforceRateLimit({ scope: `a:${suffix}`, headers: headersWith(ip), limit: 1, window: '1 hour' });
    await expect(
      enforceRateLimit({ scope: `b:${suffix}`, headers: headersWith(ip), limit: 1, window: '1 hour' }),
    ).resolves.toBeUndefined();
  });

  it('`subject` แยกถังต่อ session/registration ได้', async () => {
    const ip = '203.0.113.77';
    const scope = `test:${crypto.randomUUID()}`;
    const base = { scope, headers: headersWith(ip), limit: 1, window: '1 hour' };

    await enforceRateLimit({ ...base, subject: 'aaa' });
    await expect(enforceRateLimit({ ...base, subject: 'bbb' })).resolves.toBeUndefined();
  });

  it('`withinRateLimit()` คืน boolean แทนการโยน (สำหรับ route handler)', async () => {
    const scope = `test:${crypto.randomUUID()}`;
    const options = { scope, headers: headersWith('203.0.113.88'), limit: 1, window: '1 hour' };

    expect(await withinRateLimit(options)).toBe(true);
    expect(await withinRateLimit(options)).toBe(false);
  });

  it('🔴 IP อ่านไม่ได้ → ถัง `unknown` (เข้มกว่า ไม่ใช่ปล่อยผ่าน)', () => {
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('WO-5.C DoD — ทางเข้าสาธารณะทุกทางมีเพดานจริง', () => {
  const cases: { file: string; scope: string }[] = [
    { file: 'server/actions/discovery.ts', scope: 'discovery:search' },
    { file: 'app/guest/[registrationId]/claim/route.ts', scope: 'guest:claim' },
    { file: 'app/auth/callback/route.ts', scope: 'auth:callback' },
    { file: 'app/api/line/login/callback/route.ts', scope: 'line:login-callback' },
    { file: 'server/guest/rate-limit.ts', scope: 'guest:' },
  ];

  it.each(cases)('$file มีเพดาน ($scope)', ({ file, scope }) => {
    const source = read(file);
    expect(source).toMatch(/enforceRateLimit|withinRateLimit|enforceGuestRateLimit/);
    expect(source).toContain(scope);
  });

  it('เอกสาร `docs/rate-limits.md` ครอบทุก scope ที่โค้ดใช้จริง', () => {
    const doc = read('docs/rate-limits.md');
    for (const { scope } of cases) {
      expect(doc.includes(scope) || doc.includes(scope.replace(':', ' '))).toBe(true);
    }
  });

  it('🔴 ตัวนับต้องเป็นตัวเดียวกับของเดิม — ไม่มีใครสร้างกลไกนับใหม่', () => {
    const counters = sourceFiles().filter((file) => read(file).includes('check_rate_limit'));
    expect(counters).toEqual(['server/security/rate-limit.ts']);
  });
});

describe('WO-5.C DoD — ไม่มี secret หลุดในโค้ดหรือ log', () => {
  const files = sourceFiles();

  it('🔴 ไม่มี JWT / service key / secret ของ Supabase ฝังในโค้ด', () => {
    const offenders = files.filter((file) => {
      const source = read(file);
      return (
        /eyJhbGciOi[A-Za-z0-9_-]{10,}/.test(source) || // JWT ของจริง
        /sb_secret_[A-Za-z0-9_-]+/.test(source) ||
        /service_role["']?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });

  it('🔴 ไม่มีที่ไหน log ค่า token/secret', () => {
    const secretish =
      /\b(accessToken|access_token|channelSecret|channel_secret|idToken|id_token|decrypted_secret|guestToken|guest_token|serviceRoleKey|linkCode|token)\b/;

    const offenders = files.flatMap((file) =>
      consoleCalls(read(file))
        .filter((call) => secretish.test(call))
        // ข้อความอธิบายเป็นภาษาไทยที่มีคำว่า token ได้ (เช่น 'แลก token ไม่สำเร็จ')
        // ⇒ ตัด string literal ออกก่อนแล้วค่อยตรวจว่าเหลือ **ตัวแปร** ที่เป็นความลับไหม
        .filter((call) => secretish.test(call.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')))
        .map(() => file),
    );

    expect(offenders).toEqual([]);
  });

  it('🔴 migration ไม่ raise/log ค่า secret ออกมา', () => {
    const dir = 'supabase/migrations';
    const offenders = readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        // ⚠️ `'token_changed', p_access_token is not null` = บันทึก **boolean** ไม่ใช่ค่า
        //    ⇒ ตัดรูปแบบ `p_x is (not) null` ทิ้งก่อน แล้วค่อยดูว่ายังมีการเอา "ค่า" ไปใช้ไหม
        const sql = read(join(dir, f)).replace(
          /\b(p_access_token|p_channel_secret|p_guest_token|p_channel_id)\s+is\s+(not\s+)?null/gi,
          '',
        );

        return /(raise\s+exception[\s\S]{0,300}?(p_access_token|p_channel_secret|p_guest_token))|(jsonb_build_object[\s\S]{0,200}?(p_access_token|p_channel_secret))/i.test(
          sql,
        );
      });

    expect(offenders).toEqual([]);
  });

  it('secret token ในฐานข้อมูลเก็บเป็น hash ไม่ใช่ค่าจริง (CLAUDE.md §2.5)', () => {
    const schema = read('supabase/migrations/20260810000003_sessions.sql');
    expect(schema).toContain('token_hash');
    expect(schema).not.toMatch(/\btoken\s+text\s+not null\b/);
  });
});
