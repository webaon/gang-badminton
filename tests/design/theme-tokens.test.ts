/**
 * WO-6.0 DoD ข้อ 2 — theme `badgame` (tokens v4 → Astryx)
 *
 *   · ค่า token หลักใน `theme/badgame.css` (ตัวที่ build แล้ว) ต้องตรงกับ spec v4
 *   · 🔴 ทุกคู่ ข้อความ/พื้น ต้องผ่าน contrast ≥ 4.5:1 ทั้ง light และ dark
 *     (คำนวณสูตร WCAG ในเทสต์นี้ จากค่าที่อ่านจาก CSS จริง — ไม่ใช่ค่าที่ copy มา)
 *   · wiring: layer order ไม่ถูกแตะ · ใช้ตัว built (`__built: true`) · ฟอนต์ self-host ไม่แตะ CSP
 *
 * ค่าอ้างอิง v4 มาจาก `design/hifi/tokens.css` (นอก repo) — เขียนเป็นค่าคงที่ในเทสต์นี้
 * เพื่อให้เทสต์พังทันทีถ้ามีใครแก้ค่าใน theme/src/badgame.ts โดยไม่ตั้งใจ
 *
 * ตั้ง env `CONTRAST_OUT=<path>` เพื่อให้เทสต์เขียนตาราง contrast (markdown) ออกไฟล์ —
 * ใช้ตอนอัปเดต docs/design/tokens-dark.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const css = read('theme/badgame.css');

// ───────────────────────── อ่าน token จาก CSS ─────────────────────────

type Pair = { light: string; dark: string };
const HEX = '#[0-9A-Fa-f]{6}';

/** token สี: คืน [light, dark] — ต้องเป็น `light-dark(#hex, #hex)` เท่านั้น (ถ้าเป็นค่าเดี่ยวถือว่าผิดกติกา) */
function pair(name: string): Pair {
  const re = new RegExp(
    `^\\s*${name}:\\s*light-dark\\(\\s*(${HEX})\\s*,\\s*(${HEX})\\s*\\)\\s*;`,
    'm',
  );
  const m = re.exec(css);
  if (!m) throw new Error(`token ${name} ไม่ใช่คู่ light-dark(#hex, #hex) ใน badgame.css`);
  return { light: m[1].toUpperCase(), dark: m[2].toUpperCase() };
}

function single(name: string): string {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
  if (!m) throw new Error(`ไม่พบ token ${name} ใน badgame.css`);
  return m[1].trim();
}

// ───────────────────────── contrast (WCAG 2.x) ─────────────────────────

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ───────────────────────── คู่ที่ต้องตรวจ ─────────────────────────

const TEXT = '--color-text-primary';
const SECONDARY = '--color-text-secondary';
const ACCENT_TEXT = '--color-text-accent';
const SURFACES = [
  '--color-background-body',
  '--color-background-card',
  '--color-background-surface',
  '--color-background-popover',
  '--color-background-muted',
];

type Check = { fg: string; bg: string; note: string };
const TEXT_CHECKS: Check[] = [
  ...SURFACES.flatMap((bg): Check[] => [
    { fg: TEXT, bg, note: 'ข้อความหลัก' },
    { fg: SECONDARY, bg, note: 'ข้อความรอง (v4 text-muted)' },
    { fg: ACCENT_TEXT, bg, note: 'ลิงก์/ข้อความ accent' },
  ]),
  { fg: '--color-on-accent', bg: '--color-accent', note: 'ตัวหนังสือบนปุ่ม primary' },
  { fg: TEXT, bg: '--color-accent-muted', note: 'ข้อความบนพื้น primary-tint' },
  { fg: '--color-on-success', bg: '--color-success', note: 'บนพื้นสี success' },
  { fg: '--color-on-warning', bg: '--color-warning', note: 'บนพื้นสี warning (orange)' },
  { fg: '--color-on-error', bg: '--color-error', note: 'บนพื้นสี error' },
  // chip / badge / banner สถานะ: ข้อความ *-ink บนพื้นอ่อน และบนการ์ด/พื้นหน้า
  ...(
    [
      ['green', 'success'],
      ['orange', 'warning/waitlist'],
      ['yellow', 'warning (alias ของ orange)'],
      ['red', 'error'],
      ['blue', 'info'],
      ['gray', 'neutral'],
    ] as const
  ).flatMap(([hue, label]): Check[] => [
    { fg: `--color-text-${hue}`, bg: `--color-background-${hue}`, note: `chip ${label}` },
    { fg: `--color-text-${hue}`, bg: '--color-background-card', note: `ข้อความ ${label} บนการ์ด` },
  ]),
  { fg: '--color-text-red', bg: '--color-error-muted', note: 'ปุ่ม destructive' },
];

