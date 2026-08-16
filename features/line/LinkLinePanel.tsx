'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';

import {
  issueLineLinkCode,
  startLineLogin,
  unlinkMyLineAccount,
  type MyLineLink,
} from '@/server/actions/line';

/**
 * ผูกบัญชี LINE ของตัวเองเข้ากับก๊วน — **[WO-4.B/4.D]**
 *
 * มีสองทาง:
 *   1. **LINE Login** (WO-4.D) — กดปุ่มเดียว ถ้าก๊วนตั้งค่า Login channel ไว้แล้ว
 *   2. **รหัสในแชต** (WO-4.B) — คัดลอกรหัสไปวางในแชตกับ OA (ทางสำรองที่ใช้ได้เสมอ)
 *
 * ✅ ทั้งสองทางลงเอยที่ `linkAndNotify()` ตัวเดียวกัน ⇒ ได้ข้อความยืนยันเหมือนกัน
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
          <p className="text-sm">
            เปิดหน้าย่อสำหรับใช้ในแอป LINE ได้ที่{' '}
            <a href={`/gangs/${gangId}/liff`} className="underline">
              ก๊วนของฉัน
            </a>
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
          {initial.loginAvailable ? (
            <>
              {/* [WO-4.D] ทางลัด: กดปุ่มเดียว ไม่ต้องคัดลอกรหัสไปวางในแชต */}
              <p className="text-sm">กดปุ่มเดียวจบ — อนุญาตในหน้า LINE แล้วระบบผูกให้เอง</p>
              <div>
                <Button
                  variant="primary"
                  label="ผูกบัญชีด้วย LINE"
                  isLoading={pending}
                  onClick={() =>
                    run<{ authorizeUrl: string }>(
                      () => startLineLogin(gangId),
                      (data) => {
                        window.location.href = data.authorizeUrl;
                      },
                    )
                  }
                />
              </div>
            </>
          ) : null}

          <p className="text-sm font-medium">
            {initial.loginAvailable ? 'หรือผูกด้วยรหัสในแชต' : 'วิธีผูกบัญชี'}
          </p>
          <ol className="ml-4 list-decimal text-sm">
            <li>เพิ่มเพื่อน LINE OA ของก๊วน (ถามแอดมินถ้ายังไม่มีลิงก์)</li>
            <li>กดปุ่มด้านล่างเพื่อขอรหัส แล้วคัดลอกไปวางในแชตกับ OA</li>
            <li>กลับมากด “ตรวจสถานะ” เพื่อดูผล</li>
          </ol>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={initial.loginAvailable ? 'secondary' : 'primary'}
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
