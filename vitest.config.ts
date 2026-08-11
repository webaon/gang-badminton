import { defineConfig } from 'vitest/config';

export default defineConfig({
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
