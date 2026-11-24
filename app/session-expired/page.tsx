import { StatePanel } from '@/components/ui/StatePanel';
import { safeNext } from '@/lib/url/safe-next';

export const metadata = { title: 'เซสชันหมดอายุ · Gang Badminton' };

/**
 * เซสชันหมดอายุ — hi-fi K g2 · **[WO-6.1b]**
 *
 * ปลายทางเมื่อ server action ตอบ `UNAUTHENTICATED` กลางคัน (ดู `useActionErrorText`)
 * พาไป `/sign-in?next=<หน้าเดิม>` — 🔴 `next` ผ่าน `safeNext()` เสมอ (open redirect: มาจาก query string)
 *
 * dynamic (อ่าน searchParams) ⇒ ไม่ต้องอยู่ใน `STATIC_ROUTES`
 */
export default async function SessionExpiredPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  return (
    <StatePanel
      tone="warning"
      title="เซสชันหมดอายุ"
      description="เพื่อความปลอดภัย กรุณาเข้าสู่ระบบอีกครั้ง แล้วจะพากลับมาหน้าเดิม"
      actions={[
        { label: 'เข้าสู่ระบบ', href: `/sign-in?next=${encodeURIComponent(target)}` },
        { label: 'กลับหน้าแรก', href: '/', variant: 'ghost' },
      ]}
    />
  );
}
