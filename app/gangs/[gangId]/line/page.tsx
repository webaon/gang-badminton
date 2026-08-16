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
const CALLBACK_ERRORS: Record<string, string> = {
  invalid_state: 'ลิงก์หมดอายุหรือไม่ถูกต้อง — กดผูกบัญชีใหม่อีกครั้ง',
  nonce_mismatch: 'ลิงก์ไม่ตรงกับเบราว์เซอร์นี้ — เริ่มผูกบัญชีใหม่จากหน้านี้',
  not_signed_in: 'ต้องเข้าสู่ระบบก่อนจึงจะผูกบัญชีได้',
  wrong_user: 'ลิงก์นี้เป็นของผู้ใช้คนอื่น',
  not_configured: 'ก๊วนนี้ยังตั้งค่า LINE Login ไม่ครบ',
  exchange_failed: 'ติดต่อ LINE ไม่สำเร็จ — ลองใหม่อีกครั้ง',
  link_failed: 'ผูกบัญชีไม่สำเร็จ — บัญชี LINE นี้อาจถูกผูกกับสมาชิกคนอื่นแล้ว',
  denied: 'คุณยกเลิกการอนุญาตที่หน้า LINE',
};

export default async function LinkLinePage({
  params,
  searchParams,
}: {
  params: Promise<{ gangId: string }>;
  searchParams: Promise<{ linked?: string; error?: string }>;
}) {
  const { gangId } = await params;
  const { linked, error: callbackError } = await searchParams;
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

      {linked === '1' ? (
        <div className="mb-3">
          <Card padding={4} variant="muted">
            <p className="text-sm">ผูกบัญชี LINE เรียบร้อยแล้ว</p>
          </Card>
        </div>
      ) : null}

      {callbackError ? (
        <div className="mb-3">
          <Card padding={4} variant="muted">
            <p className="text-sm">
              {CALLBACK_ERRORS[callbackError] ?? 'ผูกบัญชีไม่สำเร็จ — ลองใหม่อีกครั้ง'}
            </p>
          </Card>
        </div>
      ) : null}

      <Card padding={6}>
        <LinkLinePanel gangId={gangId} initial={link.data} />
      </Card>
    </main>
  );
}
