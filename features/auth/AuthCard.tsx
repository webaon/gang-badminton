import { Card } from '@astryxdesign/core/Card';
import type { ReactNode } from 'react';

/**
 * กรอบกลางจอสำหรับหน้า auth
 *
 * Astryx ไม่มี component จัดกึ่งกลางหน้าจอ ⇒ ใช้ Tailwind เสริมตาม fallback rule
 * ใน CLAUDE.md §1 ("Tailwind = เก็บรายละเอียด layout ที่ไม่มี prop รองรับ")
 */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card maxWidth={420} padding={6} elevation="low">
        <h1 className="mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </Card>
    </main>
  );
}
