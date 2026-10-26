/**
 * ข้อความภาษาไทยของ Astryx (เฉพาะ key ที่ shell ใช้) — **[WO-6.1a]**
 *
 * Astryx 0.3.0 มีแค่ catalog อังกฤษ (`locales/en.json`) — ข้อความที่ผู้ใช้/screen reader เห็นอย่าง
 * "Open navigation" / "Skip to content" จึงเป็นอังกฤษในแอป Thai-first
 * ใช้ `overrides` (sparse) ของ `InternationalizationProvider` ทับเฉพาะ key เหล่านี้ — key อื่นยัง fallback เป็นอังกฤษ
 *
 * ⚠️ ยังไม่ครบทั้ง catalog (~100 key) — ส่วนที่เหลือเป็นงานต่อใน WO-6.1b (ข้อความกลาง/ข้อความ error ไทย)
 */
export const ASTRYX_TH_LOCALE = 'th';

export const ASTRYX_TH_OVERRIDES: Record<string, string> = {
  '@astryx.appShell.skipToContent': 'ข้ามไปที่เนื้อหา',
  '@astryx.appShell.mobileNavigation': 'เมนูบนมือถือ',
  '@astryx.mobileNav.toggle.open': 'เปิดเมนู',
  '@astryx.mobileNav.closeNavigation': 'ปิดเมนู',
  '@astryx.mobileNav.navigation': 'เมนู',
  '@astryx.sideNav.label': 'เมนูข้าง',
  '@astryx.topNav.landmarkLabel': 'แถบด้านบน',
  '@astryx.tabList.label': 'แท็บ',
  '@astryx.dialog.close': 'ปิด',
};
