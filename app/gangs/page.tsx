import Link from 'next/link';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { CreateGangForm } from '@/features/gangs/CreateGangForm';

export const metadata = { title: 'ก๊วนของฉัน · Gang Badminton' };
export const dynamic = 'force-dynamic';

export default async function GangsPage() {
  const user = await requireUser('/gangs');
  const supabase = await supabaseServer();

  // RLS กรองให้เองว่าเห็นเฉพาะก๊วนที่เป็นสมาชิก
  const { data } = await supabase
    .from('gang_members')
    .select('role, gangs!inner(id, name, area)')
    .eq('user_id', user.id)
    .is('deleted_at', null);

  type Row = { role: string; gangs: { id: string; name: string; area: string | null } };
  const gangs = ((data ?? []) as unknown as Row[]).map((r) => ({ ...r.gangs, role: r.role }));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">ก๊วนของฉัน</h1>
        {/* [WO-3.E] ทางเข้า discovery — หาก๊วนใหม่เข้าโดยไม่ต้องรอใครชวน */}
        <Link href="/discover" className="underline">
          ค้นหาก๊วน
        </Link>
      </div>

      {gangs.length === 0 ? (
        <Card padding={4} variant="muted">
          <p className="text-sm">ยังไม่ได้อยู่ก๊วนไหน — สร้างก๊วนใหม่ได้ด้านล่าง</p>
        </Card>
      ) : (
        <ul className="mb-6 divide-y">
          {gangs.map((g) => (
            <li key={g.id} className="py-3">
              <Link href={`/gangs/${g.id}/settings`} className="underline">
                {g.name}
              </Link>
              {g.area ? <span className="ml-2 text-sm">· {g.area}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <Card padding={6} elevation="low">
        <h2 className="mb-3 text-base font-semibold">สร้างก๊วนใหม่</h2>
        <CreateGangForm />
      </Card>
    </main>
  );
}
