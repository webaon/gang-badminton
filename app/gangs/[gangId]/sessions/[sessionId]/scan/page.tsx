import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { ScanCheckin } from '@/features/sessions/ScanCheckin';

export const dynamic = 'force-dynamic';

/**
 * หน้าสแกน QR เช็คอินของแอดมิน — **[WO-2.5-F]**
 *
 * QR ของผู้เล่นบรรจุ URL ของหน้านี้พร้อม `?c=<token>` ⇒ แอดมินสแกนด้วย
 * **กล้องของเครื่องเอง** (ทุกมือถือเปิด URL จาก QR ได้) แล้วมาถึงหน้านี้ทั้งที่ล็อกอินอยู่
 *
 * ⚠️ จงใจไม่ฝังไลบรารีอ่าน QR ในหน้าเว็บ — กล้องเนทีฟเร็วกว่าและไม่ต้องขอสิทธิ์กล้อง
 *    ผ่านเบราว์เซอร์ (iOS Safari ยังไม่รองรับ `BarcodeDetector`)
 */
export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const { gangId, sessionId } = await params;
  const { c: token } = await searchParams;

  const user = await requireUser(
    `/gangs/${gangId}/sessions/${sessionId}/scan${token ? `?c=${encodeURIComponent(token)}` : ''}`,
  );
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, status')
    .eq('id', sessionId)
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  // สแกนเช็คอินเป็นงานของแอดมิน — คนอื่นเปิดลิงก์นี้ได้ก็จะเช็คอินให้ตัวเองไม่ได้อยู่ดี
  if (!can({ role }, 'registration.checkin')) {
    redirect(`/gangs/${gangId}/sessions/${sessionId}`);
  }

  return (
    <main className="mx-auto max-w-md p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">สแกนเช็คอิน · {session.title}</h1>
        <Link href={`/gangs/${gangId}/sessions/${sessionId}/console`} className="underline">
          คอนโซล
        </Link>
      </div>

      <Card padding={6}>
        <ScanCheckin sessionId={sessionId} gangId={gangId} token={token ?? null} />
      </Card>
    </main>
  );
}
