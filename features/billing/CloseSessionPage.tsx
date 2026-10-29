import { notFound, redirect } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { StatePanel } from '@/components/ui/StatePanel';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { errorText } from '@/lib/i18n/error-text';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { previewSessionCharges } from '@/server/actions/billing';
import { CloseSummary } from '@/features/billing/CloseSummary';
import { ConfirmCloseButton } from '@/features/billing/ConfirmCloseButton';

/**
 * หน้าสรุปยอดก่อนปิดรอบ (hi-fi 28) — **[WO-2.5-A · reskin WO-6.4b]**
 *
 * 🔴 ตัวเลขทุกบรรทัดมาจาก `previewSessionCharges()` ซึ่งเรียก
 *    `calculateSessionCharges()` ตัวเดียวกับตอนปิดรอบจริง
 *    ❌ ห้ามคำนวณยอดในหน้านี้เอง — หน้าจอจะเริ่มโกหกทันทีที่สูตรสองฝั่งเบี่ยงกัน
 *
 * 🔴 ด่านสิทธิ์อยู่ที่นี่ (`billing.close`) **ก่อน** อ่านยอด — สมาชิกทั่วไปถูกพากลับหน้านัด ไม่เห็นตัวเลข
 *    (และ `previewSessionCharges()` ตรวจสิทธิ์ซ้ำฝั่ง server)
 */
export async function CloseSessionPage({
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
      <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4">
        <StatePanel
          fullPage={false}
          tone="error"
          title="สรุปยอดไม่สำเร็จ"
          description={errorText(preview.error)}
          actions={[
            { label: 'กลับไปหน้ารายละเอียดนัด', href: `/gangs/${gangId}/sessions/${sessionId}` },
            { label: 'ลองใหม่', href: `/gangs/${gangId}/sessions/${sessionId}/close`, variant: 'secondary' },
          ]}
        />
      </VStack>
    );
  }

  const { needsConfirmation, warnings } = preview.data;

  return (
    <VStack as="section" gap={4} className="mx-auto w-full max-w-2xl p-4">
      <VStack gap={2}>
        <Heading level={1}>ปิดรอบ · {session.title}</Heading>
        <Text type="supporting">ตรวจยอดก่อนยืนยัน — ปิดแล้วแก้ไม่ได้</Text>
        <HStack gap={2} wrap="wrap">
          <Button size="sm" variant="secondary" label="ย้อนกลับไปคอนโซล" href={`/gangs/${gangId}/sessions/${sessionId}/console`} />
          <Button size="sm" variant="ghost" label="ยกเลิก" href={`/gangs/${gangId}/sessions/${sessionId}`} />
        </HStack>
      </VStack>

      {warnings.map((warning) => (
        <Banner key={warning} status="warning" title="ตรวจก่อนยืนยัน" description={warning} />
      ))}

      <CloseSummary preview={preview.data} />

      <ConfirmCloseButton sessionId={sessionId} gangId={gangId} needsCheckInConfirmation={needsConfirmation} />

      <Text type="supporting" size="sm">
        ปิดรอบแล้วยอดจะถูกบันทึกทันทีและแก้ไม่ได้ — ถ้าตัวเลขยังไม่ถูก ให้กลับไปแก้ที่คอนโซลก่อน
      </Text>
    </VStack>
  );
}
