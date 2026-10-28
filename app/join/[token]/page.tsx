import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { StatePanel } from '@/components/ui/StatePanel';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { currentUser } from '@/lib/supabase/server';
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
    // ลิงก์ผิด / หมดอายุ / ใช้ครบ — ข้อความเดียวกันหมด ไม่บอกว่าสาเหตุไหน (กัน oracle ว่า token มีจริง)
    // [WO-6.1b] hi-fi K g3
    return (
      <StatePanel
        tone="error"
        title="ลิงก์นี้ใช้ไม่ได้แล้ว"
        description="ลิงก์ไม่ถูกต้อง หมดอายุ หรือถูกใช้ครบจำนวนแล้ว — ขอลิงก์ใหม่จากคนที่ชวนคุณมา"
        actions={[{ label: 'หาก๊วนอื่นแถวนี้', href: '/discover', variant: 'secondary' }]}
      />
    );
  }

  const seatsLeft = session.max_players - session.occupied_seats;
  // ล็อกอินอยู่ไหม — ใช้เตือนสมาชิกที่เผลอเปิดลิงก์ guest ลงชื่อให้ตัวเอง (ไม่ใช่การตรวจสิทธิ์ ลิงก์นี้เปิดสาธารณะ)
  const user = await currentUser();

  return (
    <VStack as="main" gap={4} className="mx-auto w-full max-w-md p-4">
      <Card padding={5} variant="blue">
        <VStack gap={2}>
          <Text type="supporting" size="sm">
            {session.gang_name} ชวนคุณมาตีแบด
          </Text>
          <Heading level={1}>{session.title}</Heading>
          <Text weight="medium">{formatInTimeZone(new Date(session.starts_at), session.timezone, { dateStyle: 'full' })}</Text>
          <Text type="supporting">
            {formatInTimeZone(new Date(session.starts_at), session.timezone, { timeStyle: 'short' })}–
            {formatInTimeZone(new Date(session.ends_at), session.timezone, { timeStyle: 'short' })}
            {session.venue ? ` · ${session.venue}` : ''}
          </Text>
          <Text type="supporting" size="sm">
            {seatsLeft > 0 ? `เหลือที่ว่าง ${seatsLeft} คน` : 'เต็มแล้ว — ลงชื่อได้แต่จะอยู่ในคิวรอ'}
          </Text>
        </VStack>
      </Card>

      <Card padding={5}>
        {session.is_open ? (
          <GuestJoinForm inviteToken={token} signedInAs={user?.email ?? (user ? 'ของคุณ' : null)} />
        ) : (
          <Text>นัดนี้ยังไม่เปิดรับสมัคร หรือปิดรับแล้ว</Text>
        )}
      </Card>

      <Text type="supporting" size="xsm" justify="center">
        ไม่ต้องสมัครสมาชิก
      </Text>
    </VStack>
  );
}
