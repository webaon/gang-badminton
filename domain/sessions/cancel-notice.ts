/**
 * ข้อความ "บอกผลก่อนยกเลิก" (hi-fi 19 · WO-6.2) — pure
 *
 * 🔴 ที่นี่ **ไม่คำนวณ cutoff / grace / ค่าปรับเอง** (ผู้ตัดสินคือ `preview_cancel_registration()` ใน DB —
 *    ตัวตัดสินเดียวกับ `cancel_registration()`) รับผลที่ `cancelPreview()` ส่งมาแล้วแปลงเป็นข้อความไทยเท่านั้น
 *    ไม่ระบุจำนวนเงิน — เงินคิดตอนปิดรอบ
 *
 * ถ้ายังไม่มี preview (`null` — เช่น เรียกไม่สำเร็จ) ใช้ข้อความกลางที่ไม่อ้างเวลา/จำนวน — ดีกว่าบอกผิด
 */
export type CancelPreview = {
  outcome: 'free_in_grace' | 'free_before_cutoff' | 'penalty' | 'blocked';
  /** ISO — ยกเลิกฟรีได้ถึงเวลานี้ · null = ไม่มีเส้นตาย/ไม่ฟรี */
  freeUntil: string | null;
  /** ประเภทค่าปรับ (เฉพาะ outcome = penalty) — ค่าที่ไม่รู้จักถือเป็น "ตามกติกาของก๊วน" */
  penaltyType: string | null;
  reason: 'waitlist' | 'before_cutoff' | 'promoted_grace' | 'late_cancel' | 'cutoff_passed';
};

export type CancelNotice = {
  tone: 'success' | 'warning' | 'error' | 'neutral';
  title: string;
  description: string;
};

const PENALTY_TEXT: Record<string, string> = {
  full_share: 'ต้องจ่ายส่วนแบ่งเท่ากับผู้เล่นที่มาจริง',
  fixed: 'มีค่าปรับตามจำนวนที่ก๊วนกำหนดไว้',
  percent: 'มีค่าปรับตามเปอร์เซ็นต์ที่ก๊วนกำหนดไว้',
  none: 'ไม่มีค่าปรับ',
};

const PENALTY_FALLBACK = 'มีค่าปรับตามกติกาของก๊วน';

function penaltyText(type: string | null): string {
  return (type && PENALTY_TEXT[type]) || PENALTY_FALLBACK;
}

export function cancelNotice(preview: CancelPreview | null, formatTime: (iso: string) => string): CancelNotice {
  if (!preview) {
    return {
      tone: 'neutral',
      title: 'ยกเลิกการลงชื่อ?',
      description: 'ถ้ายกเลิกใกล้เวลาเริ่ม อาจมีค่าปรับตามกติกาของก๊วน ระบบจะแจ้งผลหลังยกเลิก',
    };
  }

  switch (preview.outcome) {
    case 'free_in_grace':
      return {
        tone: 'success',
        title: 'ยกเลิกได้ไม่เสียค่าปรับ',
        description: preview.freeUntil
          ? `คุณเพิ่งได้ที่จากคิวรอ — ยกเลิกได้ไม่เสียค่าปรับถึง ${formatTime(preview.freeUntil)}`
          : 'คุณเพิ่งได้ที่จากคิวรอ — ยกเลิกได้ไม่เสียค่าปรับตอนนี้',
      };
    case 'free_before_cutoff':
      if (preview.reason === 'waitlist') {
        return {
          tone: 'success',
          title: 'ออกจากคิวรอได้เลย',
          description: 'คุณยังไม่ได้ที่ ออกจากคิวรอได้โดยไม่เสียค่าปรับ',
        };
      }
      return {
        tone: 'success',
        title: 'ยกเลิกฟรี',
        description: preview.freeUntil
          ? `ยกเลิกฟรีถึง ${formatTime(preview.freeUntil)} · หลังจากนั้นอาจมีค่าปรับตามกติกาของก๊วน`
          : 'ตอนนี้ยกเลิกได้โดยไม่เสียค่าปรับ',
      };
    case 'penalty':
      return {
        tone: 'warning',
        title: 'ยกเลิกตอนนี้จะมีค่าปรับ',
        description: `เลยเวลายกเลิกฟรีแล้ว — ${penaltyText(preview.penaltyType)}`,
      };
    case 'blocked':
      return {
        tone: 'error',
        title: 'ยกเลิกเองไม่ได้แล้ว',
        description: 'เลยเวลาที่ก๊วนอนุญาตให้ยกเลิก — ติดต่อแอดมินถ้าจำเป็นต้องยกเลิก',
      };
  }
}
