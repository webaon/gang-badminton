/**
 * กัน open redirect ที่พารามิเตอร์ `next`
 *
 * เทสต์นี้แยกจาก route handler โดยตั้งใจ — เวลายิงผ่าน HTTP จริงด้วย code ปลอม
 * flow จะไปตกที่ "แลก code ไม่สำเร็จ" ก่อนถึงบรรทัด redirect ⇒ พิสูจน์ตัวกัน
 * open redirect ไม่ได้เลย ต้องทดสอบฟังก์ชันตรงๆ
 */
import { describe, it, expect } from 'vitest';
import { safeNext, DEFAULT_NEXT } from '@/lib/url/safe-next';

describe('safeNext — รับเฉพาะ path ภายใน', () => {
  it('path ภายในปกติผ่าน', () => {
    expect(safeNext('/profile')).toBe('/profile');
    expect(safeNext('/gangs/123/sessions?tab=open')).toBe('/gangs/123/sessions?tab=open');
  });

  it('ไม่ส่งมา / ว่าง → ค่า default', () => {
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext('')).toBe(DEFAULT_NEXT);
  });

  it('🔴 URL เต็มพาออกนอกเว็บไม่ได้', () => {
    for (const evil of [
      'https://evil.example',
      'http://evil.example/login',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(safeNext(evil), evil).toBe(DEFAULT_NEXT);
    }
  });

  it('🔴 protocol-relative URL (//host) ถูกปฏิเสธ', () => {
    expect(safeNext('//evil.example')).toBe(DEFAULT_NEXT);
    expect(safeNext('//evil.example/path')).toBe(DEFAULT_NEXT);
  });

  it('🔴 backslash ที่บางเบราว์เซอร์ตีความเป็น / ถูกปฏิเสธ', () => {
    expect(safeNext('/\\evil.example')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\\/evil.example')).toBe(DEFAULT_NEXT);
    expect(safeNext('/path\\..\\evil')).toBe(DEFAULT_NEXT);
  });

  it('เว้นวรรคหัวท้ายถูกตัดก่อนตรวจ (กันเลี่ยงด้วยช่องว่าง)', () => {
    expect(safeNext('  /profile  ')).toBe('/profile');
    expect(safeNext('  https://evil.example  ')).toBe(DEFAULT_NEXT);
  });

  it('เปลี่ยน fallback ได้', () => {
    expect(safeNext('https://evil.example', '/sign-in')).toBe('/sign-in');
  });
});
