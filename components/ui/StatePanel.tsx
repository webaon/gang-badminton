import type { ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon, type IconName } from '@astryxdesign/core/Icon';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * หน้า/การ์ดสถานะกลาง — hi-fi K (g1–g4): ไอคอน + หัวข้อ + คำอธิบาย + ปุ่มทางไปต่อ — **[WO-6.1b]**
 *
 * ใช้กับ 404, error boundary, ลิงก์เชิญ/guest หมดอายุ, session หมดอายุ
 *   · `tone` เลือกสี/ไอคอนตามน้ำหนักของเหตุการณ์ (ไม่ใช่ทุกอย่างคือ "error" สีแดง)
 *   · ทางไปต่อต้องมีเสมอ (Astryx: "Always include a next step") — `actions` บังคับอย่างน้อยหนึ่งอัน
 *   · ลิงก์ใช้ `href` ของ Button (Link provider ใน `app/providers.tsx`) ⇒ ไม่ส่ง `as={NextLink}` ข้ามขอบ server/client
 */
export type StateTone = 'neutral' | 'warning' | 'error';

export type StateAction = {
  label: string;
  /** นำทางด้วยลิงก์ (a11y ถูกกว่าปุ่ม onClick สำหรับการเปลี่ยนหน้า) */
  href?: string;
  /** ⚠️ function ส่งจาก server component เข้ามาไม่ได้ — ใช้ `onClick` เฉพาะเมื่อผู้เรียกเป็น client (เช่น error.tsx) · จาก server ให้ใช้ `href` */
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
};

const TONE_ICON: Record<
  StateTone,
  { icon: IconName; color: 'secondary' | 'warning' | 'error'; circle: string }
> = {
  // วงกลมสีอ่อนตาม tone = hi-fi `Hero` (64px) — สีมาจาก token (`bg-*-muted`) ไม่ใช่ hex
  neutral: { icon: 'info', color: 'secondary', circle: 'bg-muted' },
  warning: { icon: 'clock', color: 'warning', circle: 'bg-warning-muted' },
  error: { icon: 'warning', color: 'error', circle: 'bg-error-muted' },
};

export function StatePanel({
  tone = 'neutral',
  title,
  description,
  actions,
  children,
  fullPage = true,
  headingLevel = 1,
}: {
  tone?: StateTone;
  title: string;
  description?: string;
  actions: readonly [StateAction, ...StateAction[]];
  /** เนื้อหาเสริมใต้คำอธิบาย เช่น รหัสอ้างอิง */
  children?: ReactNode;
  /** `true` = เต็มจอกึ่งกลาง (404/global) · `false` = อยู่ในโครง shell ที่มี header เดิมอยู่แล้ว */
  fullPage?: boolean;
  headingLevel?: 1 | 2 | 3;
}) {
  const { icon, color, circle } = TONE_ICON[tone];

  const body = (
    <EmptyState
      headingLevel={headingLevel}
      icon={
        <VStack className={`size-16 items-center justify-center rounded-full ${circle} [&_svg]:size-8`}>
          <Icon icon={icon} color={color} size="lg" />
        </VStack>
      }
      title={title}
      description={description}
      actions={
        <>
          {actions.map((a, i) => (
            <Button
              key={a.label}
              label={a.label}
              href={a.href}
              onClick={a.onClick}
              variant={a.variant ?? (i === 0 ? 'primary' : 'secondary')}
              size="lg"
            />
          ))}
        </>
      }
    />
  );

  return fullPage ? (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-4 text-center">
      {body}
      {children}
    </main>
  ) : (
    <section className="mx-auto flex max-w-md flex-col items-center justify-center gap-4 py-10 text-center">
      {body}
      {children}
    </section>
  );
}
