import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { formatInTimeZone } from '@/domain/time/timezone';
import { CreateSessionForm } from '@/features/sessions/CreateSessionForm';
import { SessionActions } from '@/features/sessions/SessionActions';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  draft: 'ร่าง',
  open: 'เปิดรับสมัคร',
  in_play: 'กำลังเล่น',
  billing: 'กำลังเก็บเงิน',
  settled: 'เก็บเงินครบ',
  archived: 'เก็บเข้าคลัง',
  cancelled: 'ยกเลิก',
};

export default async function SessionsPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/sessions`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name, timezone')
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
  const canCreate = can({ role }, 'session.create');

  const { data: plan } = await supabase
    .from('gang_pricing_plans')
    .select('id')
    .eq('gang_id', gangId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, title, venue, starts_at, ends_at, status, max_players')
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .order('starts_at', { ascending: false });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">นัดของ {gang.name}</h1>
        <Link href={`/gangs/${gangId}/settings`} className="underline">
          ตั้งค่า
        </Link>
      </div>

      {canCreate && !plan ? (
        <div className="mb-4">
          <Card padding={4} variant="muted">
            <p className="text-sm">
              ยังไม่ได้ตั้งแผนราคา — ต้องตั้งราคาก่อนถึงจะสร้างนัดได้{' '}
              <Link href={`/gangs/${gangId}/settings`} className="underline">
                ไปตั้งราคา
              </Link>
            </p>
          </Card>
        </div>
      ) : null}

      {(sessions ?? []).length === 0 ? (
        <Card padding={4} variant="muted">
          <p className="text-sm">ยังไม่มีนัด</p>
        </Card>
      ) : (
        <ul className="mb-6 flex flex-col gap-3">
          {(sessions ?? []).map((s) => (
            <li key={s.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/gangs/${gangId}/sessions/${s.id}`}
                      className="font-medium underline"
                    >
                      {s.title}
                    </Link>
                    {/* 🔴 แสดงตาม timezone ของก๊วน ไม่ใช่ของเครื่องผู้ใช้ */}
                    <p className="text-sm">
                      {formatInTimeZone(new Date(s.starts_at), gang.timezone)} –{' '}
                      {formatInTimeZone(new Date(s.ends_at), gang.timezone, {
                        timeStyle: 'short',
                      })}
                    </p>
                    {s.venue ? <p className="text-sm">{s.venue}</p> : null}
                    <p className="text-sm">รับ {s.max_players} คน</p>
                  </div>
                  <Badge label={STATUS_LABELS[s.status] ?? s.status} />
                </div>

                {can({ role }, 'session.transition') ? (
                  <div className="mt-3">
                    <SessionActions sessionId={s.id} status={s.status} />
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {canCreate && plan ? (
        <Card padding={6} elevation="low">
          <h2 className="mb-3 text-base font-semibold">สร้างนัดใหม่</h2>
          <CreateSessionForm gangId={gangId} timezone={gang.timezone} />
        </Card>
      ) : null}
    </main>
  );
}
