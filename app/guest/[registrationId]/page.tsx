import { redirect } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { StatePanel } from '@/components/ui/StatePanel';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readGuestCookie } from '@/lib/guest/session';
import { formatInTimeZone } from '@/domain/time/timezone';
import { GuestCancelButton } from '@/features/sessions/GuestCancelButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'สถานะการลงชื่อ · Gang Badminton' };

const STATUS_LABELS: Record<string, string> = {
  confirmed: 'ได้ที่แล้ว',
  waitlist: 'อยู่ในคิวรอ',
  checked_in: 'เช็คอินแล้ว',
  cancelled: 'ยกเลิกแล้ว',
  no_show: 'ไม่ได้มา',
};

/**
 * หน้าสถานะของ guest — **[WO-2.5-F]** อ่าน token จาก cookie httpOnly
 *
 * 🔴 เปิดด้วยลิงก์ที่มี `?t=` ครั้งแรก → เด้งไป `/claim` เพื่อแลกเป็น cookie
 *    แล้วกลับมาที่ URL สะอาด ⇒ token ไม่ติดไปกับ referrer / log ของ proxy /
 *    ประวัติเบราว์เซอร์ / ลิงก์ที่แขกแชร์ต่อ
 *
 * ⚠️ เปิดซ้ำครั้งต่อไปไม่ต้องมี token ใน URL เลย — cookie ทำงานแทน
 */
export default async function GuestStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ registrationId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { registrationId } = await params;
  const { t: tokenInUrl } = await searchParams;

  // มี token ใน URL = เพิ่งกดลิงก์ครั้งแรก ⇒ แลกเป็น cookie ก่อนแล้วค่อยกลับมา
  if (tokenInUrl) {
    redirect(`/guest/${registrationId}/claim?t=${encodeURIComponent(tokenInUrl)}`);
  }

  const guestToken = await readGuestCookie();

  // [WO-6.1b] hi-fi K g3 — ข้อความเดียวกันทุกกรณี (ไม่ใช่ token / token ของนัดอื่น / ไม่มีแถว) กัน oracle
  const denied = (
    <StatePanel
      tone="error"
      title="ลิงก์นี้ใช้ไม่ได้แล้ว"
      description="ลิงก์ไม่ถูกต้องหรือหมดอายุ — ใช้ลิงก์ที่ได้ตอนลงชื่อ หรือขอลิงก์ใหม่จากคนที่ชวนคุณมา"
      actions={[{ label: 'หาก๊วนอื่นแถวนี้', href: '/discover', variant: 'secondary' }]}
    />
  );

  if (!guestToken) return denied;


  const { data, error } = await supabaseAdmin().rpc('guest_registration', {
    p_registration_id: registrationId,
    p_guest_token: guestToken,
  });

  if (error) return denied;

  const reg = (data as Array<{
    status: string;
    guest_name: string;
    session_title: string;
    starts_at: string;
    ends_at: string;
    venue: string | null;
    timezone: string;
  }> | null)?.[0];

  if (!reg) return denied;

  const canCancel = ['confirmed', 'waitlist'].includes(reg.status);

  // hi-fi 22 — หน้ายืนยัน/สถานะของ guest (ไม่ต้องสมัครสมาชิก)
  return (
    <VStack as="main" gap={4} className="mx-auto w-full max-w-md p-4">
      <Card padding={5} variant={reg.status === 'waitlist' ? 'orange' : reg.status === 'cancelled' ? 'muted' : 'green'}>
        <VStack gap={2}>
          <HStack justify="between" align="start" gap={3}>
            <Text type="supporting" size="sm">
              ชื่อที่ลง: {reg.guest_name}
            </Text>
            <Badge label={STATUS_LABELS[reg.status] ?? reg.status} />
          </HStack>
          <Heading level={1}>{reg.session_title}</Heading>
          <Text weight="medium">{formatInTimeZone(new Date(reg.starts_at), reg.timezone, { dateStyle: 'full' })}</Text>
          <Text type="supporting">
            {formatInTimeZone(new Date(reg.starts_at), reg.timezone, { timeStyle: 'short' })}–
            {formatInTimeZone(new Date(reg.ends_at), reg.timezone, { timeStyle: 'short' })}
            {reg.venue ? ` · ${reg.venue}` : ''}
          </Text>
        </VStack>
      </Card>

      {reg.status === 'waitlist' ? (
        <Banner status="info" title="คุณอยู่ในคิวรอ" description="ถ้ามีคนยกเลิก คุณจะได้ที่ตามลำดับ เปิดลิงก์นี้ดูสถานะได้ตลอด" />
      ) : null}

      {canCancel ? (
        // ⚠️ ไม่ส่ง token ลงไปที่ client — server action อ่านจาก cookie เอง
        <GuestCancelButton registrationId={registrationId} />
      ) : null}
    </VStack>
  );
}
