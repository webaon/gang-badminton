import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangFeatures, GangRole } from '@/domain/permissions/types';
import { MembersPanel, type MemberRow } from '@/features/gangs/MembersPanel';

export const dynamic = 'force-dynamic';

export default async function GangMembersPage({
  params,
}: {
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/members`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, features')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) notFound();

  const { data } = await supabase
    .from('gang_members')
    .select('id, user_id, role, is_monthly_member, profiles!gang_members_user_id_fkey!inner(display_name)')
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .order('role');

  type Row = {
    id: string;
    user_id: string;
    role: GangRole;
    is_monthly_member: boolean;
    profiles: { display_name: string };
  };
  const members: MemberRow[] = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    userId: r.user_id,
    displayName: r.profiles.display_name,
    role: r.role,
    isMonthlyMember: r.is_monthly_member,
  }));

  const myRole = (members.find((m) => m.userId === user.id)?.role ?? null) as GangRole | null;
  const features = (gang.features ?? {}) as Partial<GangFeatures>;

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">สมาชิก · {gang.name}</h1>
        <span className="flex gap-3">
          {/* [WO-3.E] ก๊วนที่ปิด discovery ไม่มีคำขอให้ดู — `can()` เป็นคนตัดสินที่เดียว */}
          {can({ role: myRole, features }, 'gang.join_request.manage') ? (
            <Link href={`/gangs/${gangId}/join-requests`} className="underline">
              คำขอเข้าก๊วน
            </Link>
          ) : null}
          {/* [WO-4.B] ผูกบัญชี LINE ของตัวเอง — เห็นเฉพาะก๊วนที่เปิด features.line */}
          {can({ role: myRole, features }, 'line.link.self') ? (
            <Link href={`/gangs/${gangId}/line`} className="underline">
              เชื่อมต่อ LINE
            </Link>
          ) : null}
          <Link href={`/gangs/${gangId}/membership`} className="underline">
            บิลรายเดือน
          </Link>
          <Link href={`/gangs/${gangId}/settings`} className="underline">
            ตั้งค่า
          </Link>
        </span>
      </div>

      <Card padding={6}>
        <MembersPanel
          gangId={gangId}
          members={members}
          canManage={can({ role: myRole }, 'gang.member.manage')}
        />
      </Card>
    </main>
  );
}
