/**
 * BadGame theme — tokens v4 → Astryx (WO-6.0)
 *
 * 🔴 ไฟล์นี้คือ SOURCE ของ `defineTheme()` เท่านั้น — ห้าม import จากโค้ดแอป
 *    (import แล้วจะ inject style ตอน runtime หลัง hydration · CLAUDE.md §1.3)
 *    แอปใช้ตัว built: `theme/badgame.{css,js,d.ts}` ที่ได้จาก `npm run theme:build`
 *
 * ที่มาของค่า:
 *   light  = Design tokens v4 (design/hifi/tokens.css) — ไม่ปรับค่า
 *   dark   = ชุดที่ออกแบบเพิ่มเอง (v4 ไม่มี) ตาม docs/phase6-redesign-plan.md §6
 *            รายละเอียด + ตาราง contrast ที่วัดจริง → docs/design/tokens-dark.md
 *   ทุกคู่ข้อความ/พื้นถูกเทสต์ ≥ 4.5:1 ใน tests/design/theme-tokens.test.ts
 *
 * ทุก token สีเป็นคู่ [light, dark] — ห้ามเขียนค่าเดี่ยว (จะไม่ตาม OS)
 */
import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

/**
 * font stack ตาม plan §6: Segoe UI → Noto Sans Thai (self-host ผ่าน next/font) → system-ui
 * `--font-noto-thai` ถูกประกาศโดย `next/font/google` บน <html> (ดู lib/font.ts · app/layout.tsx)
 */
const FONT_STACK = "'Segoe UI', var(--font-noto-thai), system-ui, sans-serif";

