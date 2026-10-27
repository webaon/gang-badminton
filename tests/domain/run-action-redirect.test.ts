/**
 * runAction × redirect() ของ Next [WO-6.1b]
 *
 * บั๊กเดิม: `requireUser()` ใน server action เรียก redirect('/sign-in') เมื่อเซสชันหมดอายุ
 * แล้ว runAction จับ exception นั้นเป็น INTERNAL_ERROR ⇒ ผู้ใช้เห็น "ระบบขัดข้อง" และ log เป็น error
 * ที่ต้องการ: /sign-in → UNAUTHENTICATED (client พาไป /session-expired) · redirect อื่น → rethrow ตามเดิม
 *
 * ใช้ `redirect()` ตัวจริงของ Next สร้าง error เพื่อให้เทสต์ผูกกับ format digest ของเวอร์ชันที่ติดตั้ง
 */
import { redirect } from 'next/navigation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, parseRedirectError, runAction } from '@/shared/action';

afterEach(() => vi.restoreAllMocks());

function silence() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  };
}

describe('runAction — redirect ไป /sign-in = UNAUTHENTICATED', () => {
  it('redirect("/sign-in") → { success:false, code:UNAUTHENTICATED } ไม่ใช่ INTERNAL_ERROR และไม่ log เป็น error', async () => {
    const log = silence();
    const res = await runAction('cid-1', async () => redirect('/sign-in'));

    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('UNAUTHENTICATED');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('redirect("/sign-in?next=%2Fprofile") (รูปที่ requireUser(returnTo) สร้าง) → UNAUTHENTICATED', async () => {
    silence();
    const res = await runAction('cid-2', async () => redirect('/sign-in?next=%2Fprofile'));
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('UNAUTHENTICATED');
  });

  it('ข้อความที่ส่งกลับไม่รั่ว URL ปลายทาง', async () => {
    silence();
    const res = await runAction('cid-3', async () => redirect('/sign-in?next=%2Fgangs%2Fsecret'));
    expect(JSON.stringify(res)).not.toContain('secret');
  });
});

describe('runAction — redirect อื่นต้อง rethrow (ห้ามกลืน)', () => {
  for (const dest of ['/gangs', '/sign-in-other', '/profile?next=/sign-in', 'https://evil.example/sign-in']) {
    it(`redirect(${dest}) ถูกโยนต่อ`, async () => {
      silence();
      await expect(runAction('cid-r', async () => redirect(dest))).rejects.toMatchObject({
        digest: expect.stringContaining('NEXT_REDIRECT'),
      });
    });
  }
});

describe('runAction — พฤติกรรมเดิมไม่เปลี่ยน', () => {
  it('error ธรรมดายังเป็น INTERNAL_ERROR + log error', async () => {
    const log = silence();
    const res = await runAction('cid-4', async () => {
      throw new Error('boom');
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.code).toBe('INTERNAL_ERROR');
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('AppError ยังคง code ของตัวเอง', async () => {
    silence();
    const res = await runAction('cid-5', async () => {
      throw new AppError('FORBIDDEN');
    });
    if (!res.success) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('error ที่มี digest อื่น (เช่น NEXT_NOT_FOUND) ไม่ถูกตีเป็น redirect', () => {
    expect(parseRedirectError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toBeNull();
    expect(parseRedirectError({ digest: 'NEXT_REDIRECT;bogus;/sign-in;307;' })).toBeNull();
    expect(parseRedirectError(new Error('x'))).toBeNull();
    expect(parseRedirectError(null)).toBeNull();
  });

  it('parseRedirectError: URL ที่มี ; ถูกรวมกลับครบ', () => {
    expect(parseRedirectError({ digest: 'NEXT_REDIRECT;replace;/a;b;c;307;' })).toEqual({ destination: '/a;b;c' });
  });
});
