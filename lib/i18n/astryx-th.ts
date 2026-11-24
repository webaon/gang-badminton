/**
 * ข้อความภาษาไทยของ Astryx — **[WO-6.1a เริ่ม · WO-6.1b ครบทุก key]**
 *
 * Astryx 0.3.0 มีแค่ catalog อังกฤษ (`locales/en.json`) ⇒ "Required" / "Optional" / "Open navigation"
 * จะเป็นอังกฤษในแอป Thai-first — ใช้ `overrides` ของ `InternationalizationProvider` ทับทีละ key
 * ตัวข้อความอยู่ใน `astryx-th-catalog.ts`; `tests/design/astryx-th.test.ts` เทียบกับ en.json ว่าครบ
 */
import { ASTRYX_TH_CATALOG } from './astryx-th-catalog';

export const ASTRYX_TH_LOCALE = 'th';

export const ASTRYX_TH_OVERRIDES: Record<string, string> = ASTRYX_TH_CATALOG;
