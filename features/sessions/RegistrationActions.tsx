'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';

import { actionError } from '@/lib/i18n/error-text';
import { formatInTimeZone } from '@/domain/time/timezone';
import { cancelNotice, type CancelPreview } from '@/domain/sessions/cancel-notice';
import type { PrimaryAction } from '@/domain/sessions/member-view';
import { cancelPreview as fetchCancelPreview, cancelRegistration, registerSelf } from '@/server/actions/registrations';

/**
 * ปุ่มหลักเดียวของหน้านัด (hi-fi 19) — ลงชื่อ / เข้าคิว / ยกเลิก ตามสถานะของฉัน [WO-6.2]
 *
 * 🔴 ที่นี่ไม่ตัดสินสิทธิ์ ไม่นับที่ว่าง ไม่คำนวณค่าปรับ:
 *    · `primary` ถูกคำนวณฝั่ง server จาก `can()` + roster แล้วส่งมา — ปุ่มที่ซ่อน/แสดงไม่ใช่การตรวจสิทธิ์
 *      (server action ตรวจซ้ำ และ `register_to_session()` นับที่ว่างใต้ lock เอง)
 *    · ผลของการยกเลิกที่บอกผู้ใช้มาจาก `cancelPreview()` (server action read-only · ตัวตัดสินเดียวกับ cancel จริง)
 *      เรียกตอนกดปุ่มยกเลิก เพื่อให้ได้คำตอบ ณ เวลานั้น — เรียกไม่สำเร็จ = ข้อความกลาง ไม่อ้างเวลา/เงิน
 */
export function RegistrationActions({
  sessionId,
  myRegistrationId,
  primary,
  timezone,
}: {
  sessionId: string;
  myRegistrationId: string | null;
  primary: PrimaryAction;
  timezone: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [raceNotice, setRaceNotice] = useState(false);

  async function onRegister() {
    setPending(true);
    setError(null);
    setRaceNotice(false);
    const result = await registerSelf(sessionId);
    if (result.success) {
      // hi-fi K19c — UI เห็นว่ามีที่ แต่ server (ใต้ lock) ตัดสินว่าเต็ม ⇒ ได้คิวรอแทน: บอกตรงๆ ไม่ให้ตกใจ
      if (result.data.status === 'waitlist' && primary.kind === 'register') setRaceNotice(true);
      router.refresh();
    } else {
      setError(actionError(result.error));
    }
    setPending(false);
  }

  async function onOpenCancel() {
    if (!myRegistrationId) return;
    setError(null);
    setPreview(null);
    setPreviewLoading(true);
    setConfirmOpen(true);
    // ถามผลจาก server ตอนกดจริง (read-only) — ล้มเหลว/โยน error = ข้อความกลาง ยังยกเลิกได้ ไม่ขวางผู้ใช้
    try {
      const result = await fetchCancelPreview(myRegistrationId);
      if (result.success) setPreview(result.data);
      else if (result.error.code === 'UNAUTHENTICATED') setError(actionError(result.error));
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function onConfirmCancel() {
    if (!myRegistrationId) return;
    setPending(true);
    setError(null);
    const result = await cancelRegistration(myRegistrationId);
    setPending(false);
    setConfirmOpen(false);
    if (result.success) router.refresh();
    else setError(actionError(result.error));
  }

  const blocked = !previewLoading && preview?.outcome === 'blocked';
  const notice = cancelNotice(preview, (iso) =>
    formatInTimeZone(new Date(iso), timezone, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  );

  return (
    <VStack gap={3}>
      {primary.kind === 'register' ? (
        <Button
          variant="primary"
          size="lg"
          width="100%"
          label="ลงชื่อเข้านัด"
          isLoading={pending}
          onClick={onRegister}
        />
      ) : null}

      {primary.kind === 'join_waitlist' ? (
        <>
          <Banner
            status="warning"
            title="นัดนี้เต็มแล้ว"
            description="ลงชื่อได้ คุณจะอยู่ในคิวรอ และได้ที่อัตโนมัติเมื่อมีคนยกเลิก"
          />
          <Button
            variant="primary"
            size="lg"
            width="100%"
            label={`เข้าคิวรอ (ลำดับที่ ${primary.nextPosition})`}
            isLoading={pending}
            onClick={onRegister}
          />
        </>
      ) : null}

      {primary.kind === 'cancel' || primary.kind === 'cancel_waitlist' ? (
        <Button
          variant="secondary"
          size="lg"
          width="100%"
          label="ยกเลิกการลงชื่อ"
          isDisabled={pending}
          onClick={onOpenCancel}
        />
      ) : null}

      {primary.kind === 'none' ? (
        <Banner
          status="info"
          title={primary.reason === 'not_open' ? 'นัดนี้ยังไม่เปิดรับลงชื่อ' : 'คุณยังลงชื่อนัดนี้ไม่ได้'}
          description={
            primary.reason === 'not_open'
              ? 'รอแอดมินเปิดรับ หรือนัดนี้ปิดรับแล้ว'
              : 'ต้องเป็นสมาชิกของก๊วนนี้จึงจะลงชื่อได้'
          }
        />
      ) : null}

      {raceNotice ? (
        <Banner
          status="warning"
          title="เต็มพอดีก่อนคุณกดยืนยัน"
          description="มีคนลงชื่อที่สุดท้ายไปก่อนไม่กี่วินาที — คุณเข้าคิวรอแล้ว และจะได้ที่อัตโนมัติเมื่อมีคนยกเลิก"
        />
      ) : null}

      {error ? <Banner status="error" title={error} /> : null}

      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open);
        }}
        title="ยกเลิกการลงชื่อ?"
        description={
          previewLoading
            ? 'กำลังตรวจผลการยกเลิก…'
            : notice.tone === 'neutral'
              ? notice.description
              : `${notice.title} — ${notice.description}`
        }
        actionLabel={blocked ? 'รับทราบ' : 'ยืนยันยกเลิก'}
        actionVariant={blocked ? 'secondary' : 'destructive'}
        cancelLabel={blocked ? 'ปิด' : 'ไม่ยกเลิก'}
        onAction={blocked ? () => setConfirmOpen(false) : onConfirmCancel}
        isActionLoading={pending || previewLoading}
      />
    </VStack>
  );
}
