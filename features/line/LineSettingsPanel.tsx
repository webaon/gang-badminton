'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';

import {
  clearLineCredentials,
  saveLineCredentials,
  setLineEnabled,
  testLineConnection,
  type LineStatus,
} from '@/server/actions/line';

/**
 * ตั้งค่า LINE ของก๊วน — **[WO-4.A]**
 *
 * 🔴 ช่อง token/secret **ว่างเสมอตอนเปิดหน้า** — ค่าที่ตั้งไว้แล้วอ่านกลับมาไม่ได้เลย
 *    (ฐานข้อมูลคืนให้แค่ 4 ตัวท้าย) ⇒ กรอกใหม่ = หมุนค่าใหม่ · เว้นว่าง = คงของเดิม
 */
export function LineSettingsPanel({ gangId, initial }: { gangId: string; initial: LineStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [accessToken, setAccessToken] = useState('');
  const [channelSecret, setChannelSecret] = useState('');
  const [liffId, setLiffId] = useState(initial.liffId ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isConfigured = status.hasAccessToken && status.hasChannelSecret;

  async function run<T>(
    fn: () => Promise<{ success: boolean; data?: T; error?: { message: string } }>,
    onOk?: (data: T) => void,
  ) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await fn();
    if (result.success) {
      onOk?.(result.data as T);
      router.refresh();
    } else {
      setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');
    }

    setPending(false);
    return result.success;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    await run<LineStatus>(
      () =>
        saveLineCredentials(gangId, {
          // เว้นว่าง = ไม่ส่งไปเลย ⇒ DB คงค่าเดิมไว้
          ...(accessToken.trim() === '' ? {} : { accessToken: accessToken.trim() }),
          ...(channelSecret.trim() === '' ? {} : { channelSecret: channelSecret.trim() }),
          liffId: liffId.trim(),
        }),
      (next) => {
        setStatus(next);
        setAccessToken('');
        setChannelSecret('');
        setNotice('บันทึกแล้ว — เก็บไว้ใน Vault ไม่ได้เก็บเป็นข้อความธรรมดา');
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">LINE ของก๊วน</h2>
        <Badge
          label={
            status.isEnabled ? 'เปิดใช้งานอยู่' : isConfigured ? 'ตั้งค่าแล้ว (ปิดอยู่)' : 'ยังไม่ได้ตั้งค่า'
          }
        />
      </div>

      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      <p className="text-sm">
        เอา Channel access token กับ Channel secret มาจาก LINE Developers Console →
        Messaging API ของ OA ก๊วนคุณ
      </p>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <TextInput
          label="Channel access token"
          type="password"
          value={accessToken}
          onChange={setAccessToken}
          placeholder={
            status.hasAccessToken ? `ตั้งไว้แล้ว (ลงท้าย ${status.tokenLast4}) — เว้นว่างเพื่อคงเดิม` : 'วางค่าที่นี่'
          }
        />
        <TextInput
          label="Channel secret"
          type="password"
          value={channelSecret}
          onChange={setChannelSecret}
          placeholder={
            status.hasChannelSecret
              ? `ตั้งไว้แล้ว (ลงท้าย ${status.secretLast4}) — เว้นว่างเพื่อคงเดิม`
              : 'วางค่าที่นี่'
          }
        />
        <TextInput
          label="LIFF ID (ใส่ทีหลังได้)"
          value={liffId}
          onChange={setLiffId}
          placeholder="เช่น 1234567890-abcdefgh"
        />

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" label="บันทึก" isLoading={pending} />

          {isConfigured ? (
            <>
              <Button
                label="ทดสอบการเชื่อมต่อ"
                isDisabled={pending}
                onClick={() =>
                  run<{ displayName: string; basicId: string }>(
                    () => testLineConnection(gangId),
                    (info) =>
                      setNotice(
                        `เชื่อมต่อได้: ${info.displayName}${info.basicId ? ` (${info.basicId})` : ''}`,
                      ),
                  )
                }
              />
              <Button
                label={status.isEnabled ? 'ปิดใช้งาน LINE' : 'เปิดใช้งาน LINE'}
                isDisabled={pending}
                onClick={() =>
                  run<{ isEnabled: boolean }>(
                    () => setLineEnabled(gangId, !status.isEnabled),
                    (next) => {
                      setStatus((s) => ({ ...s, isEnabled: next.isEnabled }));
                      setNotice(next.isEnabled ? 'เปิดใช้งาน LINE แล้ว' : 'ปิดใช้งาน LINE แล้ว');
                    },
                  )
                }
              />
              <Button
                variant="ghost"
                label="ถอด LINE ออก"
                isDisabled={pending}
                onClick={() =>
                  run<LineStatus>(
                    () => clearLineCredentials(gangId),
                    (next) => {
                      setStatus(next);
                      setLiffId('');
                      setNotice('ถอด LINE ออกแล้ว — ลบ credentials ออกจาก Vault ด้วย');
                    },
                  )
                }
              />
            </>
          ) : null}
        </div>
      </form>

      <p className="text-xs opacity-70">
        เปิดใช้งานได้เมื่อตั้ง token และ secret ครบแล้วเท่านั้น · การแจ้งเตือนในแอปยังทำงานเหมือนเดิม
        ไม่ว่าจะต่อ LINE หรือไม่
      </p>
    </div>
  );
}