export const badgameTheme = defineTheme({
  name: 'badgame',
  extends: neutralTheme,

  tokens: {
    // ── Font ──────────────────────────────────────────────────────────────
    '--font-family-body': FONT_STACK,
    '--font-family-heading': FONT_STACK,

    // ── Brand ─────────────────────────────────────────────────────────────
    // light = primary #0169CC · dark = primary-400 #3B8AD6 (ผ่าน contrast บนพื้นมืด)
    '--color-accent': ['#0169CC', '#3B8AD6'],
    '--color-accent-muted': ['#EAF2FB', '#0F2F52'], // primary-tint
    '--color-on-accent': ['#FFFFFF', '#061525'], // dark: ตัวหนังสือสีเข้มบนปุ่ม primary-400
    // ข้อความ/ไอคอนสี accent (ลิงก์) — dark ใช้ primary-300 เพื่อให้ผ่านแม้บนพื้นยก navy-800
    '--color-text-accent': ['#0169CC', '#80B2E3'],
    '--color-icon-accent': ['#0169CC', '#80B2E3'],

    // ── Surface ───────────────────────────────────────────────────────────
    // body = พื้นหน้า (v4 surface / navy-950) · card (v4 card / navy-900)
    // surface/popover/muted = พื้นยก (v4 card·fill-1 / navy-800)
    '--color-background-body': ['#FCFCFC', '#061525'],
    '--color-background-card': ['#FFFFFF', '#0A1E33'],
    '--color-background-surface': ['#FFFFFF', '#0F2944'],
    '--color-background-popover': ['#FFFFFF', '#0F2944'],
    '--color-background-muted': ['#F0F0F0', '#0F2944'], // v4 fill-1

    // ── Text ──────────────────────────────────────────────────────────────
    // v4: text #0D0D0D · ข้อความรอง = text-muted #6B6B6B (ห้ามใช้ icon-muted)
    '--color-text-primary': ['#0D0D0D', '#F2F5F9'],
    '--color-text-secondary': ['#6B6B6B', '#AFC0D6'],
    '--color-text-disabled': ['#8F8F8F', '#5F7690'], // disabled ไม่ต้องผ่าน 4.5

    // ── Icon ──────────────────────────────────────────────────────────────
    '--color-icon-primary': ['#0D0D0D', '#F2F5F9'],
    '--color-icon-secondary': ['#6B6B6B', '#AFC0D6'],
    '--color-icon-disabled': ['#8F8F8F', '#5F7690'],

    // ── Border ────────────────────────────────────────────────────────────
    // light: divider #E3E3E3 / border-input #DCDCDC · dark: navy-700 / เส้นเน้นอ่อนขึ้นอีกขั้น
    '--color-border': ['#E3E3E3', '#173554'],
    '--color-border-emphasized': ['#DCDCDC', '#2A4A6B'],
    '--color-skeleton': ['#E3E3E3', '#173554'],

    // ── Status — ค่าเต็มตาม spec v4 (ใช้เป็นพื้น/จุดสี) ──────────────────────
    // success #14935F · warning = orange accent-500 #E8850A · error #D93A3F
    // dark = เฉด 400 (สว่างขึ้นให้ผ่านบนพื้นมืด)
    // ⚠️ ข้อความสีสถานะบนพื้นอ่อน ใช้ --color-text-{green,orange,red} (v4 *-ink) ไม่ใช่ token นี้
    '--color-success': ['#14935F', '#3FBF86'],
    '--color-warning': ['#E8850A', '#F99A2E'],
    '--color-error': ['#D93A3F', '#F0686C'],
    '--color-on-success': ['#0D0D0D', '#061525'],
    '--color-on-warning': ['#0D0D0D', '#061525'],
    '--color-on-error': ['#FFFFFF', '#061525'],
    // พื้นอ่อนของสถานะ (v4 success-soft / accent-50 / danger-soft)
    '--color-success-muted': ['#E7F5EE', '#0B3A2B'],
    '--color-warning-muted': ['#FFF6EB', '#3A2410'],
    '--color-error-muted': ['#FCECEC', '#3D1A1E'],

    // ── Categorical ที่ v4 ใช้จริง: green / orange(=waiting) / red / blue / gray ─
    '--color-background-green': ['#E7F5EE', '#0B3A2B'],
    '--color-border-green': ['#B6E0CB', '#1F7A57'],
    '--color-icon-green': ['#14935F', '#3FBF86'],
    '--color-text-green': ['#0D6B45', '#7FE0B0'], // v4 success-ink

    '--color-background-orange': ['#FFF6EB', '#3A2410'],
    '--color-border-orange': ['#FED4A3', '#C46C05'],
    '--color-icon-orange': ['#C46C05', '#F99A2E'],
    '--color-text-orange': ['#9C5404', '#FDB668'], // v4 accent-700 / accent-300

    // v4 ไม่มีสีเหลือง — สถานะ "รอ" เป็นส้มอย่างเดียว ⇒ yellow ชี้ไปค่าเดียวกับ orange
    // (banner/badge สถานะ warning ของ Astryx อ้าง *-yellow)
    '--color-background-yellow': ['#FFF6EB', '#3A2410'],
    '--color-border-yellow': ['#FED4A3', '#C46C05'],
    '--color-icon-yellow': ['#C46C05', '#F99A2E'],
    '--color-text-yellow': ['#9C5404', '#FDB668'],

    '--color-background-red': ['#FCECEC', '#3D1A1E'],
    '--color-border-red': ['#F2BCBE', '#B04348'],
    '--color-icon-red': ['#D93A3F', '#F0686C'],
    '--color-text-red': ['#A82A2E', '#FFA3A6'], // v4 danger-ink

    '--color-background-blue': ['#EAF2FB', '#0F2F52'],
    '--color-border-blue': ['#B9D5F2', '#2F6FB0'],
    '--color-icon-blue': ['#0169CC', '#3B8AD6'],
    '--color-text-blue': ['#0154A3', '#B9D5F2'], // v4 primary-strong / primary-200

    '--color-background-gray': ['#F0F0F0', '#173554'],
    '--color-border-gray': ['#DCDCDC', '#2A4A6B'],
    '--color-icon-gray': ['#6B6B6B', '#AFC0D6'],
    '--color-text-gray': ['#3D3D3D', '#C9D5E4'], // v4 text-label

    // ── Elevation — เงาเป็นเส้นขอบ (v4 shadow-stroke / control / raised) ───────
    '--shadow-low': '0 0 0 1px light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.08))',
    '--shadow-med': '0 0 0 1px light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.12))',
    '--shadow-high':
      '0 0 0 1px light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.12)), ' +
      '0 4px 16px light-dark(rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.5))',
  },

  components: {
    // radius: ปุ่ม pill · card 16 · input 6 (v4 --radius-pill / --radius-card / --radius-input)
    button: {
      base: {borderRadius: '9999px'},
      // v4 .btn-danger = danger-ink บน danger-soft (ไม่ใช่ error เต็มสี — contrast ไม่ผ่าน)
      'variant:destructive': {
        backgroundColor: 'var(--color-error-muted)',
        color: 'var(--color-text-red)',
      },
    },
    card: {
      base: {borderRadius: '16px', padding: 'var(--spacing-5)'}, // v4 --card-padding = space-5
    },
    'text-input': {
      base: {borderRadius: '6px'},
    },

    // Badge = chip ของ v4: พื้นอ่อน + ข้อความ *-ink (ไม่ใช้พื้นเต็มสีแบบ neutral theme)
    badge: {
      'variant:info': {
        backgroundColor: 'var(--color-background-blue)',
        color: 'var(--color-text-blue)',
      },
      'variant:neutral': {
        backgroundColor: 'var(--color-background-gray)',
        color: 'var(--color-text-gray)',
      },
      'variant:success': {
        backgroundColor: 'var(--color-background-green)',
        color: 'var(--color-text-green)',
      },
      'variant:warning': {
        backgroundColor: 'var(--color-background-orange)',
        color: 'var(--color-text-orange)',
      },
      'variant:error': {
        backgroundColor: 'var(--color-background-red)',
        color: 'var(--color-text-red)',
      },
    },

    // จุดสถานะใช้ค่าเต็มของ token สถานะ
    statusdot: {
      'variant:success': {backgroundColor: 'var(--color-success)'},
      'variant:warning': {backgroundColor: 'var(--color-warning)'},
      'variant:error': {backgroundColor: 'var(--color-error)'},
      'variant:accent': {backgroundColor: 'var(--color-accent)'},
    },
  },
});
