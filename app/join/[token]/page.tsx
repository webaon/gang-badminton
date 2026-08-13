import { Card } from '@astryxdesign/core/Card';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { formatInTimeZone } from '@/domain/time/timezone';
import { GuestJoinForm } from '@/features/sessions/GuestJoinForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'ลงชื่อเข้านัด · Gang Badminton' };

/**
 * หน้าลงชื่อของ guest — **เปิดได้โดยไม่ต้องล็อกอิน** ถ้ามีลิงก์เชิญ
 *
 * ⚠️ ใช้ `supabaseAdmin()` เพราะ `session_by_invite_token()` grant ให้ service_role
 *    เท่านั้น (กติกาจาก WO-1.4) — ฟังก์ชันนั้นคืนเฉพาะข้อมูลที่คนถือลิงก์ควรเห็น
 *    ไม่มีรายชื่อผู้เล่น ไม่มี snapshot (ที่มีราคา/PromptPay)
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const { data } = await supabaseAdmin().rpc('session_by_invite_token', { p_token: token });

  const session = (data as Array<{
    session_id: string;
    title: string;
    venue: string | null;
    starts_at: string;
    ends_at: string;
    timezone: string;
    gang_name: string;
    max_players: number;
    occupied_seats: number;
    is_open: boolean;
  }> | null)?.[0];

  if (!session) {
    // ลิงก์ผิด / หมดอายุ / ใช้ครบ — ข้อความเดียวกันหมด ไม่บอกว่าสาเหตุไหน
    return (
      <main className="mx-auto max-w-md p-4">
        <Card padding={6}>
          <h1 className="mb-2 text-xl font-semibold">ลิงก์ใช้ไม่ได้</h1>
          <p className="text-sm">ลิงก์เชิญไม่ถูกต้องหรือหมดอายุแล้ว — ขอลิงก์ใหม่จากคนที่ชวนคุณ</p>
        </Card>
      </main>
    );
  }

  const seatsLeft = session.max_players - session.occupied_seats;

  return (
    <main className="mx-auto max-w-md p-4">
      <Card padding={6}>
        <p className="text-sm">{session.gang_name}</p>
        <h1 className="mb-2 text-xl font-semibold">{session.title}</h1>
        <p className="text-sm">
          {formatInTimeZone(new Date(session.starts_at), session.timezone)} –{' '}
          {formatInTimeZone(new Date(session.ends_at), session.timezone, { timeStyle: 'short' })}
        </p>
        {session.venue ? <p className="text-sm">{session.venue}</p> : null}
        <p className="mt-1 text-sm">
          {seatsLeft > 0 ? `เหลือที่ว่าง ${seatsLeft} คน` : 'เต็มแล้ว — ลงชื่อได้แต่จะอยู่ในคิวรอ'}
        </p>

        {session.is_open ? (
          <div className="mt-4">
            <GuestJoinForm inviteToken={token} />
          </div>
        ) : (
          <p className="mt-4 text-sm">นัดนี้ยังไม่เปิดรับสมัคร หรือปิดรับแล้ว</p>
        )}
      </Card>
    </main>
  );
}
