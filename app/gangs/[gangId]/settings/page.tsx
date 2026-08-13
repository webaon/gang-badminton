import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { fromJson as policyFromJson } from '@/domain/policies/cancellation';
import { GangSettingsForm } from '@/features/gangs/GangSettingsForm';

export const dynamic = 'force-dynamic';

export default async function GangSettingsPage({
  params,
}: {
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/settings`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, area, is_public, promptpay_id, timezone, cancellation_policy')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  // RLS คืน 0 แถวเมื่อไม่มีสิทธิ์ — แยกไม่ออกจาก "ไม่มีก๊วนนี้"
  // ⇒ ตอบ 404 เหมือนกัน ซึ่งเป็นสิ่งที่ต้องการ: ไม่บอกว่าก๊วนนี้มีอยู่จริงไหม
  if (!gang) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  if (!can({ role }, 'gang.update')) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <Card padding={6}>
          <h1 className="mb-2 text-xl font-semibold">{gang.name}</h1>
          <p className="text-sm">เฉพาะแอดมินของก๊วนเท่านั้นที่แก้ตั้งค่าได้</p>
          <p className="mt-4">
            <Link href={`/gangs/${gangId}/members`} className="underline">
              ดูรายชื่อสมาชิก
            </Link>
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">ตั้งค่าก๊วน</h1>
        <Link href={`/gangs/${gangId}/members`} className="underline">
          สมาชิก
        </Link>
      </div>

      <Card padding={6}>
        <GangSettingsForm
          gangId={gangId}
          initial={{
            name: gang.name,
            area: gang.area,
            isPublic: gang.is_public,
            promptpayId: gang.promptpay_id,
            timezone: gang.timezone,
            cancellationPolicy: policyFromJson(gang.cancellation_policy),
          }}
        />
      </Card>
    </main>
  );
}
