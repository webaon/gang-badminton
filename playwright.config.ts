import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke — **[WO-5.E]**
 *
 * 🔴 รันบน **production build** (`next start`) ไม่ใช่ `next dev`
 *    เพราะสิ่งที่ต้องพิสูจน์คือของจริง: CSP แบบ nonce + `strict-dynamic` ของ WO-5.B
 *    (dev มี `unsafe-eval` และ HMR ⇒ ทดสอบแล้วไม่ได้ความจริง)
 *
 * ⚠️ ต้องมี Supabase local ขึ้นอยู่ก่อน (`npm run supabase -- start …`) — smoke เดินผ่าน
 *    ฐานข้อมูลจริงเหมือนเทสต์ชุดอื่น · ❌ ไม่ต้องมี secret ของบริการภายนอกใดๆ (ไม่แตะ LINE)
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export default defineConfig({
  testDir: './e2e-browser',
  // ❌ ห้าม parallel — smoke สร้าง fixture ในฐานข้อมูลเดียวกันกับเทสต์ชุดอื่น
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // ⚠️ ไม่เก็บวิดีโอ/screenshot ลง repo (DoD ของ WO-5.E) — เก็บเฉพาะตอนล้มไว้ดูใน CI artifact
  outputDir: '.playwright/results',
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'off',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      // smoke ไม่แตะ LINE — ใส่ค่าหลอกไว้เพื่อให้ fail-closed ไม่ไปโผล่เป็น 500 ที่หน้าอื่น
      LINE_LINK_SECRET: 'e2e-not-a-real-secret',
    },
  },
});
