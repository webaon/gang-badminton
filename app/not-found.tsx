import { StatePanel } from '@/components/ui/StatePanel';

/**
 * 404 — hi-fi K g4 · **[WO-6.1b]**
 *
 * ไม่ดึงข้อมูลใดๆ ⇒ prerender เป็น static ได้ (`/_not-found` อยู่ใน `STATIC_ROUTES` แล้ว)
 * ข้อความเดียวกันทั้ง "ไม่มีหน้านี้" และ "ไม่ใช่สมาชิกก๊วน" (RLS ซ่อนก๊วนที่ไม่ใช่ของเรา = 404 โดยตั้งใจ)
 * จึงไม่บอกว่าเป็นกรณีไหน — กันการเดาว่าก๊วน/นัดนั้นมีอยู่จริง
 */
export const metadata = { title: 'ไม่พบหน้านี้ · Gang Badminton' };

export default function NotFound() {
  return (
    <StatePanel
      title="ไม่พบหน้านี้"
      description="ลิงก์อาจผิด หรือหน้านี้ถูกย้ายหรือลบไปแล้ว"
      actions={[
        { label: 'ไปก๊วนของฉัน', href: '/gangs' },
        { label: 'กลับหน้าแรก', href: '/', variant: 'secondary' },
      ]}
    />
  );
}
