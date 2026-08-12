import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // เทสต์รันเป็น Node ธรรมดา ⇒ `server-only` จะ throw ถ้าไม่ stub ทิ้ง
      // (build จริงยังใช้ของจริง — ดูคอมเมนต์ในไฟล์ stub)
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    // 🔴 concurrency tests ทุกไฟล์ยิงใส่ DB ตัวเดียวกัน — ถ้ารันไฟล์พร้อมกัน
    //    fixture จะกวนกันเองจนผลลัพธ์อ่านไม่ได้ (และ false positive ได้ด้วย)
    fileParallelism: false,

    // แต่ละเทสต์ต้องรอ lock จริง + ยิงหลาย request พร้อมกัน
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
