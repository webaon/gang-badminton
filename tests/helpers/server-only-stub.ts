/**
 * แทนที่แพ็กเกจ `server-only` ตอนรันเทสต์
 *
 * `server-only` ตั้งใจ throw เมื่อถูก import นอก React Server Component
 * ซึ่งรวมถึง vitest ที่รันเป็น Node ธรรมดา — ไม่ใช่บั๊ก แต่ทำให้เทสต์
 * โมดูลใน `server/` กับ `lib/` ไม่ได้เลย จึง alias มาที่ไฟล์ว่างนี้แทน
 * (ดู resolve.alias ใน vitest.config.ts)
 *
 * ⚠️ ไม่ได้ลดการป้องกันของ production — `npm run build` ยังใช้ของจริง
 *    ถ้ามี client component เผลอ import จะพังตอน build เหมือนเดิม
 */
export {};
