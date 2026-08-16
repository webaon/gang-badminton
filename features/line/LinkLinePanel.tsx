'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';

import { issueLineLinkCode, unlinkMyLineAccount, type MyLineLink } from '@/server/actions/line';

/**
 * ผูกบัญชี LINE ของตัวเองเข้ากับก๊วน — **[WO-4.B]**
 *
 * วิธีทำงาน: กดขอรหัส → คัดลอกไปวางในแชตของ OA ก๊วนนั้น → webhook ผูกให้
 *
 * ⚠️ ยัง **ไม่มีข้อความตอบกลับในแชต** (ต้องยิง reply API ซึ่งใบนี้ห้ามทำใน request ของ webhook)
 *    ⇒ ผู้ใช้กด "ตรวจสถานะ" ที่หน้านี้เพื่อดูผล · `WO-4.D` (LINE Login) จะทำให้ไม่ต้องคัดลอกรหัสเลย
 */
export function LinkLinePanel({ gangId, initial }: { gangId: string; initial: MyLineLink }) {
  const router = useRouter();
  const [code, setCode] = useState<{ value: string; expiresAt: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run<T>(
    fn: () => Promise<{ success: boolean; data?: T; error?: { message: string } }>,
    onOk?: (data: T) => void,
  ) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await fn();
    if (result.success) onOk?.(result.data as T);
    else setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');

    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">เชื่อมต่อ LINE</h1>
        <Badge
          label={
            initial.isBlocked
              ? 'บล็อก OA อยู่'
              : initial.isLinked
                ? 'ผูกบัญชีแล้ว'
                : 'ยังไม่ได้ผูก'
          }
        />
      </div>

      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {initial.isBlocked ? (
        <Banner
          status="warning"
          title="คุณบล็อกหรือลบเพื่อน LINE OA ของก๊วนไว้"
          description="ระบบจะไม่ส่งข้อความ LINE ให้จนกว่าจะกดเพิ่มเพื่อนกลับ (การแจ้งเตือนในแอปยังทำงานปกติ)"
        />
      ) : null}

      {initial.isLinked ? (
        <>
          <p className="text-sm">
            ผูกบัญชีไว้แล้ว
            {initial.linkedAt
              ? ` เมื่อ ${new Date(initial.linkedAt).toLocaleDateString('th-TH')}`
              : ''}
          </p>
          <div>
            <Button
              variant="ghost"
              label="เลิกผูกบัญชี"
              isDisabled={pending}
              onClick={() =>
                run<{ removed: boolean }>(
                  () => unlinkMyLineAccount(gangId),
                  () => {
                    setNotice('เลิกผูกแล้ว');
                    router.refresh();
                  },
                )
              }
            />
          </div>
        </>
      ) : (
        <>
          <ol className="ml-4 list-decimal text-sm">
            <li>เพิ่มเพื่อน LINE OA ของก๊วน (ถามแอดมินถ้ายังไม่มีลิงก์)</li>
            <li>กดปุ่มด้านล่างเพื่อขอรหัส แล้วคัดลอกไปวางในแชตกับ OA</li>
            <li>กลับมากด “ตรวจสถานะ” เพื่อดูผล</li>
          </ol>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              label="ขอรหัสผูกบัญชี"
              isLoading={pending}
              onClick={() =>
                run<{ code: string; expiresAt: string }>(
                  () => issueLineLinkCode(gangId),
                  (data) => setCode({ value: data.code, expiresAt: data.expiresAt }),
                )
              }
            />
            <Button label="ตรวจสถานะ" isDisabled={pending} onClick={() => router.refresh()} />
          </div>

          {code ? (
            <Card padding={4} variant="muted">
              <p className="mb-2 text-sm">คัดลอกข้อความนี้ไปส่งในแชตกับ OA ของก๊วน:</p>
              <code className="block break-all text-sm">{code.value}</code>
              <p className="mt-2 text-xs opacity-70">
                หมดอายุ {new Date(code.expiresAt).toLocaleTimeString('th-TH')} — ขอใหม่ได้เรื่อยๆ
              </p>
              <div className="mt-2">
                <Button
                  size="sm"
                  label="คัดลอก"
                  onClick={() => {
                    void navigator.clipboard?.writeText(code.value);
                    setNotice('คัดลอกแล้ว');
                  }}
                />
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
