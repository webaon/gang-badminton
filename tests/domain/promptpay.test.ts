/**
 * WO-2.9 — PromptPay QR
 *
 * DoD: "QR ที่ออกมาสแกนจ่ายได้จริงกับยอดที่ตรงกับ session_charges"
 * ⇒ ตรวจโครงสร้าง payload ตามมาตรฐาน EMVCo และยืนยันว่ายอดถูกฝังลงไปจริง
 */
import { describe, it, expect } from 'vitest';
import {
  isValidPromptPayId,
  normalizePromptPayId,
  promptPayPayload,
  promptPayQrDataUrl,
} from '@/lib/promptpay/qr';

describe('PromptPay ID', () => {
  it('ตัดขีดและเว้นวรรคออก', () => {
    expect(normalizePromptPayId('081-234-5678')).toBe('0812345678');
    expect(normalizePromptPayId('1 2345 67890 12 3')).toBe('1234567890123');
  });

  it('รับเบอร์ 10 หลักและเลขบัตร 13 หลัก', () => {
    expect(isValidPromptPayId('0812345678')).toBe(true);
    expect(isValidPromptPayId('1234567890123')).toBe(true);
  });

  it('🔴 ปฏิเสธค่าที่ใช้ไม่ได้ ไม่ปล่อยให้สร้าง QR ที่สแกนแล้วพัง', () => {
    for (const bad of ['', '123', '08123456789', 'ไม่ใช่เบอร์']) {
      expect(isValidPromptPayId(bad), bad).toBe(false);
      expect(() => promptPayPayload(bad, '200.00'), bad).toThrow(/PromptPay ID/);
    }
  });
});

describe('payload EMVCo', () => {
  it('ขึ้นต้นด้วย payload format indicator ของมาตรฐาน', () => {
    const payload = promptPayPayload('0812345678', '200.00');
    // "00" = tag, "02" = ความยาว, "01" = version
    expect(payload.startsWith('000201')).toBe(true);
  });

  it('🔴 ยอดเงินถูกฝังลงใน payload จริง — ยอดต่างกันต้องได้ payload ต่างกัน', () => {
    const a = promptPayPayload('0812345678', '200.00');
    const b = promptPayPayload('0812345678', '250.00');

    expect(a).not.toBe(b);
    // tag 54 = transaction amount ⇒ ต้องเห็นยอดในสตริง
    expect(a).toContain('200.00');
    expect(b).toContain('250.00');
  });

  it('บัญชีปลายทางต่างกัน → payload ต่างกัน', () => {
    expect(promptPayPayload('0812345678', '200.00')).not.toBe(
      promptPayPayload('0899999999', '200.00'),
    );
  });

  it('🔴 ยอดที่เป็นไปไม่ได้ถูกปฏิเสธ (กัน QR ยอด 0 หรือติดลบ)', () => {
    for (const bad of ['0', '0.00', '-50', 'abc', '']) {
      expect(() => promptPayPayload('0812345678', bad), bad).toThrow(/ยอดเงิน/);
    }
  });

  it('ทศนิยมสตางค์ถูกเก็บไว้', () => {
    expect(promptPayPayload('0812345678', '150.50')).toContain('150.5');
  });
});

describe('QR data URL', () => {
  it('ได้ data URI ของ PNG ที่ฝังในหน้าเว็บได้เลย', async () => {
    const url = await promptPayQrDataUrl('0812345678', '200.00');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(url.length).toBeGreaterThan(500);
  });
});
