/**
 * กติกาหน้าจ่ายเงินฝั่งสมาชิก (hi-fi 30/31) — pure
 *
 * 🔴 ที่นี่ **ไม่คิดเงินเลย** — มีแค่ (1) ตรวจไฟล์สลิปก่อนอัป ให้ตรงกับ bucket `payment-slips` จริง
 *    (5MB · jpeg/png/webp/pdf — migration 20260811000011) และ (2) แปลง `payments.status` เป็นขั้น 3 ขั้นของหน้าจอ
 *    ฝั่ง storage/DB ยังเป็นด่านจริง — ตรวจฝั่ง client เพื่อบอกผู้ใช้เร็วด้วยข้อความไทยคงที่เท่านั้น
 */

export const SLIP_MAX_BYTES = 5 * 1024 * 1024;
export const SLIP_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
/** ใช้กับ `accept` ของ input (ตัวเลือกไฟล์/กล้องของระบบ) — ตรวจชนิดจริงทีหลังด้วย `checkSlipFile` เพื่อให้ได้ข้อความไทย */
export const SLIP_PICKER_ACCEPT = 'image/*,application/pdf';

export type SlipProblem = 'empty' | 'too_large' | 'bad_type';

export function checkSlipFile(file: { size: number; type: string }): SlipProblem | null {
  if (file.size <= 0) return 'empty';
  if (!(SLIP_MIME_TYPES as readonly string[]).includes(file.type)) return 'bad_type';
  if (file.size > SLIP_MAX_BYTES) return 'too_large';
  return null;
}

export const SLIP_PROBLEM_TEXT: Record<SlipProblem, string> = {
  empty: 'ไฟล์นี้ว่างเปล่า — เลือกรูปสลิปใหม่',
  bad_type: 'ชนิดไฟล์ไม่รองรับ — ใช้ JPG, PNG, WebP หรือ PDF (รูป HEIC ให้แคปหน้าจอสลิปแทน)',
  too_large: 'ไฟล์ใหญ่กว่า 5MB — แคปหน้าจอสลิปแทน หรือเลือกรูปใหม่',
};

/** "2.4 MB" / "340 KB" — ใช้แสดงขนาดไฟล์ (ไม่ใช่จำนวนเงิน) */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type PayStepState = 'done' | 'current' | 'todo';

export type PayStep = { label: string; state: PayStepState };

/**
 * ขั้นสถานะ 3 ขั้น (ส่งสลิป → แอดมินตรวจ → ยืนยันแล้ว) จาก `payments.status`
 *   pending   = ยังไม่ส่งสลิป → ขั้น 1 กำลังทำ
 *   rejected  = ถูกปฏิเสธ → กลับมาขั้น 1 (อัปสลิปใหม่)
 *   submitted = รอแอดมิน → ขั้น 2
 *   verified  = จบ
 * สถานะที่ไม่รู้จัก ⇒ ถือเป็นขั้น 1 (ปลอดภัยกว่าโชว์ว่ายืนยันแล้ว)
 */
export function payStepsOf(status: string): PayStep[] {
  const labels = ['ส่งสลิป', 'แอดมินตรวจ', 'ยืนยันแล้ว'] as const;
  const current = status === 'verified' ? 3 : status === 'submitted' ? 1 : 0;
  return labels.map((label, i) => ({
    label,
    state: i < current ? 'done' : i === current ? 'current' : 'todo',
  }));
}
