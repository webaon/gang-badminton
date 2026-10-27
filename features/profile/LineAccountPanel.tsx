'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

import { pickProfileBanner, type LineAccountState } from '@/lib/line/identity';
import { parseLineProfileStatus, type LineProfileStatus } from '@/lib/line/platform-login';
import { startLineLink, unlinkLineAccount } from '@/server/actions/line-identity';

/**
 * ผูก/ถอด LINE กับบัญชี (ใช้เข้าสู่ระบบ) — **[WO-B1.c · ADR-013]**
 *
 * 🔴 ปุ่มผูกเป็น `onClick → window.location.href` เท่านั้น ห้ามทำเป็นฟอร์มแบบ action (CSP `form-action 'self'`)
 * 🔴 `?line=` ผ่าน `parseLineProfileStatus()` — whitelist เท่านั้น ไม่ echo ค่าที่ส่งมา
 *    และแบนเนอร์ "ผูกแล้ว" แสดงเมื่อสถานะจริง (`state.linked`) เป็น true ด้วยเท่านั้น (พิมพ์ URL เองไม่ทำให้ขึ้นเท็จ)
 * ⚠️ คนละเรื่องกับ "ผูก LINE ต่อก๊วน" (รับแจ้งเตือน) — อธิบายไว้ในข้อความให้ชัด (ADR-013 §5)
 */
const STATUS_BANNERS: Record<LineProfileStatus, { status: 'success' | 'error' | 'info'; title: string }> = {
  linked: { status: 'success', title: 'ผูกบัญชี LINE แล้ว — ครั้งหน้าเข้าสู่ระบบด้วย LINE ได้เลย' },
  unlinked: { status: 'info', title: 'ถอดบัญชี LINE ออกแล้ว' },
  denied: { status: 'info', title: 'ยกเลิกการผูกบัญชี LINE แล้ว' },
  in_use: { status: 'error', title: 'บัญชี LINE นี้ถูกใช้กับบัญชีอื่นไปแล้ว' },
  failed: { status: 'error', title: 'ผูกบัญชี LINE ไม่สำเร็จ ลองใหม่อีกครั้ง' },
};

export function LineAccountPanel({ initial }: { initial: LineAccountState }) {
  const router = useRouter();
  const params = useSearchParams();

  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<LineProfileStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const fromUrl = parseLineProfileStatus(params.get('line'));
  const shown = pickProfileBanner(localStatus, fromUrl, state.linked);
  const banner = shown ? STATUS_BANNERS[shown] : null;

  async function onLink() {
    setPending(true);
    setError(null);

    const result = await startLineLink();

    if (result.success) {
      // ไม่ปลด pending — กำลังพาออกไปหน้า LINE
      window.location.href = result.data.url;
    } else {
      setError(actionError(result.error));
      setPending(false);
    }
  }

  async function onUnlink() {
    setPending(true);
    setError(null);

    const result = await unlinkLineAccount();

    if (result.success) {
      setState({ ...state, linked: false, canUnlink: false, linkedAt: null, lineName: null });
      setLocalStatus('unlinked');
      setConfirming(false);
      router.refresh();
    } else {
      setError(actionError(result.error));
    }
    setPending(false);
  }

  return (
    <section aria-labelledby="line-account-title" className="mt-6 border-t pt-4">
      <h2 id="line-account-title" className="mb-1 text-base font-semibold">
        เข้าสู่ระบบด้วย LINE
      </h2>
      <p className="mb-3 text-sm">
        ผูกบัญชี LINE กับบัญชีนี้เพื่อเข้าสู่ระบบได้โดยไม่ต้องใช้รหัสผ่าน และใช้กู้บัญชีเมื่อลืมรหัสผ่าน ·
        การรับแจ้งเตือนจากก๊วนยังต้องผูกที่หน้า LINE ของแต่ละก๊วนแยกต่างหาก
      </p>

      {banner ? (
        <div className="mb-3">
          <Banner status={banner.status} title={banner.title} />
        </div>
      ) : null}
      {error ? (
        <div className="mb-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}

      {state.linked ? (
        <div>
          <p className="mb-3 text-sm">
            ผูกแล้ว{state.lineName ? ` · ${state.lineName}` : ''}
          </p>

          {!state.canUnlink ? (
            <p className="text-sm">
              ถอดไม่ได้ เพราะ LINE เป็นวิธีเข้าสู่ระบบเดียวของบัญชีนี้
            </p>
          ) : confirming ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                ถอดแล้วจะเข้าสู่ระบบด้วย LINE ไม่ได้ (ยังเข้าด้วยอีเมลและรหัสผ่านได้) — ยืนยันไหม
              </p>
              <div className="flex gap-2">
                <Button variant="primary" label="ยืนยันถอด LINE" onClick={onUnlink} isLoading={pending} />
                <Button
                  variant="ghost"
                  label="ยกเลิก"
                  onClick={() => setConfirming(false)}
                  isDisabled={pending}
                />
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              label="ถอดบัญชี LINE"
              onClick={() => setConfirming(true)}
              isDisabled={pending}
            />
          )}
        </div>
      ) : (
        <Button variant="primary" label="ผูกบัญชี LINE" onClick={onLink} isLoading={pending} />
      )}
    </section>
  );
}
