import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { fromJson as recurrenceFromJson } from '@/domain/sessions/recurrence';
import { TemplatesPanel, type TemplateRow } from '@/features/sessions/TemplatesPanel';

export const dynamic = 'force-dynamic';

/**
 * ตารางนัดประจำ — **[WO-2.5-E]**
 *
 * cron สร้างนัดล่วงหน้า 2 สัปดาห์ให้ทุกวัน (idempotent) — หน้านี้ไว้ตั้งค่าและสั่งสร้างเองได้
 */
export default async function TemplatesPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/templates`);
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
  if (!can({ role }, 'session.create')) redirect(`/gangs/${gangId}/sessions`);

  const { data: templates } = await supabase
    .from('session_templates')
    .select('id, name, recurrence, venue, court_count, max_players, allow_guests, is_active')
    .eq('gang_id', gangId)
    .order('created_at');

  // นับนัดที่ยังไม่ถึงเวลาของแต่ละตาราง — ให้แอดมินเห็นว่า cron ทำงานอยู่จริง
  const { data: upcoming } = await supabase
    .from('sessions')
    .select('template_id')
    .eq('gang_id', gangId)
    .not('template_id', 'is', null)
    .is('deleted_at', null)
    .gte('starts_at', new Date().toISOString());

  const upcomingCount = new Map<string, number>();
  for (const row of upcoming ?? []) {
    const key = row.template_id as string;
    upcomingCount.set(key, (upcomingCount.get(key) ?? 0) + 1);
  }

  type Row = {
    id: string;
    name: string;
    recurrence: unknown;
    venue: string | null;
    court_count: number;
    max_players: number;
    allow_guests: boolean;
    is_active: boolean;
  };

  const rows: TemplateRow[] = ((templates ?? []) as Row[]).map((t) => ({
    id: t.id,
    name: t.name,
    venue: t.venue,
    courtCount: t.court_count,
    maxPlayers: t.max_players,
    allowGuests: t.allow_guests,
    isActive: t.is_active,
    recurrence: recurrenceFromJson(t.recurrence),
    upcoming: upcomingCount.get(t.id) ?? 0,
  }));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">ตารางประจำ · {gang.name}</h1>
        <Link href={`/gangs/${gangId}/sessions`} className="underline">
          นัด
        </Link>
      </div>

      <Card padding={4} variant="muted">
        <p className="text-sm">
          ระบบสร้างนัดล่วงหน้า <strong>2 สัปดาห์</strong> ให้อัตโนมัติทุกวัน · นัดที่สร้างเป็น
          “ร่าง” เสมอ ต้องกดเปิดรับสมัครเอง
        </p>
      </Card>

      <div className="mt-4">
        <TemplatesPanel gangId={gangId} templates={rows} />
      </div>
    </main>
  );
}