/** องค์ประกอบที่ไม่ใช่ข้อความ (ไอคอน) — WCAG 1.4.11 ต้อง ≥ 3:1 บนการ์ด */
const ICON_CHECKS: Check[] = [
  { fg: '--color-icon-primary', bg: '--color-background-card', note: 'ไอคอนหลัก' },
  { fg: '--color-icon-secondary', bg: '--color-background-card', note: 'ไอคอนรอง' },
  { fg: '--color-icon-accent', bg: '--color-background-card', note: 'ไอคอน accent' },
  { fg: '--color-icon-green', bg: '--color-background-card', note: 'ไอคอน success' },
  { fg: '--color-icon-orange', bg: '--color-background-card', note: 'ไอคอน waitlist' },
  { fg: '--color-icon-red', bg: '--color-background-card', note: 'ไอคอน error' },
  { fg: '--color-icon-blue', bg: '--color-background-card', note: 'ไอคอน info' },
];

// ───────────────────────── เทสต์ ─────────────────────────

describe('badgame.css — ค่า token หลักตรง spec v4 (light)', () => {
  const v4Light: Record<string, string> = {
    '--color-accent': '#0169CC', // primary
    '--color-text-primary': '#0D0D0D', // text
    '--color-text-secondary': '#6B6B6B', // text-muted
    '--color-background-body': '#FCFCFC', // surface
    '--color-background-card': '#FFFFFF', // card
    '--color-background-muted': '#F0F0F0', // fill-1
    '--color-border': '#E3E3E3', // divider
    '--color-border-emphasized': '#DCDCDC', // border-input
    '--color-success': '#14935F',
    '--color-warning': '#E8850A', // accent-500 (orange)
    '--color-error': '#D93A3F',
    '--color-text-green': '#0D6B45', // success-ink
    '--color-text-red': '#A82A2E', // danger-ink
    '--color-text-orange': '#9C5404', // accent-700
    '--color-text-blue': '#0154A3', // primary-strong
    '--color-text-gray': '#3D3D3D', // text-label
  };
  for (const [name, expected] of Object.entries(v4Light)) {
    it(`${name} (light) = ${expected}`, () => {
      expect(pair(name).light).toBe(expected);
    });
  }

  it('radius: ปุ่ม pill · card 16px · input 6px', () => {
    expect(css).toMatch(/\.astryx-button \{[^}]*border-radius: 9999px;/);
    expect(css).toMatch(/\.astryx-card[^{]*\{[^}]*border-radius: 16px;/);
    expect(css).toMatch(/\.astryx-text-input[^{]*\{[^}]*border-radius: 6px;/);
  });

  it('เงาเป็นเส้นขอบ (stroke) — ไม่มี drop shadow ในระดับ low/med', () => {
    expect(single('--shadow-low')).toMatch(/^0 0 0 1px /);
    expect(single('--shadow-med')).toMatch(/^0 0 0 1px /);
    expect(single('--shadow-low')).not.toMatch(/\d+px \d+px \d+px/);
  });

  it('[WO-6.1a] tap target ≥ 44px: --size-element-md = 44px (v4 --size-touch-min) · lg = 52px · sm = 32px', () => {
    expect(single('--size-element-sm')).toBe('32px');
    expect(single('--size-element-md')).toBe('44px');
    expect(single('--size-element-lg')).toBe('52px');
  });

  it('font stack = Segoe UI → Noto Sans Thai (next/font) → system-ui', () => {
    for (const t of ['--font-family-body', '--font-family-heading']) {
      expect(single(t)).toBe("'Segoe UI', var(--font-noto-thai), system-ui, sans-serif");
    }
    expect(css).not.toMatch(/Figtree/);
  });
});

describe('dark tokens — ชุดตั้งต้นตาม plan §6', () => {
  const expectedDark: Record<string, string> = {
    '--color-background-body': '#061525', // navy-950
    '--color-background-card': '#0A1E33', // navy-900
    '--color-background-surface': '#0F2944', // navy-800
    '--color-border': '#173554', // navy-700
    '--color-text-primary': '#F2F5F9',
    '--color-text-secondary': '#AFC0D6',
    '--color-accent': '#3B8AD6', // primary-400
    '--color-warning': '#F99A2E', // accent-400
  };
  for (const [name, expected] of Object.entries(expectedDark)) {
    it(`${name} (dark) = ${expected}`, () => {
      expect(pair(name).dark).toBe(expected);
    });
  }
});

describe('contrast ≥ 4.5:1 — ข้อความ/พื้น (คำนวณจาก badgame.css)', () => {
  for (const mode of ['light', 'dark'] as const) {
    describe(mode, () => {
      for (const c of TEXT_CHECKS) {
        it(`${c.fg} บน ${c.bg} (${c.note})`, () => {
          const ratio = contrast(pair(c.fg)[mode], pair(c.bg)[mode]);
          expect(ratio, `${c.fg} ${pair(c.fg)[mode]} บน ${c.bg} ${pair(c.bg)[mode]}`).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});

describe('contrast ≥ 3:1 — ไอคอน (non-text)', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const c of ICON_CHECKS) {
      it(`${mode}: ${c.fg} บน ${c.bg} (${c.note})`, () => {
        expect(contrast(pair(c.fg)[mode], pair(c.bg)[mode])).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe('wiring — กติกา CLAUDE.md §1.1 / §1.3', () => {
  const globals = read('app/globals.css');
  const imports = [...globals.matchAll(/@import\s+"([^"]+)"([^;]*);/g)].map((m) => [m[1], m[2].trim()]);

  it('ลำดับ @import ใน globals.css ไม่เปลี่ยน และ badgame.css ไม่ถูกห่อ layer() (มี @layer ในตัว)', () => {
    expect(imports).toEqual([
      ['./layers.css', ''],
      ['tailwindcss/theme.css', 'layer(theme)'],
      ['tailwindcss/preflight.css', 'layer(base)'],
      ['@astryxdesign/core/reset.css', ''],
      ['@astryxdesign/core/astryx.css', ''],
      ['../theme/badgame.css', ''],
      ['@astryxdesign/core/tailwind-theme.css', ''],
      ['tailwindcss/utilities.css', 'layer(utilities)'],
    ]);
  });

  it('layers.css ยังเป็นลำดับเดิม', () => {
    expect(read('app/layers.css')).toContain(
      '@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;',
    );
  });

  it('badgame.css ใช้เฉพาะ layer ที่ประกาศไว้ใน layers.css และไม่มี @import / @font-face / fonts.googleapis', () => {
    const declared = ['reset', 'theme', 'base', 'astryx-base', 'astryx-theme', 'components', 'utilities'];
    const used = new Set([...css.matchAll(/^@layer\s+([\w-]+)\s*\{/gm)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const l of used) expect(declared, `layer ${l}`).toContain(l);
    expect(css).not.toMatch(/@import|@font-face|googleapis|gstatic/);
  });

  it('badgame.css ไม่ override --color-* ที่ :root', () => {
    const roots = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]);
    for (const body of roots) expect(body).not.toMatch(/--color-/);
  });

  it('providers.tsx ใช้ theme ที่ build แล้ว (__built: true) + mode="system" · ไม่ import source', () => {
    const providers = read('app/providers.tsx');
    const importLines = providers.split(/\r?\n/).filter((l) => /^import /.test(l)).join('\n');
    expect(importLines).toMatch(/from '@\/theme\/badgame(\.js)?'/);
    expect(importLines).not.toMatch(/theme\/src/);
    expect(providers).toMatch(/mode="system"/);
    expect(providers).not.toMatch(/mode="light"/);
    expect(read('theme/badgame.js')).toMatch(/__built:\s*true/);
  });

  it('ไม่มี defineTheme() runtime ในโค้ดแอป (เหลือเฉพาะ theme/src)', () => {
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['app/providers.tsx', 'app/layout.tsx', 'lib/font.ts']) {
      expect(stripComments(read(f)), f).not.toMatch(/defineTheme/);
    }
  });

  it('ฟอนต์: next/font/google (self-host) · ไม่มี @next/font · ไม่โหลดจาก googleapis', () => {
    const font = read('lib/font.ts');
    expect(font).toMatch(/from 'next\/font\/google'/);
    expect(font).toMatch(/variable:\s*'--font-noto-thai'/);
    expect(read('app/layout.tsx')).toMatch(/notoSansThai\.variable/);
    expect(read('app/layout.tsx')).toMatch(/tabular-nums/);
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).not.toHaveProperty('@next/font');
    for (const f of ['app/globals.css', 'app/layout.tsx', 'lib/font.ts', 'lib/security/csp.ts']) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    }
  });

  it('ชื่อแอปยังเป็น "Gang Badminton" (คำตัดสิน C2)', () => {
    expect(read('app/layout.tsx')).toMatch(/title:\s*'Gang Badminton'/);
  });

  it('[WO-6.1a] <html> มี data-astryx-theme ตั้งแต่ SSR (กัน theme แฟลชก่อน hydrate) และใช้ชื่อจาก theme ที่ build แล้ว', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toMatch(/data-astryx-theme=\{badgameTheme\.name\}/);
    expect(layout).toMatch(/from '@\/theme\/badgame(\.js)?'/);
    // ชื่อ attribute ต้องตรงกับที่ <Theme> ของ Astryx ตั้งเอง (ตรวจจากซอร์สของ lib จริง)
    const astryxTheme = readFileSync(
      fileURLToPath(new URL('../../node_modules/@astryxdesign/core/src/theme/Theme.tsx', import.meta.url)),
      'utf8',
    );
    expect(astryxTheme).toMatch(/dataAttr\('theme'\), themeName/);
    expect(read('theme/badgame.js')).toMatch(/name:\s*'badgame'/);
  });
});

describe('ตารางสำหรับ docs/design/tokens-dark.md', () => {
  it.skipIf(!process.env.CONTRAST_OUT)('เขียนตาราง contrast ออกไฟล์ $CONTRAST_OUT', () => {
    const row = (c: Check) => {
      const f = pair(c.fg);
      const b = pair(c.bg);
      const fmt = (x: number) => x.toFixed(2);
      return `| \`${c.fg}\` | \`${c.bg}\` | ${c.note} | ${f.light} / ${b.light} | ${fmt(contrast(f.light, b.light))} | ${f.dark} / ${b.dark} | ${fmt(contrast(f.dark, b.dark))} |`;
    };
    const head =
      '| ตัวหนังสือ/ไอคอน | พื้น | ใช้กับ | light (fg / bg) | อัตราส่วน | dark (fg / bg) | อัตราส่วน |\n|---|---|---|---|---|---|---|';
    const out = [
      '### ข้อความ (เกณฑ์ ≥ 4.5:1)',
      '',
      head,
      ...TEXT_CHECKS.map(row),
      '',
      '### ไอคอน (เกณฑ์ ≥ 3:1)',
      '',
      head,
      ...ICON_CHECKS.map(row),
      '',
    ].join('\n');
    writeFileSync(process.env.CONTRAST_OUT as string, out);
  });
});

// ───────────────────────── คู่ที่ "ไม่ผ่าน" โดยตั้งใจ — ล็อกค่าจริงเป็นกติกา ─────────────────────────

/**
 * คู่สีที่รู้ว่าไม่ผ่าน 4.5:1 — เทสต์ล็อก **ค่าที่วัดได้จริง** + ระดับที่ผ่าน เพื่อให้ตัวเลขใน
 * docs/design/tokens-dark.md มาจากเทสต์ และกันไม่ให้ใครเอาคู่เหล่านี้ไปเป็นตัวหนังสือ
 *   level: 'none' = ต่ำกว่า 3:1 (ใช้เป็นข้อความ/ขอบ UI ไม่ได้เลย) · 'large-ui' = ผ่าน 3:1 (ข้อความใหญ่ ≥ 18.66px bold / UI เท่านั้น)
 * `token` = token ใน theme ที่ให้ค่านั้น (อ่านจาก CSS จริง ⇒ ถ้าแก้ค่า theme เทสต์นี้พังและต้องทบทวน)
 */
const KNOWN_FAILS: {
  mode: 'light' | 'dark';
  fg: string | { token: string };
  bg: string | { token: string };
  note: string;
  ratio: number;
  level: 'none' | 'large-ui';
}[] = [
  { mode: 'light', fg: { token: '--color-warning' }, bg: { token: '--color-background-card' }, note: 'orange (warning) เป็นตัวหนังสือบนการ์ดขาว', ratio: 2.696, level: 'none' },
  { mode: 'light', fg: '#FFFFFF', bg: { token: '--color-warning' }, note: 'ตัวหนังสือขาวบนปุ่ม orange (#30 ปุ่มจ่ายเงิน)', ratio: 2.696, level: 'none' },
  { mode: 'dark', fg: { token: '--color-accent' }, bg: { token: '--color-background-surface' }, note: 'primary-400 เป็นตัวหนังสือบนพื้นยก navy-800', ratio: 4.076, level: 'large-ui' },
  { mode: 'dark', fg: '#FFFFFF', bg: { token: '--color-accent' }, note: 'ตัวหนังสือขาวบนปุ่ม primary-400', ratio: 3.625, level: 'large-ui' },
  { mode: 'dark', fg: '#FFFFFF', bg: { token: '--color-warning' }, note: 'ตัวหนังสือขาวบนปุ่ม orange (accent-400)', ratio: 2.167, level: 'none' },
];

const resolve = (v: string | { token: string }, mode: 'light' | 'dark') =>
  typeof v === 'string' ? v : pair(v.token)[mode];

describe('คู่ที่ไม่ผ่านโดยตั้งใจ (ห้ามใช้เป็นข้อความ)', () => {
  for (const k of KNOWN_FAILS) {
    it(`${k.mode}: ${k.note}`, () => {
      const r = contrast(resolve(k.fg, k.mode), resolve(k.bg, k.mode));
      expect(r).toBeCloseTo(k.ratio, 2);
      expect(r).toBeLessThan(4.5);
      if (k.level === 'large-ui') expect(r).toBeGreaterThanOrEqual(3);
      else expect(r).toBeLessThan(3);
    });
  }
});

// ───────────────────────── primary โหมดมืด (planner ตัดสิน: ใช้แบบผสม) ─────────────────────────

/**
 * (ก) พื้นปุ่ม + ลิงก์ = primary-400 #3B8AD6 · ตัวหนังสือบนปุ่ม = navy-950
 * (ข) พื้นปุ่ม + ลิงก์ = primary-300 #80B2E3 · ตัวหนังสือบนปุ่ม = navy-950
 * ✅ ตัดสินแล้ว — theme ใช้แบบผสม: พื้นปุ่ม = (ก) · ลิงก์ (`--color-text-accent`) = (ข) — ดู docs/design/tokens-dark.md §4
 * ตัวเลขด้านล่างคือค่าที่ใช้ตัดสิน (ตัวหนังสือขาวบนปุ่มไม่อยู่ในทางเลือก — ไม่ผ่านทั้งคู่)
 */
const P400 = '#3B8AD6';
const P300 = '#80B2E3';
const NAVY950 = '#061525';
const DARK_SURFACES: Record<string, string> = { body: '#061525', card: '#0A1E33', 'surface (navy-800)': '#0F2944' };

describe('ทางเลือก primary โหมดมืด — ตัวเลขสำหรับตัดสิน', () => {
  it('ค่าสีพื้นฐานตรงกับ theme (dark)', () => {
    expect(pair('--color-background-body').dark).toBe(DARK_SURFACES.body);
    expect(pair('--color-background-card').dark).toBe(DARK_SURFACES.card);
    expect(pair('--color-background-surface').dark).toBe(DARK_SURFACES['surface (navy-800)']);
    expect(pair('--color-accent').dark).toBe(P400);
    expect(pair('--color-text-accent').dark).toBe(P300);
    expect(pair('--color-on-accent').dark).toBe(NAVY950);
  });

  it('(ก) primary-400: ปุ่ม navy-950 = 5.07 ผ่าน · ลิงก์ body 5.07 / card 4.65 ผ่าน · ลิงก์บน navy-800 = 4.08 ไม่ผ่าน', () => {
    expect(contrast(NAVY950, P400)).toBeCloseTo(5.07, 2);
    expect(contrast(P400, DARK_SURFACES.body)).toBeCloseTo(5.07, 2);
    expect(contrast(P400, DARK_SURFACES.card)).toBeCloseTo(4.65, 2);
    expect(contrast(P400, DARK_SURFACES['surface (navy-800)'])).toBeCloseTo(4.08, 2);
    expect(contrast(P400, DARK_SURFACES['surface (navy-800)'])).toBeLessThan(4.5);
  });

  it('(ข) primary-300: ปุ่ม navy-950 = 8.23 · ลิงก์ body 8.23 / card 7.54 / navy-800 6.61 ผ่านทุกพื้น', () => {
    expect(contrast(NAVY950, P300)).toBeCloseTo(8.23, 2);
    expect(contrast(P300, DARK_SURFACES.body)).toBeCloseTo(8.23, 2);
    expect(contrast(P300, DARK_SURFACES.card)).toBeCloseTo(7.54, 2);
    expect(contrast(P300, DARK_SURFACES['surface (navy-800)'])).toBeCloseTo(6.61, 2);
  });

  it('ตัวหนังสือขาวบนปุ่ม primary dark ไม่ผ่านทั้งสองเฉด (400 = 3.63 · 300 = 2.24)', () => {
    expect(contrast('#FFFFFF', P400)).toBeCloseTo(3.63, 2);
    expect(contrast('#FFFFFF', P300)).toBeCloseTo(2.24, 2);
  });
});
