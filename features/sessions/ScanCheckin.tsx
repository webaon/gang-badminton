'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { checkInByQr } from '@/server/actions/game-console';

type Result =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; displayName: string; already: boolean }
  | { kind: 'error'; message: string };

/**
 * ผลการสแกน QR เช็คอิน — **[WO-2.5-F]**
 *
 * 🔴 เช็คอินผ่าน **server action (POST)** ไม่ใช่ผลข้างเคียงตอน render หน้า
 *    หน้า GET ที่เปลี่ยนข้อมูล = กดรีเฟรชแล้วทำซ้ำ และถูก prefetch ยิงโดยไม่ตั้งใจได้
 *
 * 🔴 ล้าง `?c=` ออกจาก URL ทันทีที่ยิงเสร็จ ⇒ token ไม่ค้างในประวัติ/แถบที่อยู่
 *    ของเครื่องแอดมิน (แนวเดียวกับ cookie ของ guest ในใบเดียวกันนี้)
 */
export function ScanCheckin({
  sessionId,
  gangId,
  token,
}: {
  sessionId: string;
  gangId: string;
  token: string | null;
}) {
  const router = useRouter();
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  /** กัน StrictMode ยิงสองรอบตอน dev */
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;

    setResult({ kind: 'working' });

    checkInByQr(sessionId, token).then((response) => {
      setResult(
        response.success
          ? {
              kind: 'done',
              displayName: response.data.displayName,
              already: response.data.already,
            }
          : { kind: 'error', message: response.error.message },
      );

      // ทิ้ง token ออกจาก URL ไม่ว่าผลจะเป็นอย่างไร
      router.replace(`/gangs/${gangId}/sessions/${sessionId}/scan`);
    });
  }, [token, sessionId, gangId, router]);

  return (
    <div className="flex flex-col gap-3">
      {result.kind === 'idle' ? (
        <Banner
          status="info"
          title="พร้อมสแกน"
          description="เปิดกล้องของเครื่อง แล้วสแกน QR ของผู้เล่น — หน้านี้จะเช็คอินให้อัตโนมัติ"
        />
      ) : null}

      {result.kind === 'working' ? <Banner status="info" title="กำลังเช็คอิน…" /> : null}

      {result.kind === 'done' ? (
        <Banner
          status="success"
          title={result.already ? `${result.displayName} เช็คอินไปแล้ว` : `เช็คอิน ${result.displayName} แล้ว`}
          description={result.already ? 'สแกนซ้ำไม่ได้เปลี่ยนอะไร' : undefined}
        />
      ) : null}

      {result.kind === 'error' ? <Banner status="error" title={result.message} /> : null}

      <div className="flex gap-2">
        <Button
          label="ไปที่คอนโซล"
          onClick={() => router.push(`/gangs/${gangId}/sessions/${sessionId}/console`)}
        />
        {result.kind !== 'idle' ? (
          <Button
            label="สแกนคนถัดไป"
            variant="primary"
            onClick={() => {
              fired.current = false;
              setResult({ kind: 'idle' });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
