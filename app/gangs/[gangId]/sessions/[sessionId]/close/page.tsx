import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Table, proportional, pixel } from '@astryxdesign/core/Table';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { previewSessionCharges } from '@/server/actions/billing';
import { ConfirmCloseButton } from '@/features/billing/ConfirmCloseButton';

export const dynamic = 'force-dynamic';

/** เหตุผลจาก `chargeReason()` — แปลเป็นภาษาคนที่จุดแสดงผลจุดเดียว */
const REASON_LABEL: Record<string, string> = {
  attended: 'มาเล่น (เช็คอินแล้ว)',
  no_check_in: 'ได้ที่แต่ไม่ได้เช็คอิน',
  no_show: 'ไม่มา',
  late_cancel: 'ยกเลิกช้ากว่ากำหนด',
  cancelled_in_time: 'ยกเลิกทันกำหนด',
  waitlist: 'อยู่ในคิวรอ',
  monthly_member: 'สมาชิกรายเดือน',
  not_charged: 'ไม่ถูกเก็บ',
};

/**
 * หน้าสรุปยอดก่อนปิดรอบ — **[WO-2.5-A]**
 *
 * 🔴 ตัวเลขทุกบรรทัดมาจาก `previewSessionCharges()` ซึ่งเรียก
 *    `calculateSessionCharges()` ตัวเดียวกับตอนปิดรอบจริง
 *    ❌ ห้ามคำนวณยอดในหน้านี้เอง — หน้าจอจะเริ่มโกหกทันทีที่สูตรสองฝั่งเบี่ยงกัน
 */
export default async function CloseSessionPage({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  const user = await requireUser(`/gangs/${gangId}/sessions/${sessionId}/close`);
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

  if (!can({ role: (membership?.role as GangRole | undefined) ?? null }, 'billing.close')) {
    redirect(`/gangs/${gangId}/sessions/${sessionId}`);
  }

  // ปิดไปแล้วก็ไม่มีอะไรให้ยืนยัน — กลับหน้ารายละเอียดนัด
  if (!['open', 'in_play'].includes(session.status)) {
    redirect(`/gangs/${gangId}/sessions/${sessionId}`);
  }

  const preview = await previewSessionCharges(sessionId);

  if (!preview.success) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <Banner status="error" title="สรุปยอดไม่สำเร็จ" description={preview.error.message} />
        <p className="mt-3">
          <Link href={`/gangs/${gangId}/sessions/${sessionId}`} className="underline">
            กลับไปหน้ารายละเอียดนัด
          </Link>
        </p>
      </main>
    );
  }

  const { rows, total, chargedCount, checkedInCount, needsConfirmation, warnings } = preview.data;

  type PreviewRow = {
    name: string;
    reason: string;
    amount: string;
  } & Record<string, unknown>;

  const tableRows: PreviewRow[] = rows.map((r) => ({
    name: r.displayName + (r.isMonthlyMember ? ' · รายเดือน' : ''),
    reason: REASON_LABEL[r.reason] ?? r.reason,
    amount: `${r.amount} ฿`,
  }));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">สรุปยอดก่อนปิดรอบ · {session.title}</h1>
        <Link href={`/gangs/${gangId}/sessions/${sessionId}`} className="underline">
          ยกเลิก
        </Link>
      </div>

      {warnings.map((warning) => (
        <div key={warning} className="mb-3">
          <Banner status="warning" title="ตรวจก่อนยืนยัน" description={warning} />
        </div>
      ))}

      <Card padding={4}>
        <p className="mb-3 text-sm">
          เก็บ {chargedCount} คน · รวม <strong>{total} บาท</strong> · เช็คอินแล้ว {checkedInCount}{' '}
          คน
        </p>

        <Table
          data={tableRows}
          idKey={(row) => row.name}
          density="compact"
          columns={[
            { key: 'name', header: 'ชื่อ', width: proportional(1) },
            { key: 'reason', header: 'เหตุผล', width: proportional(1) },
            { key: 'amount', header: 'ยอด', width: pixel(96), align: 'end' },
          ]}
        />
      </Card>

      <div className="mt-4">
        <ConfirmCloseButton
          sessionId={sessionId}
          gangId={gangId}
          needsCheckInConfirmation={needsConfirmation}
        />
      </div>

      <p className="mt-3 text-sm opacity-70">
        ปิดรอบแล้วยอดจะถูกบันทึกทันทีและแก้ไม่ได้ — ถ้าตัวเลขยังไม่ถูก ให้กลับไปแก้ที่คอนโซลก่อน
      </p>
    </main>
  );
}
