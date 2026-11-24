/**
 * WO-6.1b — helper ข้อความ error (`errorText`) + grep gate ห้ามแตะ `error.message` นอก helper
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import { ERROR_MESSAGES_TH } from '@/lib/i18n/error-messages';
import { MAX_SERVER_MESSAGE, SERVER_MESSAGE_CODES, actionError, errorText } from '@/lib/i18n/error-text';
import { ERROR_CODES, type ErrorCode } from '@/shared/errors';

describe('errorText — code ทั่วไปได้ข้อความตายตัว แม้ server ส่งข้อความไทยมา', () => {
  const GENERAL = ERROR_CODES.filter((c) => !SERVER_MESSAGE_CODES.has(c));

  it.each(GENERAL)('%s → ข้อความตายตัว (ไม่ใช้ message จาก server)', (code) => {
    expect(errorText({ code, message: 'ข้อความไทยจาก server ที่ไม่ควรโผล่' })).toBe(ERROR_MESSAGES_TH[code]);
    expect(errorText({ code, message: 'raw english message' })).toBe(ERROR_MESSAGES_TH[code]);
  });

  it('ข้อยกเว้นมีแค่ VALIDATION_ERROR กับ CONFIRMATION_REQUIRED (รายการคงที่)', () => {
    expect([...SERVER_MESSAGE_CODES].sort()).toEqual(['CONFIRMATION_REQUIRED', 'VALIDATION_ERROR']);
  });
});

describe('errorText — VALIDATION_ERROR / CONFIRMATION_REQUIRED', () => {
  it('ข้อความไทยจาก server ผ่าน (ผู้ใช้ต้องรู้ว่าผิดตรงไหน)', () => {
    expect(errorText({ code: 'VALIDATION_ERROR', message: 'เวลาจบต้องหลังเวลาเริ่ม' })).toBe(
      'เวลาจบต้องหลังเวลาเริ่ม',
    );
    expect(errorText({ code: 'CONFIRMATION_REQUIRED', message: 'ยังไม่มีใครเช็คอิน ยืนยันปิดรอบหรือไม่' })).toBe(
      'ยังไม่มีใครเช็คอิน ยืนยันปิดรอบหรือไม่',
    );
  });

  it('ข้อความอังกฤษ (แบบ Supabase Auth) → fallback ตายตัว ไม่หลุดออกจอ', () => {
    const text = errorText({ code: 'VALIDATION_ERROR', message: 'Invalid login credentials' });
    expect(text).toBe(ERROR_MESSAGES_TH.VALIDATION_ERROR);
    expect(text).not.toMatch(/credentials/i);
    expect(errorText({ code: 'VALIDATION_ERROR', message: 'Password should be at least 6 characters.' })).toBe(
      ERROR_MESSAGES_TH.VALIDATION_ERROR,
    );
  });

  it('ข้อความว่าง / เป็นตัว code เอง (fail() ไม่ระบุ message) → fallback', () => {
    for (const message of ['', '   ', 'VALIDATION_ERROR', undefined]) {
      expect(errorText({ code: 'VALIDATION_ERROR', message })).toBe(ERROR_MESSAGES_TH.VALIDATION_ERROR);
    }
  });

  it(`ตัดข้อความยาวเกิน ${MAX_SERVER_MESSAGE} ตัวอักษร`, () => {
    const long = 'ก'.repeat(MAX_SERVER_MESSAGE + 150);
    const text = errorText({ code: 'VALIDATION_ERROR', message: long });
    expect(text.length).toBe(MAX_SERVER_MESSAGE + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('ข้อความที่มี HTML ถูกส่งออกเป็น string ตามเดิม (React escape ตอน render) — helper ไม่แปลงเป็น markup', () => {
    const msg = 'ชื่อ <script>alert(1)</script> ไม่ถูกต้อง';
    expect(typeof errorText({ code: 'VALIDATION_ERROR', message: msg })).toBe('string');
  });
});

describe('errorText — INTERNAL_ERROR และกรณีผิดปกติ', () => {
  it('INTERNAL_ERROR ไม่ render message จาก server เลย (แม้เป็นไทย)', () => {
    expect(errorText({ code: 'INTERNAL_ERROR', message: 'relation "payments" does not exist' })).toBe(
      ERROR_MESSAGES_TH.INTERNAL_ERROR,
    );
    expect(errorText({ code: 'INTERNAL_ERROR', message: 'ตาราง payments พัง' })).toBe(ERROR_MESSAGES_TH.INTERNAL_ERROR);
  });

  it('ไม่มี error / code แปลก / ไม่มี code → ข้อความของ INTERNAL_ERROR', () => {
    const generic = ERROR_MESSAGES_TH.INTERNAL_ERROR;
    expect(errorText(undefined)).toBe(generic);
    expect(errorText(null)).toBe(generic);
    expect(errorText({ message: 'ข้อความไทยแต่ไม่มี code' })).toBe(generic);
    expect(errorText({ code: 'SOMETHING_NEW', message: 'ข้อความไทย' })).toBe(generic);
  });

  it('ทุกผลลัพธ์เป็นข้อความไทยที่ไม่ว่าง', () => {
    for (const code of ERROR_CODES as readonly ErrorCode[]) {
      const text = errorText({ code, message: 'x' });
      expect(text.trim()).not.toBe('');
      expect(text).toMatch(/[\u0E00-\u0E7F]/);
    }
  });

  it('actionError ให้ข้อความเหมือน errorText และไม่พังนอกเบราว์เซอร์ (UNAUTHENTICATED ไม่ redirect เมื่อไม่มี window)', () => {
    expect(typeof window).toBe('undefined');
    expect(actionError({ code: 'UNAUTHENTICATED', message: 'x' })).toBe(ERROR_MESSAGES_TH.UNAUTHENTICATED);
    expect(actionError({ code: 'VALIDATION_ERROR', message: 'ต้องระบุชื่อนัด' })).toBe('ต้องระบุชื่อนัด');
  });

  it('actionError: UNAUTHENTICATED ในเบราว์เซอร์ → พาไป /session-expired พร้อม next = หน้าเดิม (encode แล้ว) · code อื่นไม่ redirect', () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/gangs/abc/members', search: '?tab=1', assign } });
    try {
      actionError({ code: 'FORBIDDEN', message: 'x' });
      actionError({ code: 'INTERNAL_ERROR', message: 'x' });
      expect(assign).not.toHaveBeenCalled();

      actionError({ code: 'UNAUTHENTICATED', message: 'x' });
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith(`/session-expired?next=${encodeURIComponent('/gangs/abc/members?tab=1')}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ───────────────────────── grep gate ─────────────────────────

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** ตัด comment ออกก่อน — คอมเมนต์ที่อธิบายกติกาไม่ควรทำให้เทสต์ล้ม */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('grep gate: ห้ามอ่าน/แสดง `.message` ของ error นอก helper', () => {
  const files = ['features', 'app']
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => /\.tsx$/.test(f));

  it('มีไฟล์ให้ตรวจจริง (sanity)', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('ไม่มี `<error>.message` / `error?.message` ใน features/ และ app/**/*.tsx', () => {
    const offenders = files.filter((f) =>
      /\b\w*[eE]rr(or)?\??\.message\b/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('ไม่มีข้อความ fallback hardcode `ทำรายการไม่สำเร็จ` กระจายใน features/ (ใช้ ERROR_MESSAGES_TH)', () => {
    const offenders = files.filter((f) => stripComments(readFileSync(f, 'utf8')).includes("'ทำรายการไม่สำเร็จ'"));
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('ไม่ render ข้อความ error ด้วย dangerouslySetInnerHTML', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });
});
