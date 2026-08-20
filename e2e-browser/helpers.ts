import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * ตัวช่วยของ smoke — **[WO-5.E]**
 *
 * 🔴 ทุกเทสต์สร้าง **fixture ของตัวเอง** (อีเมล/ชื่อก๊วนสุ่ม) — ห้ามแตะข้อมูลก๊วนจริง
 */

export function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

export type ConsoleWatcher = {
  /** ข้อความ error/warning ที่เบราว์เซอร์บ่นออกมาทั้งหมด */
  messages: string[];
  /** เฉพาะที่เป็น CSP violation */
  cspViolations: string[];
};

/**
 * ดักทุกอย่างที่เบราว์เซอร์บ่น — **นี่คือของที่ WO-5.B ปิดเองไม่ได้**
 *
 * CSP ที่ตั้งผิดจะไม่ทำให้ server error เลย — เห็นได้เฉพาะใน console ของเบราว์เซอร์
 * (`Refused to execute inline script…`) ⇒ ต้องมีเบราว์เซอร์จริงมาอ่านให้
 */
export function watchConsole(page: Page): ConsoleWatcher {
  const watcher: ConsoleWatcher = { messages: [], cspViolations: [] };

  const record = (text: string) => {
    watcher.messages.push(text);
    if (/content security policy|refused to (execute|load|apply|connect)/i.test(text)) {
      watcher.cspViolations.push(text);
    }
  };

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' || message.type() === 'warning') record(message.text());
  });

  page.on('pageerror', (error) => record(`pageerror: ${error.message}`));

  return watcher;
}

/** สมัครสมาชิกผ่านหน้าเว็บจริง (local ปิด email confirmation ไว้แล้ว) */
export async function signUp(page: Page): Promise<{ email: string; displayName: string }> {
  const suffix = uniqueSuffix();
  const email = `e2e-${suffix}@example.com`;
  const displayName = `ผู้ทดสอบ ${suffix}`;

  await page.goto('/sign-up');
  await page.getByLabel('ชื่อที่ใช้แสดง').fill(displayName);
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill('e2e-password-1234');
  await page.getByRole('button', { name: 'สมัครสมาชิก' }).click();

  // สมัครเสร็จแล้วระบบพาไปหน้าโปรไฟล์ (ไม่ใช่ /gangs) — local ปิด email confirmation ไว้
  await page.waitForURL(/\/profile/, { timeout: 20_000 });

  return { email, displayName };
}

/** สร้างก๊วนใหม่จากหน้า `/gangs` แล้วคืน gangId ที่ได้ */
export async function createGang(page: Page): Promise<{ gangId: string; name: string }> {
  const name = `ก๊วนสโมค ${uniqueSuffix()}`;

  await page.goto('/gangs');
  await page.getByLabel('ชื่อก๊วน').fill(name);
  await page.getByRole('button', { name: 'สร้างก๊วน' }).click();

  // สร้างเสร็จแล้วพาไปหน้าใดหน้าหนึ่งของก๊วนนั้น ⇒ ดึง id จาก URL
  await page.waitForURL(/\/gangs\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const gangId = page.url().match(/\/gangs\/([0-9a-f-]{36})/)?.[1];

  if (!gangId) throw new Error(`หา gangId จาก URL ไม่เจอ: ${page.url()}`);

  return { gangId, name };
}
