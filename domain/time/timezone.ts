/**
 * แปลงเวลาระหว่าง "เวลาบนนาฬิกาของก๊วน" กับ instant จริง (UTC)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ทำไมต้องมีโมดูลนี้ แทนที่จะ `new Date(input)` ตรงๆ
 *
 * แอดมินกรอก "20 ส.ค. 19:00" ซึ่งหมายถึง **19:00 ตามเวลาของก๊วน** (`gangs.timezone`)
 * ไม่ใช่ 19:00 ตามเวลาของเบราว์เซอร์คนกรอก และไม่ใช่ 19:00 UTC
 *
 * ถ้าใช้ `new Date('2026-08-20T19:00')` ค่าที่ได้ขึ้นกับ timezone ของ **เครื่องที่รันโค้ด**
 * ⇒ แอดมินที่บินไปต่างประเทศแล้วสร้างนัด จะได้นัดที่เวลาเพี้ยน
 *   และ server ที่รันบน UTC (Vercel) จะตีความต่างจากเครื่อง dev เสมอ
 *
 * baseline §Verification บังคับ: "Timezone: สร้าง/แสดงนัดข้าม timezone ไม่เพี้ยน + unit test"
 *
 * pure TypeScript — ใช้ `Intl` ที่มีใน runtime อยู่แล้ว ไม่ต้องพึ่งไลบรารีวันที่
 */

/** รูปแบบที่รับ: `YYYY-MM-DDTHH:mm` หรือ `YYYY-MM-DDTHH:mm:ss` (แบบที่ `<input type="datetime-local">` ส่งมา) */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * offset ของ timezone ณ instant หนึ่ง (มิลลิวินาที)
 *
 * คำนวณโดยให้ `Intl` บอกว่า instant นี้ตรงกับเวลาบนนาฬิกาอะไรใน timezone นั้น
 * แล้วเทียบกลับ — วิธีนี้รองรับ DST และประเทศที่เคยเปลี่ยน offset ในอดีตโดยอัตโนมัติ
 */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // `hour12: false` บาง runtime คืน "24" สำหรับเที่ยงคืน
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return asIfUtc - instant.getTime();
}

/**
 * "เวลาบนนาฬิกาของก๊วน" → instant จริง
 *
 * @param wallClock เช่น `'2026-08-20T19:00'`
 * @param timeZone  เช่น `'Asia/Bangkok'`
 *
 * ⚠️ คำนวณสองรอบโดยตั้งใจ: รอบแรกเดา offset จากเวลาที่ยังไม่ถูกต้อง
 *    รอบสองใช้ offset ณ instant ที่เดาได้ ⇒ ถูกต้องแม้เวลานั้นอยู่คร่อมวันเปลี่ยน DST
 *    (ไทยไม่มี DST แต่โค้ดนี้ต้องถูกสำหรับก๊วนที่ตั้ง timezone อื่น)
 */
export function zonedTimeToUtc(wallClock: string, timeZone: string): Date {
  const match = WALL_CLOCK_RE.exec(wallClock.trim());
  if (!match) {
    throw new Error(`รูปแบบเวลาไม่ถูกต้อง: "${wallClock}" (ต้องเป็น YYYY-MM-DDTHH:mm)`);
  }

  const [, y, mo, d, h, mi, s] = match;
  const naiveUtcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
  );

  const firstGuess = new Date(naiveUtcMs - timeZoneOffsetMs(new Date(naiveUtcMs), timeZone));
  const instant = new Date(naiveUtcMs - timeZoneOffsetMs(firstGuess, timeZone));

  // 🔴 เวลาที่ "ไม่มีอยู่จริง" ในวันเปลี่ยน DST
  //
  // วันที่นาฬิกาเดินหน้า (เช่น New York 8 มี.ค. 2026 ข้ามจาก 02:00 ไป 03:00)
  // เวลา 02:30 ไม่มีอยู่บนนาฬิกาเลย — ถ้าปล่อยผ่าน ผลลัพธ์จะถูกเลื่อนกลับเงียบๆ
  // เป็น 01:30 ⇒ แอดมินกรอก 02:30 กดบันทึก แล้วเห็นนัดขึ้นเป็น 01:30 โดยไม่มีคำอธิบาย
  //
  // ⇒ ตรวจด้วยการแปลงกลับ ถ้าไม่ตรงกับที่กรอกแปลว่าเวลานั้นไม่มีจริง แล้วบอกให้ชัด
  //    (ไทยไม่มี DST จึงไม่เจอเคสนี้ แต่ก๊วนที่ตั้ง timezone อื่นเจอได้)
  const roundTrip = utcToZonedWallClock(instant, timeZone);
  const requested = `${y}-${mo}-${d}T${h}:${mi}`;

  if (roundTrip !== requested) {
    throw new Error(
      `เวลา ${requested} ไม่มีอยู่จริงใน ${timeZone} (เป็นช่วงที่นาฬิกาถูกปรับข้าม) — เลือกเวลาอื่น`,
    );
  }

  return instant;
}

/** instant จริง → "เวลาบนนาฬิกาของก๊วน" ในรูปแบบที่ `<input type="datetime-local">` รับได้ */
export function utcToZonedWallClock(instant: Date, timeZone: string): string {
  const offset = timeZoneOffsetMs(instant, timeZone);
  const shifted = new Date(instant.getTime() + offset);

  const pad = (n: number, width = 2) => String(n).padStart(width, '0');

  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/**
 * แสดงเวลาให้ผู้ใช้อ่าน ตาม timezone ของก๊วน
 *
 * 🔴 ทุกที่ที่แสดงเวลาของนัดต้องผ่านตัวนี้ ห้ามใช้ `toLocaleString()` เปล่าๆ
 *    เพราะจะแสดงตาม timezone ของเครื่องผู้ใช้ ⇒ สมาชิกที่อยู่ต่างประเทศจะเห็นเวลาผิด
 */
export function formatInTimeZone(
  instant: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  },
  locale = 'th-TH',
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(instant);
}

/** ตรวจว่า timezone ที่กรอกมามีอยู่จริง — กันค่ามั่วที่จะทำให้ `Intl` โยน error ตอน render */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
