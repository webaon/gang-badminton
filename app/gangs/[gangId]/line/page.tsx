import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { myLineLink } from '@/server/actions/line';
import { LinkLinePanel } from '@/features/line/LinkLinePanel';

export const dynamic = 'force-dynamic';

/**
 * เชื่อมต่อ LINE ของสมาชิก — **[WO-4.B]**
 *
 * 🔴 ก๊วนที่ปิด `features.line` เข้าไม่ได้ทั้งหน้าและ action — `myLineLink()` ตรวจ
 *    `line.link.self` (ผูกกับ flag) ให้แล้ว ⇒ ที่นี่แค่แปลผลเป็นการ redirect
 */
export default async function LinkLinePage({
  params,
}: {
  params: Promise<{ gangId: string }>;
}) {
  const { gangId } = await params;
  await requireUser(`/gangs/${gangId}/line`);

  const supabase = await supabaseServer();
  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) notFound();

  const link = await myLineLink(gangId);
  if (!link.success) redirect(`/gangs/${gangId}/sessions`);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm">{gang.name}</p>
        <Link href={`/gangs/${gangId}/sessions`} className="underline">
          นัด
        </Link>
      </div>

      <Card padding={6}>
        <LinkLinePanel gangId={gangId} initial={link.data} />
      </Card>
    </main>
  );
}
