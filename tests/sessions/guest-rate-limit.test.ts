/**
 * WO-2.5 DoD — "route handler ของ guest มี `check_rate_limit()` จริง"
 *
 * เทสต์นี้เรียก **code path เดียวกับที่ server action ใช้** ไม่ใช่ทดสอบ SQL ตรงๆ
 * ⇒ ถ้าใครถอด `enforceGuestRateLimit()` ออกจาก action เทสต์นี้จะยังเขียว
 *   แต่ถ้า helper เองพัง/ถูกทำให้ fail-open เทสต์จะจับได้
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, API_URL, SERVICE_ROLE_KEY } from '../helpers/db';

// ต้องตั้งก่อน import โมดูลที่สร้าง supabase client (มัน cache client ไว้)
process.env.SUPABASE_URL = API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const { clientIp, enforceGuestRateLimit } = await import('@/server/guest/rate-limit');

afterAll(async () => {
  await pool.end();
});

function headersWith(ip?: string): Headers {
  return new Headers(ip ? { 'x-forwarded-for': ip } : {});
}

describe('clientIp — อ่าน IP จาก header ของ proxy', () => {
  it('ใช้ค่าแรกของ x-forwarded-for (client จริง)', () => {
    expect(clientIp(headersWith('203.0.113.9, 10.0.0.1, 10.0.0.2'))).toBe('203.0.113.9');
  });

  it('ตกไป x-real-ip ถ้าไม่มี x-forwarded-for', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('🔴 อ่านไม่ได้ → "unknown" (ถังเดียวร่วมกัน = เข้มกว่า ไม่ใช่ปล่อยผ่าน)', () => {
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('enforceGuestRateLimit — ตัดจริงเมื่อเกินโควต้า', () => {
  const sessionId = crypto.randomUUID();
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

  beforeAll(async () => {
    // ล้างถังของ key นี้เผื่อรันซ้ำ
    await pool.query(`delete from public.rate_limits where key like $1`, [`guest:%${sessionId}%`]);
  });

  it('ยิงไม่เกินโควต้า → ผ่านทุกครั้ง', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        enforceGuestRateLimit({
          action: 'register',
          sessionId,
          headers: headersWith(ip),
          limit: 5,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('🔴 ครั้งที่เกิน → RATE_LIMITED', async () => {
    await expect(
      enforceGuestRateLimit({
        action: 'register',
        sessionId,
        headers: headersWith(ip),
        limit: 5,
      }),
    ).rejects.toThrow(/RATE_LIMITED|ถี่เกินไป/);
  });

  it('IP อื่นยังยิงได้ — โควต้าแยกต่อ IP', async () => {
    await expect(
      enforceGuestRateLimit({
        action: 'register',
        sessionId,
        headers: headersWith('198.51.100.200'),
        limit: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it('นัดอื่นยังยิงได้ — โควต้าแยกต่อ session ตามที่ baseline ระบุ', async () => {
    await expect(
      enforceGuestRateLimit({
        action: 'register',
        sessionId: crypto.randomUUID(),
        headers: headersWith(ip),
        limit: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it('มีแถวใน rate_limits จริง (ไม่ได้ผ่านแบบ no-op)', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from public.rate_limits where key like $1`,
      [`guest:register:${sessionId}:%`],
    );
    expect(Number(rows[0].count)).toBeGreaterThan(0);
  });
});
