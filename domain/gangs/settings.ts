/**
 * `gangs.settings` — การตั้งค่าทั่วไปของก๊วน **[WO-2.5-G]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * คีย์ที่ใช้จริงตอนนี้:
 *
 *     { "reminder": { "session_hours_before": 24, "payment_due_after_hours": 24 } }
 *
 * ⚠️ อ่านแบบ **ผ่อนปรน** (ก๊วนเก่าไม่มีคีย์นี้) แต่เขียนแบบ **เข้ม** (`validate()`)
 *    — แนวเดียวกับ cancellation policy และ recurrence
 *
 * ⚠️ `settings` ไม่ได้อยู่ใน snapshot ของนัด และ**ไม่ควรอยู่** — มันไม่กระทบเงิน
 *    แก้เวลาเตือนแล้วมีผลกับนัดที่ยังไม่ได้เตือนทันที ซึ่งเป็นสิ่งที่คนตั้งค่าคาดหวัง
 *
 * pure TypeScript — `domain/` ห้ามแตะ framework
 */

export type ReminderSettings = {
  /** เตือนก่อนนัดกี่ชั่วโมง — 0 = ปิดการเตือนนัด */
  sessionHoursBefore: number;
  /** เตือนยอดค้างหลังนัดจบกี่ชั่วโมง — 0 = ปิดการเตือนจ่าย */
  paymentDueAfterHours: number;
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  sessionHoursBefore: 24,
  paymentDueAfterHours: 24,
};

/** เพดานกันตั้งค่าพลาดจนกลายเป็นสแปม/ไม่มีวันส่ง */
const MAX_HOURS = 24 * 14;

export function reminderFromJson(raw: unknown): ReminderSettings {
  const settings = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const reminder = (
    typeof settings.reminder === 'object' && settings.reminder !== null ? settings.reminder : {}
  ) as Record<string, unknown>;

  return {
    sessionHoursBefore: readHours(reminder.session_hours_before, DEFAULT_REMINDER_SETTINGS.sessionHoursBefore),
    paymentDueAfterHours: readHours(
      reminder.payment_due_after_hours,
      DEFAULT_REMINDER_SETTINGS.paymentDueAfterHours,
    ),
  };
}

function readHours(value: unknown, fallback: number): number {
  // ❌ ไม่เชื่อค่าใน jsonb — ค่าที่พังต้องตกไปใช้ default ไม่ใช่ทำให้ cron พัง
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > MAX_HOURS) return fallback;
  return Math.round(value);
}

export function reminderToJson(settings: ReminderSettings): {
  reminder: { session_hours_before: number; payment_due_after_hours: number };
} {
  return {
    reminder: {
      session_hours_before: settings.sessionHoursBefore,
      payment_due_after_hours: settings.paymentDueAfterHours,
    },
  };
}

export type ValidationIssue = { field: string; message: string };

export function validateReminder(settings: ReminderSettings): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [field, value, label] of [
    ['sessionHoursBefore', settings.sessionHoursBefore, 'เตือนก่อนนัด'],
    ['paymentDueAfterHours', settings.paymentDueAfterHours, 'เตือนยอดค้าง'],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_HOURS) {
      issues.push({ field, message: `${label}ต้องเป็นจำนวนชั่วโมง 0–${MAX_HOURS} (0 = ปิด)` });
    }
  }

  return issues;
}

/**
 * ถึงเวลาเตือนนัดนี้หรือยัง
 *
 * 🔴 หน้าต่างคือ **[now, now + hours]** — เตือนเมื่อใกล้ถึงเวลาแล้วเท่านั้น
 *    ⇒ นัดที่เริ่มไปแล้วไม่ต้องเตือน (`startsAt <= now` คืน false)
 *
 * ⚠️ ชั่วโมงเป็นค่าสัมบูรณ์ ไม่ต้องแปลง timezone — "24 ชั่วโมงก่อนเริ่ม"
 *    มีความหมายเดียวกันทุกโซนเวลา (ต่างจาก "9 โมงเช้าของวันก่อน")
 */
export function shouldRemindSession(startsAt: Date, now: Date, hoursBefore: number): boolean {
  if (hoursBefore <= 0) return false;

  const lead = startsAt.getTime() - now.getTime();
  return lead > 0 && lead <= hoursBefore * 60 * 60 * 1000;
}

/** ถึงเวลาเตือนยอดค้างหรือยัง — นับจากเวลาที่นัดจบ */
export function shouldRemindPayment(endedAt: Date, now: Date, hoursAfter: number): boolean {
  if (hoursAfter <= 0) return false;

  return now.getTime() - endedAt.getTime() >= hoursAfter * 60 * 60 * 1000;
}
