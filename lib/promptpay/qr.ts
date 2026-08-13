import generatePayload from 'promptpay-qr';
import QRCode from 'qrcode';

/**
 * PromptPay QR ต่อคน (baseline §โมดูล ข้อ 5)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 PromptPay ID และยอด **อ่านจาก snapshot / session_charges เท่านั้น**
 *    ห้ามรับจาก client — ถ้ารับมาจะสร้าง QR ที่โอนเข้าบัญชีใครก็ได้ในหน้าเว็บของเรา
 *
 * ⚠️ ยอดใน QR ต้องตรงกับ `payments.amount` เป๊ะ ไม่งั้นแอดมินจะเห็นสลิปที่ยอดไม่ตรง
 *    แล้วต้องมานั่งไล่เอง
 */

/** ลบขีด/เว้นวรรคออกจากเบอร์หรือเลขบัตร — promptpay-qr รับเฉพาะตัวเลข */
export function normalizePromptPayId(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

/**
 * ตรวจว่า PromptPay ID อยู่ในรูปแบบที่ใช้ได้
 *
 * รองรับ: เบอร์มือถือ 10 หลัก · เลขบัตรประชาชน 13 หลัก · เลขนิติบุคคล 13 หลัก
 * (e-Wallet 15 หลักไม่รองรับใน MVP-0 — ก๊วนใช้เบอร์กับเลขบัตรเป็นหลัก)
 */
export function isValidPromptPayId(raw: string): boolean {
  const id = normalizePromptPayId(raw);
  return id.length === 10 || id.length === 13;
}

/** payload มาตรฐาน EMVCo ที่แอปธนาคารสแกนได้ */
export function promptPayPayload(promptPayId: string, amount: string): string {
  const id = normalizePromptPayId(promptPayId);

  if (!isValidPromptPayId(id)) {
    throw new Error(`PromptPay ID ไม่ถูกต้อง: "${promptPayId}"`);
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ยอดเงินไม่ถูกต้อง: "${amount}"`);
  }

  // promptpay-qr รับยอดเป็น number — ปลอดภัยตรงนี้เพราะเป็นแค่การ **แสดงผล**
  // ยอดที่เป็นความจริงคือ `payments.amount` (numeric) ที่ฐานข้อมูล
  return generatePayload(id, { amount: value });
}

/** QR เป็น data URI ฝังในหน้าเว็บได้เลย ไม่ต้องยิงไปเซิร์ฟเวอร์อื่น */
export async function promptPayQrDataUrl(promptPayId: string, amount: string): Promise<string> {
  return QRCode.toDataURL(promptPayPayload(promptPayId, amount), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}
