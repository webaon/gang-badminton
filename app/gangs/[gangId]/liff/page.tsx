import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangFeatures, GangRole } from '@/domain/permissions/types';
import { myLineLink } from '@/server/actions/line';
import { buildLiffView } from '@/server/line/liff';
import { LiffPanel } from '@/features/line/LiffPanel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'ก๊วนของฉัน · LINE' };

/**
 * หน้า LIFF ของก๊วน — **[WO-4.E]**
 *
 * ตั้ง **Endpoint URL** ของ LIFF app ใน LINE Developers Console เป็นหน้านี้
 *
 * 🔴 **ไม่ได้ใช้ LIFF SDK และไม่เชื่อ `liff.getProfile()`** เป็นการยืนยันตัวตน
 *    ⇒ หน้านี้ใช้ **session ของ Supabase เหมือนหน้าเว็บปกติ** (in-app browser ของ LINE
 *      เก็บ cookie ได้) · ยังไม่ได้ล็อกอิน = เด้งไป `/sign-in` ตามปกติ
 *    เหตุผล: ตัวตนจาก LINE ยืนยันฝั่ง client ไม่ได้ และการเปิดทาง auth ที่สอง
 *    ขัดกติกาเดียวกับ WO-4.D ("ห้ามให้ LINE ข้ามขั้นตอน auth ของ Supabase")
 *    ผลพลอยได้: ไม่ต้องโหลดสคริปต์จาก CDN ภายนอก (CSP ของ Phase 5 จะสะอาดกว่า)
 *
 * 🔴 ทุกปุ่มในหน้านี้เรียก server action ตัวเดียวกับหน้าเว็บปกติ ⇒ ไม่มี endpoint พิเศษ
 *    ที่ข้าม `can()` / DB function / RLS
 */
export default async function LiffPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/liff`);
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
    .select('id, role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;
  const features = (gang.features ?? {}) as Partial<GangFeatures>;

  // 🔴 ก๊วนที่ปิด features.line เข้าหน้านี้ไม่ได้ (action ก็ปฏิเสธเช่นกัน)
  if (!can({ role, features }, 'line.link.self')) redirect(`/gangs/${gangId}/sessions`);

  const link = await myLineLink(gangId);
  const isLinked = link.success && link.data.isLinked;

  // ยังไม่ผูกบัญชี = พาไปผูกก่อน ไม่ใช่หน้าว่างหรือ 500
  if (!isLinked) {
    return (
      <main className="mx-auto max-w-md p-4">
        <Card padding={6}>
          <h1 className="mb-2 text-lg font-semibold">{gang.name}</h1>
          <p className="text-sm">ผูกบัญชี LINE ของคุณกับก๊วนนี้ก่อน แล้วหน้านี้จะใช้งานได้</p>
          <p className="mt-3">
            <Link href={`/gangs/${gangId}/line`} className="underline">
              ไปผูกบัญชี LINE
            </Link>
          </p>
        </Card>
      </main>
    );
  }

  // ทั้งหน้าใช้ client ที่ผูก session ของผู้ใช้ ⇒ RLS เป็นด่านจริงทุก query
  const view = await buildLiffView(supabase, {
    gangId,
    userId: user.id,
    gangMemberId: (membership?.id as string | undefined) ?? null,
  });

  return (
    <main className="mx-auto max-w-md p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{gang.name}</h1>
        <Link href={`/gangs/${gangId}/sessions`} className="text-sm underline">
          เปิดแบบเต็ม
        </Link>
      </div>

      <LiffPanel gangId={gangId} sessions={view.sessions} outstanding={view.outstanding} />
    </main>
  );
}
