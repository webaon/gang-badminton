'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FileInput } from '@astryxdesign/core/FileInput';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import {
  SLIP_PICKER_ACCEPT,
  SLIP_PROBLEM_TEXT,
  checkSlipFile,
  formatFileSize,
} from '@/domain/payments/pay-view';
import { actionError } from '@/lib/i18n/error-text';
import { supabaseBrowser } from '@/lib/supabase/client';
import { prepareSlipUpload, submitSlip } from '@/server/actions/payments';

/**
 * อัปสลิป (hi-fi 31) — **[WO-6.3]** เลือกไฟล์ → ดูตัวอย่าง → กด "ส่งสลิป"
 *
 * 🔴 [D-15] **server เป็นคนบอก path** — client แค่อัปโหลดไปที่ path ที่ได้มา
 *    สิทธิ์ของ storage ตรวจจาก path ⇒ ให้ client ตั้งเอง = ให้ client เลือกสิทธิ์เอง
 *
 * ตรวจชนิด/ขนาดฝั่ง client (≤ 5MB · jpeg/png/webp/pdf ตรงกับ bucket) เพื่อบอกผู้ใช้เร็วด้วยข้อความไทยคงที่ —
 * storage/DB ยังเป็นด่านจริง · ไม่มีแถบ % (supabase-js ไม่ให้ progress) จึงโชว์ "กำลังอัปโหลด…" อย่างเดียว
 * ปุ่มถ่ายรูป: `accept="image/*"` บนมือถือเปิดตัวเลือกกล้องของระบบให้เอง (FileInput ไม่รับ `capture`)
 */
export function PaySlipForm({ paymentId, status }: { paymentId: string; status: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // ตัวอย่างรูป (blob URL) — คืนหน่วยความจำทุกครั้งที่เปลี่ยน/ถอดไฟล์
  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function onPick(next: File | File[] | null) {
    const picked = Array.isArray(next) ? (next[0] ?? null) : next;
    setError(null);

    if (!picked) {
      setFile(null);
      setProblem(null);
      return;
    }

    const found = checkSlipFile(picked);
    if (found) {
      setFile(null);
      setProblem(SLIP_PROBLEM_TEXT[found]);
      return;
    }
    setProblem(null);
    setFile(picked);
  }

  async function send() {
    if (!file) return;
    setPending(true);
    setError(null);

    try {
      const prepared = await prepareSlipUpload(paymentId, file.name);
      if (!prepared.success) {
        setError(actionError(prepared.error));
        return;
      }

      const { error: uploadError } = await supabaseBrowser()
        .storage.from(prepared.data.bucket)
        .upload(prepared.data.path, file, { upsert: true });

      if (uploadError) {
        // ❌ ไม่ render ข้อความของ Supabase Storage (อังกฤษ/รายละเอียดภายใน) — log ต้นฉบับไว้ไม่กลืนเงียบ
        console.warn('[slip-upload] อัปโหลดขึ้น storage ไม่สำเร็จ', uploadError);
        setError('อัปโหลดสลิปไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง');
        return;
      }

      const submitted = await submitSlip(paymentId, prepared.data.path);
      if (submitted.success) {
        setFile(null);
        router.refresh();
      } else {
        setError(actionError(submitted.error));
      }
    } catch {
      // network/5xx — ไม่ปล่อยให้ปุ่มค้างเป็น "กำลังอัปโหลด" ตลอดไป
      setError(actionError({ code: 'INTERNAL_ERROR', message: '' }));
    } finally {
      setPending(false);
    }
  }

  if (status === 'verified') {
    return <Banner status="success" title="ยืนยันการจ่ายแล้ว" />;
  }

  return (
    <VStack gap={3}>
      <FileInput
        mode="dropzone"
        label={status === 'rejected' ? 'อัปสลิปใหม่' : 'เลือกรูปสลิปโอนเงิน'}
        description="JPG, PNG, WebP หรือ PDF ไม่เกิน 5MB"
        placeholder="แตะเพื่อเลือกรูปสลิป"
        accept={SLIP_PICKER_ACCEPT}
        value={file}
        onChange={onPick}
        isDisabled={pending}
        status={problem ? { type: 'error', message: problem } : undefined}
      />

      {file ? (
        <VStack gap={2} align="center">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="ตัวอย่างสลิป" className="max-h-72 w-auto rounded-lg" />
          ) : null}
          <Text type="supporting" size="sm">
            {file.name} · {formatFileSize(file.size)}
          </Text>
        </VStack>
      ) : null}

      {error ? <Banner status="error" title="ส่งสลิปไม่สำเร็จ" description={error} /> : null}

      <Button
        variant="primary"
        size="lg"
        width="100%"
        label={pending ? 'กำลังอัปโหลด…' : 'ส่งสลิป'}
        isLoading={pending}
        isDisabled={!file || pending}
        onClick={send}
      />
    </VStack>
  );
}
