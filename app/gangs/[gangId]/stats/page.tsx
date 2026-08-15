import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Table, proportional, pixel } from '@astryxdesign/core/Table';

import { requireUser } from '@/lib/supabase/auth';
import { moneyFromDb } from '@/lib/supabase/money';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangFeatures, GangRole } from '@/domain/permissions/types';

export const dynamic = 'force-dynamic';

/**
 * สถิติสมาชิก — **[WO-3.C]**
 *
 * 🔴 baseline §ตาราง: `member_statistics` เป็น **แหล่งเดียวสำหรับการแสดงผล**
 *    ⇒ หน้านี้ไม่มี query นับสดเลย · ❌ ห้าม fallback ไปนับเองเมื่อ rollup ยังไม่มา
 *      (สองแหล่งความจริง แล้วเลขบนจอกับในรายงานจะไม่ตรงกัน)
 *
 * 🔴 ใครเห็นอะไร **RLS เป็นคนตัดสิน** (0031): สมาชิกเห็นแถวของตัวเอง แอดมินเห็นทั้งก๊วน
 *    ⇒ หน้านี้ query ผ่าน client ที่ผูก session ไม่ใช่ admin client
 */
export default async function StatsPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/stats`);
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

  // 🔴 ปิด features.statistics = เข้าไม่ได้จริง ไม่ใช่แค่ซ่อนลิงก์ (CLAUDE.md §3)
  if (!can({ role, features }, 'statistics.view')) {
    redirect(`/gangs/${gangId}/sessions`);
  }

  const { data: stats } = await supabase
    .from('member_statistics')
    .select(
      'gang_member_id, attended_count, games_count, shuttles_used, total_paid, attendance_rate, computed_at, gang_members!inner(profiles!inner(display_name))',
    )
    .eq('gang_id', gangId)
    .order('attended_count', { ascending: false });

  type Row = {
    gang_member_id: string;
    attended_count: number;
    games_count: number;
    shuttles_used: string | number;
    total_paid: string | number;
    attendance_rate: string | number;
    computed_at: string;
    gang_members: { profiles: { display_name: string } };
  };

  const rows = (stats ?? []) as unknown as Row[];

  type StatRow = { name: string; attended: string; games: string; paid: string } & Record<
    string,
    unknown
  >;

  const tableRows: StatRow[] = rows.map((r) => ({
    name: r.gang_members.profiles.display_name,
    attended: `${r.attended_count} ครั้ง (${Number(r.attendance_rate)}%)`,
    games: `${r.games_count} เกม · ${Number(r.shuttles_used)} ลูก`,
    paid: `${moneyFromDb(r.total_paid)} ฿`,
  }));

  const computedAt = rows[0]?.computed_at ?? null;

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">สถิติ · {gang.name}</h1>
        <Link href={`/gangs/${gangId}/sessions`} className="underline">
          นัด
        </Link>
      </div>

      {rows.length === 0 ? (
        // ⚠️ "ยังไม่มีข้อมูล" ≠ "0" — ตัวเลข 0 ที่ยังไม่เคยคำนวณคือการโกหก
        <Banner
          status="info"
          title="ยังไม่มีข้อมูลสถิติ"
          description="ระบบคำนวณให้ทุกคืน — หรือกด “คำนวณสถิติใหม่” ในหน้าตั้งค่าก๊วนเพื่อดูเลยตอนนี้"
        />
      ) : (
        <Card padding={4}>
          <p className="mb-3 text-sm opacity-70">
            คำนวณล่าสุด {computedAt ? new Date(computedAt).toLocaleString('th-TH') : '—'}
            {can({ role }, 'gang.finance.view')
              ? ''
              : ' · เห็นเฉพาะสถิติของตัวเอง'}
          </p>

          <Table
            data={tableRows}
            idKey={(row) => row.name}
            density="compact"
            columns={[
              { key: 'name', header: 'ชื่อ', width: proportional(1) },
              { key: 'attended', header: 'มาเล่น', width: pixel(140) },
              { key: 'games', header: 'เกม/ลูก', width: pixel(140) },
              { key: 'paid', header: 'จ่ายสะสม', width: pixel(110), align: 'end' },
            ]}
          />
        </Card>
      )}

      <p className="mt-3 text-sm opacity-70">
        “จ่ายสะสม” คือเงินที่จ่ายจริงหลังหักเงินคืน · “มาเล่น” คิดจากนัดที่ได้ที่ ไม่ใช่นัดทั้งหมดของก๊วน
      </p>
    </main>
  );
}
