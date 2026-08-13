import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';

import { supabaseAdmin } from '@/lib/supabase/admin';
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
 * หน้าสถานะของ guest — เข้าได้ด้วย `?t=<guest token>` เท่านั้น
 *
 * 🔴 token อยู่ใน query string ⇒ อาจติดไปกับ referrer/log ของ proxy
 *    ยอมรับข้อจำกัดนี้ใน MVP-0 เพราะ guest ไม่มีบัญชีให้ผูก session
 *    (บันทึกใน BACKLOG — ทางแก้คือแลก token เป็น cookie ครั้งแรกที่เปิด)
 */
export default async function GuestStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ registrationId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { registrationId } = await params;
  const { t: guestToken } = await searchParams;

  const denied = (
    <main className="mx-auto max-w-md p-4">
      <Card padding={6}>
        <h1 className="mb-2 text-xl font-semibold">เปิดดูไม่ได้</h1>
        <p className="text-sm">ลิงก์ไม่ถูกต้อง — ใช้ลิงก์ที่ได้ตอนลงชื่อ</p>
      </Card>
    </main>
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

  return (
    <main className="mx-auto max-w-md p-4">
      <Card padding={6}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{reg.session_title}</h1>
          <Badge label={STATUS_LABELS[reg.status] ?? reg.status} />
        </div>

        <p className="text-sm">ชื่อที่ลง: {reg.guest_name}</p>
        <p className="text-sm">
          {formatInTimeZone(new Date(reg.starts_at), reg.timezone)} –{' '}
          {formatInTimeZone(new Date(reg.ends_at), reg.timezone, { timeStyle: 'short' })}
        </p>
        {reg.venue ? <p className="text-sm">{reg.venue}</p> : null}

        {canCancel ? (
          <div className="mt-4">
            <GuestCancelButton registrationId={registrationId} guestToken={guestToken} />
          </div>
        ) : null}
      </Card>
    </main>
  );
}
