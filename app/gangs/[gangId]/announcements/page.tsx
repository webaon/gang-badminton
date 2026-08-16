import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import {
  AnnouncementsPanel,
  type AnnouncementRow,
} from '@/features/announcements/AnnouncementsPanel';

export const dynamic = 'force-dynamic';

/**
 * ประกาศของก๊วน — **[WO-3.D]**
 *
 * 🔴 query ผ่าน client ที่ผูก session ⇒ **RLS เป็นคนกรองร่างออก** (0032)
 *    ไม่ใช่ `.not('published_at', 'is', null)` ใน TypeScript
 *    (ถ้ากรองใน TS แล้ววันหนึ่งมีหน้าอื่นลืมกรอง ร่างจะหลุดทันที)
 */
export default async function AnnouncementsPage({
  params,
}: {
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/announcements`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name')
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
  if (!can({ role }, 'announcement.view')) redirect('/gangs');

  const { data } = await supabase
    .from('announcements')
    .select('id, title, body, published_at, image_urls')
    .eq('gang_id', gangId)
    .order('created_at', { ascending: false });

  type Row = {
    id: string;
    title: string;
    body: string;
    published_at: string | null;
    image_urls: string[] | null;
  };

  const announcements: AnnouncementRow[] = ((data ?? []) as Row[]).map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    publishedAt: a.published_at,
    imageCount: (a.image_urls ?? []).length,
  }));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">ประกาศ · {gang.name}</h1>
        <Link href={`/gangs/${gangId}/sessions`} className="underline">
          นัด
        </Link>
      </div>

      <AnnouncementsPanel
        gangId={gangId}
        announcements={announcements}
        canManage={can({ role }, 'announcement.manage')}
      />
    </main>
  );
}
