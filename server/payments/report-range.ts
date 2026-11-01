import 'server-only';
import { zonedTimeToUtc } from '@/domain/time/timezone';
import { AppError } from '@/shared/action';

export type FinanceDateRange = { from: string; to: string };
const TIME_ZONE = 'Asia/Bangkok';
function dateOnly(value: string): Date {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'วันที่ต้องเป็น YYYY-MM-DD');
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new AppError('VALIDATION_ERROR', 'วันที่ไม่ถูกต้อง');
  }
  return d;
}

/** Q-R1: inclusive local dates, exclusive next midnight. Never use server-local Date parsing. */
export function financeRange(range: FinanceDateRange) {
  dateOnly(range.from);
  const next = dateOnly(range.to);
  if (range.from > range.to) throw new AppError('VALIDATION_ERROR', 'วันเริ่มต้องไม่เกินวันสิ้นสุด');
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  return {
    from: range.from, to: range.to, timeZone: TIME_ZONE,
    startUtc: zonedTimeToUtc(`${range.from}T00:00`, TIME_ZONE).toISOString(),
    endUtcExclusive: zonedTimeToUtc(`${tomorrow}T00:00`, TIME_ZONE).toISOString(),
  };
}
