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
  sendLineTestMessage,
  setLineEnabled,
  saveLineLoginCredentials,
  setLineQuota,
  testLineConnection,
  type LineLoginStatus,
  type LineStatus,
  type LineUsage,
} from '@/server/actions/line';

/**
 * ตั้งค่า LINE ของก๊วน — **[WO-4.A]**
 *
 * 🔴 ช่อง token/secret **ว่างเสมอตอนเปิดหน้า** — ค่าที่ตั้งไว้แล้วอ่านกลับมาไม่ได้เลย
 *    (ฐานข้อมูลคืนให้แค่ 4 ตัวท้าย) ⇒ กรอกใหม่ = หมุนค่าใหม่ · เว้นว่าง = คงของเดิม
 */
export function LineSettingsPanel({
  gangId,
  initial,
  usage,
  login,
}: {
  gangId: string;
  initial: LineStatus;
  usage: LineUsage | null;
  login: LineLoginStatus | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [quota, setQuota] = useState(usage?.monthlyQuota?.toString() ?? '');
  const [loginStatus, setLoginStatus] = useState(login);
  const [loginChannelId, setLoginChannelId] = useState(login?.loginChannelId ?? '');
  const [loginSecret, setLoginSecret] = useState('');
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
                label="ส่งข้อความทดสอบ"
                isDisabled={pending || !status.isEnabled}
                onClick={() =>
                  run<{ sent: number; failed: number }>(
                    () => sendLineTestMessage(gangId),
                    (result) =>
                      setNotice(
                        result.sent > 0
                          ? 'ส่งข้อความทดสอบแล้ว — เช็คในแชต LINE ของคุณ (นับรวมโควต้าเดือนนี้)'
                          : 'เข้าคิวแล้วแต่ส่งไม่สำเร็จ — ดูสาเหตุที่ log หรือลองผูกบัญชี LINE ของตัวเองก่อน',
                      ),
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

      {/* [WO-4.D] LINE Login — คนละ channel กับ Messaging API */}
      <div className="border-t pt-3">
        <h3 className="mb-1 text-sm font-semibold">
          LINE Login {loginStatus?.hasLoginChannel ? '(ตั้งค่าแล้ว)' : '(ยังไม่ได้ตั้งค่า)'}
        </h3>
        <p className="mb-2 text-xs opacity-70">
          ⚠️ เป็น <strong>คนละ channel</strong> กับ Messaging API — ต้องอยู่ provider เดียวกัน
          ไม่งั้น LINE จะให้ id คนละใบแล้วผูกบัญชีได้แต่ส่งข้อความไม่ถึง ·
          ตั้งค่านี้แล้วสมาชิกกดผูกบัญชีได้ในปุ่มเดียว ไม่ต้องคัดลอกรหัส
        </p>

        <div className="flex flex-col gap-2">
          <TextInput
            label="Login channel ID"
            value={loginChannelId}
            onChange={setLoginChannelId}
            placeholder="เช่น 2001234567"
          />
          <TextInput
            label="Login channel secret"
            type="password"
            value={loginSecret}
            onChange={setLoginSecret}
            placeholder={
              loginStatus?.secretLast4
                ? `ตั้งไว้แล้ว (ลงท้าย ${loginStatus.secretLast4}) — เว้นว่างเพื่อคงเดิม`
                : 'วางค่าที่นี่'
            }
          />
          <div>
            <Button
              size="sm"
              label="บันทึก LINE Login"
              isDisabled={pending}
              onClick={() =>
                run<LineLoginStatus>(
                  () =>
                    saveLineLoginCredentials(gangId, {
                      channelId: loginChannelId.trim(),
                      ...(loginSecret.trim() === '' ? {} : { channelSecret: loginSecret.trim() }),
                    }),
                  (next) => {
                    setLoginStatus(next);
                    setLoginSecret('');
                    setNotice('บันทึก LINE Login แล้ว');
                  },
                )
              }
            />
          </div>
          <p className="text-xs opacity-70">
            ตั้ง Callback URL ใน LINE Developers Console เป็น{' '}
            <code>{'<โดเมนของคุณ>'}/api/line/login/callback</code>
            {' · '}[WO-4.E] ถ้าจะทำ LIFF ให้ตั้ง Endpoint URL เป็น{' '}
            <code>{`<โดเมนของคุณ>/gangs/${gangId}/liff`}</code> แล้วเอา LIFF ID มาใส่ด้านบน
          </p>
        </div>
      </div>

      {usage ? (
        <div className="border-t pt-3">
          <h3 className="mb-1 text-sm font-semibold">โควต้าเดือนนี้</h3>
          <p className="text-sm">
            ส่งไปแล้ว <strong>{usage.used.toLocaleString('th-TH')}</strong> ข้อความ
            {usage.monthlyQuota === null
              ? ' (ไม่จำกัด)'
              : ` จาก ${usage.monthlyQuota.toLocaleString('th-TH')}`}
            {' · '}เริ่มนับ {usage.periodStart}
          </p>

          {usage.isOver ? (
            <Banner
              status="warning"
              title="เกินโควต้าของเดือนนี้แล้ว"
              description="ระบบจะหยุดส่ง LINE จนถึงเดือนหน้า — การแจ้งเตือนในแอปยังส่งตามปกติ"
            />
          ) : null}

          <div className="mt-2 flex items-end gap-2">
            <div className="grow">
              <TextInput
                label="เพดานต่อเดือน (เว้นว่าง = ไม่จำกัด)"
                value={quota}
                onChange={setQuota}
                placeholder="เช่น 200"
              />
            </div>
            <Button
              size="sm"
              label="บันทึกเพดาน"
              isDisabled={pending}
              onClick={() =>
                run<{ monthlyQuota: number | null }>(
                  () => setLineQuota(gangId, quota.trim() === '' ? null : Number(quota.trim())),
                  () => setNotice('บันทึกเพดานแล้ว'),
                )
              }
            />
          </div>

          <p className="mt-1 text-xs opacity-70">
            นับจากข้อความที่ส่งสำเร็จจริงเท่านั้น (ส่งไม่สำเร็จไม่กินโควต้า) · ปุ่ม “ทดสอบการเชื่อมต่อ”
            ไม่กินโควต้า แต่ “ส่งข้อความทดสอบ” กิน
          </p>
        </div>
      ) : null}

      <p className="text-xs opacity-70">
        เปิดใช้งานได้เมื่อตั้ง token และ secret ครบแล้วเท่านั้น · การแจ้งเตือนในแอปยังทำงานเหมือนเดิม
        ไม่ว่าจะต่อ LINE หรือไม่
      </p>
    </div>
  );
}
