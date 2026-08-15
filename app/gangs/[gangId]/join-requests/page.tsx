import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangFeatures, GangRole } from '@/domain/permissions/types';
import { JoinRequestsPanel, type JoinRequestRow } from '@/features/discovery/JoinRequestsPanel';

export const dynamic = 'force-dynamic';

/**
 * คำขอเข้าก๊วน (ฝั่งแอดมิน) — **[WO-3.E]**
 *
 * 🔴 ก๊วนที่ปิด `features.discovery` เข้าหน้านี้ไม่ได้ และ action ก็ปฏิเสธด้วย
 *    (`can()` gate ทั้งสองที่ — CLAUDE.md §3 "ซ่อนปุ่มอย่างเดียว = flag ปลอม")
 */
export default async function JoinRequestsPage({
  params,
}: {
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/join-requests`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, features')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;
  const features = (gang.features ?? {}) as Partial<GangFeatures>;

  if (!can({ role, features }, 'gang.join_request.manage')) redirect(`/gangs/${gangId}/members`);

  // RLS ของ `join_requests` (0010) เป็นด่านจริง — แอดมินของก๊วนนี้เท่านั้นที่เห็นแถวเหล่านี้
  const { data } = await supabase
    .from('join_requests')
    .select('id, user_id, message, status, created_at')
    .eq('gang_id', gangId)
    .order('created_at', { ascending: false })
    .limit(50);

  type Row = {
    id: string;
    user_id: string;
    message: string | null;
    status: string;
    created_at: string;
  };

  const rows = (data ?? []) as Row[];

  // ⚠️ คนที่ขอเข้าก๊วน **ยังไม่ใช่สมาชิก** ⇒ [D-12] ทำให้แอดมินอ่าน `profiles` ของเขา
  //    ผ่าน client ที่ผูก session ไม่ได้ (นั่นคือเจตนาของ [D-12] ไม่ใช่บั๊ก)
  //    ตรงนี้จึงใช้ admin client **อย่างตั้งใจ** และอ่านเฉพาะชื่อของคนที่ยื่นคำขอเข้ามาเอง
  const requesterIds = [...new Set(rows.map((r) => r.user_id))];
  const names = new Map<string, string>();

  if (requesterIds.length > 0) {
    const { data: profiles } = await supabaseAdmin()
      .from('profiles')
      .select('id, display_name')
      .in('id', requesterIds);

    for (const profile of (profiles ?? []) as Array<{ id: string; display_name: string }>) {
      names.set(profile.id, profile.display_name);
    }
  }

  const requests: JoinRequestRow[] = rows.map((row) => ({
    id: row.id,
    requesterName: names.get(row.user_id) ?? 'ผู้ใช้',
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
  }));

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          คำขอเข้าก๊วน · {gang.name}
          {pendingCount > 0 ? ` (${pendingCount})` : ''}
        </h1>
        <Link href={`/gangs/${gangId}/members`} className="underline">
          สมาชิก
        </Link>
      </div>

      <JoinRequestsPanel gangId={gangId} requests={requests} />
    </main>
  );
}
