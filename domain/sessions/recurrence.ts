/**
 * Recurrence ของนัดประจำ — **[WO-2.5-E]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * รูปแบบใน `session_templates.recurrence` (ตาม comment ใน migration 0003):
 *
 *     { "days": [1, 4], "start_time": "19:00", "end_time": "21:00" }
 *
 * 🔴 `days` ใช้เลขวันแบบ JavaScript: **0 = อาทิตย์ … 6 = เสาร์**
 *    (ตรงกับ `Date.getUTCDay()` ที่ใช้คำนวณด้านล่าง — ถ้าใช้เลขแบบ ISO 1–7
 *    วันอาทิตย์จะเพี้ยนไปทั้งชุดโดยไม่มีอะไรฟ้อง)
 *
 * ⚠️ โมดูลนี้ทำงานบน **เวลาบนนาฬิกาของก๊วน** ล้วน (string `YYYY-MM-DDTHH:mm`)
 *    ไม่มี `Date` ที่ผูกกับโซนเวลาโผล่ออกไปข้างนอก — คนเรียกเป็นคนแปลงเป็น instant
 *    ด้วย `zonedTimeToUtc(local, gang.timezone)` (baseline §Timezone)
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework
 */

export type Recurrence = {
  /** 0 = อาทิตย์ … 6 = เสาร์ */
  days: number[];
  /** `HH:mm` บนนาฬิกาของก๊วน */
  startTime: string;
  endTime: string;
};

export type RecurrenceJson = {
  days: number[];
  start_time: string;
  end_time: string;
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DAY_LABELS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

export function toJson(recurrence: Recurrence): RecurrenceJson {
  return {
    // เรียงและตัดซ้ำ ⇒ template ที่เหมือนกันได้ json ก้อนเดียวกันเสมอ (diff อ่านง่าย)
    days: [...new Set(recurrence.days)].sort((a, b) => a - b),
    start_time: recurrence.startTime,
    end_time: recurrence.endTime,
  };
}

/**
 * อ่านจาก jsonb — **ผ่อนปรน** เพราะข้อมูลเก่าอาจไม่ครบ
 * ความเข้มอยู่ที่ `validate()` ตอนเขียน (แนวเดียวกับ cancellation policy)
 */
export function fromJson(raw: unknown): Recurrence {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const days = Array.isArray(obj.days)
    ? obj.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];

  return {
    days: [...new Set(days)].sort((a, b) => a - b),
    startTime: typeof obj.start_time === 'string' ? obj.start_time : '19:00',
    endTime: typeof obj.end_time === 'string' ? obj.end_time : '21:00',
  };
}

export type ValidationIssue = { field: string; message: string };

export function validate(recurrence: Recurrence): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (recurrence.days.length === 0) {
    issues.push({ field: 'days', message: 'เลือกอย่างน้อยหนึ่งวัน' });
  }
  if (recurrence.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    issues.push({ field: 'days', message: 'วันในสัปดาห์ต้องเป็น 0–6 (0 = อาทิตย์)' });
  }
  if (!TIME_RE.test(recurrence.startTime)) {
    issues.push({ field: 'startTime', message: 'เวลาเริ่มต้องเป็นรูปแบบ HH:mm' });
  }
  if (!TIME_RE.test(recurrence.endTime)) {
    issues.push({ field: 'endTime', message: 'เวลาจบต้องเป็นรูปแบบ HH:mm' });
  }
  if (TIME_RE.test(recurrence.startTime) && recurrence.startTime === recurrence.endTime) {
    issues.push({ field: 'endTime', message: 'เวลาจบต้องไม่เท่ากับเวลาเริ่ม' });
  }

  return issues;
}

export type Occurrence = {
  /** `YYYY-MM-DDTHH:mm` บนนาฬิกาของก๊วน */
  startLocal: string;
  endLocal: string;
};

/** บวกวันให้กับวันที่แบบ `YYYY-MM-DD` โดยไม่แตะโซนเวลา */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * รายการนัดที่ควรมีในช่วง `[fromDate, fromDate + horizonDays)`
 *
 * @param fromDate วันแรกที่นับ (`YYYY-MM-DD` บนนาฬิกาของก๊วน) — รวมวันนี้ด้วย
 *
 * ⚠️ **จบข้ามเที่ยงคืนได้**: ถ้า `end_time ≤ start_time` ถือว่าจบวันถัดไป
 *    (เล่น 22:00–00:30 เป็นเรื่องปกติของก๊วนกลางคืน) ⇒ ไม่งั้น `ends_at > starts_at`
 *    ที่ระดับ DB จะพังทุกครั้งที่ก๊วนแบบนี้ตั้ง template
 */
export function occurrencesBetween(
  recurrence: Recurrence,
  fromDate: string,
  horizonDays: number,
): Occurrence[] {
  if (!DATE_RE.test(fromDate)) {
    throw new Error(`วันที่เริ่มต้องเป็นรูปแบบ YYYY-MM-DD: ${fromDate}`);
  }
  if (!Number.isInteger(horizonDays) || horizonDays < 1) {
    throw new Error(`ช่วงที่ generate ต้องเป็นจำนวนเต็มบวก: ${horizonDays}`);
  }
  if (validate(recurrence).length > 0) {
    // ❌ ห้าม generate จาก recurrence ที่ใช้ไม่ได้ — จะได้นัดเวลามั่วโดยไม่มีใครรู้
    throw new Error('recurrence ไม่ถูกต้อง — generate ไม่ได้');
  }

  const wanted = new Set(recurrence.days);
  const crossesMidnight = recurrence.endTime <= recurrence.startTime;

  const result: Occurrence[] = [];

  for (let offset = 0; offset < horizonDays; offset++) {
    const date = addDays(fromDate, offset);
    if (!wanted.has(dayOfWeek(date))) continue;

    result.push({
      startLocal: `${date}T${recurrence.startTime}`,
      endLocal: crossesMidnight
        ? `${addDays(date, 1)}T${recurrence.endTime}`
        : `${date}T${recurrence.endTime}`,
    });
  }

  return result;
}
