'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';

import { cancelRegistration, registerSelf } from '@/server/actions/registrations';

import type { LiffSessionView } from '@/server/line/liff';

const STATUS_LABELS: Record<string, string> = {
  confirmed: 'ได้ที่แล้ว',
  waitlist: 'อยู่ในคิวรอ',
  checked_in: 'เช็คอินแล้ว',
};

/**
 * หน้าจอย่อสำหรับเปิดในแอป LINE (LIFF) — **[WO-4.E]**
 *
 * 🔴 **ไม่มี endpoint พิเศษของ LIFF** — ปุ่มทุกปุ่มเรียก server action ตัวเดียวกับหน้าเว็บปกติ
 *    (`registerSelf()` / `cancelRegistration()`) ⇒ `can()` + DB function + RLS
 *    ยังเป็นด่านเดิมทุกชั้น · หน้านี้เป็นแค่ "หน้าจออีกใบ" จริงๆ
 *
 * ⚠️ ออกแบบสำหรับจอแคบ: การ์ดเรียงแนวตั้ง ปุ่มเต็มความกว้าง ไม่มีตาราง
 */
export function LiffPanel({
  gangId,
  sessions,
  outstanding,
}: {
  gangId: string;
  sessions: LiffSessionView[];
  outstanding: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(
    fn: () => Promise<{ success: boolean; error?: { message: string } }>,
    okMessage: string,
  ) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await fn();
    if (result.success) {
      setNotice(okMessage);
      router.refresh();
    } else {
      setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');
    }

    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {outstanding !== '0.00' ? (
        <Card padding={4} variant="muted">
          <p className="text-sm">
            ยอดที่ต้องจ่าย <strong>{outstanding} บาท</strong>
          </p>
          <p className="mt-1 text-xs opacity-70">เปิดหน้าเก็บเงินในแอปเพื่อดู QR และแนบสลิป</p>
          <div className="mt-2">
            <Button
              size="sm"
              label="ไปหน้าเก็บเงิน"
              onClick={() => router.push(`/gangs/${gangId}/payments`)}
            />
          </div>
        </Card>
      ) : null}

      <h2 className="text-base font-semibold">นัดที่เปิดรับอยู่</h2>

      {sessions.length === 0 ? (
        <p className="text-sm">ยังไม่มีนัดที่เปิดรับสมัคร</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sessions.map((session) => (
            <li key={session.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{session.title}</p>
                    <p className="text-sm">
                      {new Date(session.startsAt).toLocaleString('th-TH', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                    {session.venue ? <p className="text-sm">{session.venue}</p> : null}
                  </div>
                  {session.myRegistration ? (
                    <Badge
                      label={
                        STATUS_LABELS[session.myRegistration.status] ?? session.myRegistration.status
                      }
                    />
                  ) : (
                    <Badge
                      label={session.seatsLeft > 0 ? `ว่าง ${session.seatsLeft}` : 'เต็ม (มีคิวรอ)'}
                    />
                  )}
                </div>

                <div className="mt-3">
                  {session.myRegistration ? (
                    <Button
                      label="ยกเลิกการลงชื่อ"
                      variant="ghost"
                      isDisabled={pending}
                      onClick={() =>
                        run(
                          () => cancelRegistration(session.myRegistration!.id),
                          'ยกเลิกแล้ว',
                        )
                      }
                    />
                  ) : (
                    <Button
                      variant="primary"
                      label={session.seatsLeft > 0 ? 'ลงชื่อเล่น' : 'เข้าคิวรอ'}
                      isDisabled={pending}
                      onClick={() =>
                        run(
                          () => registerSelf(session.id),
                          session.seatsLeft > 0 ? 'ลงชื่อแล้ว' : 'เข้าคิวรอแล้ว',
                        )
                      }
                    />
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
