'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { AdjustmentType } from '@/domain/billing/ledger';
import { addChargeAdjustment, createPaymentForCharges } from '@/server/actions/payments';

export type LedgerRow = {
  chargeId: string;
  displayName: string;
  /** null = guest (ไม่มีบัญชี ⇒ เป็นผู้จ่ายเองไม่ได้) */
  userId: string | null;
  label: string;
  charge: string;
  allocated: string;
  adjusted: string;
  outstanding: string;
};

const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  refund: 'คืนเงิน',
  correction: 'แก้ยอด',
  credit: 'ให้เครดิต',
};

/**
 * ยอดค้างรายคน — **[WO-2.5-D]**
 *
 * 🔴 ตัวเลขทุกช่องมาจาก ledger (`charge − allocations + adjustments`)
 *    ❌ ไม่ได้อ่านจาก `payments.status` — สลิปใบเดียวครอบหนี้ได้หลายคน
 *    และ refund ไม่ได้เปลี่ยน status ของอะไรเลย (baseline §การตัดสินใจสะสม)
 *
 * ทำสองอย่างจากที่เดียว: รวมหลายคนเป็นสลิปใบเดียว (จ่ายแทนเพื่อน) · ปรับยอดย้อนหลัง
 */
export function LedgerPanel({
  gangId,
  rows,
  payers,
}: {
  gangId: string;
  rows: LedgerRow[];
  /** คนที่เป็นผู้จ่ายได้ — สมาชิกก๊วนที่มีบัญชี */
  payers: { userId: string; displayName: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payer, setPayer] = useState<string>(payers[0]?.userId ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** charge ที่กำลังเปิดฟอร์มปรับยอด */
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [adjustType, setAdjustType] = useState<AdjustmentType>('refund');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  function toggle(chargeId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chargeId)) next.delete(chargeId);
      else next.add(chargeId);
      return next;
    });
  }

  async function run(fn: () => Promise<{ success: boolean; error?: { message: string } }>) {
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await fn();
    if (result.success) router.refresh();
    else setError(result.error?.message ?? 'ทำรายการไม่สำเร็จ');

    setPending(false);
    return result.success;
  }

  async function onCombine() {
    if (payer === '') {
      setError('เลือกคนจ่ายก่อน');
      return;
    }

    const ok = await run(async () => {
      const result = await createPaymentForCharges(gangId, [...selected], payer);
      if (result.success) {
        setNotice(`ออกใบจ่ายรวม ${result.data.amount} บาท (${selected.size} รายการ)`);
      }
      return result;
    });

    if (ok) setSelected(new Set());
  }

  async function onAdjust(chargeId: string) {
    const ok = await run(() =>
      addChargeAdjustment(chargeId, {
        type: adjustType,
        amount: adjustAmount,
        reason: adjustReason,
      }),
    );

    if (ok) {
      setAdjusting(null);
      setAdjustAmount('');
      setAdjustReason('');
      setNotice('บันทึกรายการปรับยอดแล้ว');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Banner status="error" title={error} /> : null}
      {notice ? (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm">ยังไม่มียอดเรียกเก็บในก๊วนนี้</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const outstanding = Number(row.outstanding);

            return (
              <li key={row.chargeId} className="py-3">
                <div className="flex items-start gap-3">
                  {outstanding > 0 ? (
                    <CheckboxInput
                      label={`เลือก ${row.displayName}`}
                      isLabelHidden
                      size="sm"
                      value={selected.has(row.chargeId)}
                      isDisabled={pending}
                      onChange={() => toggle(row.chargeId)}
                    />
                  ) : (
                    <span className="w-5" />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{row.displayName}</p>
                    <p className="text-xs opacity-70">{row.label}</p>
                    <p className="text-xs opacity-70">
                      เรียกเก็บ {row.charge} · จ่ายแล้ว {row.allocated}
                      {row.adjusted !== '0.00' ? ` · ปรับยอด ${row.adjusted}` : ''}
                    </p>
                  </div>

                  <div className="text-right">
                    {outstanding > 0 ? (
                      <span className="font-semibold">ค้าง {row.outstanding}</span>
                    ) : outstanding < 0 ? (
                      <Badge label={`ต้องคืน ${row.outstanding.replace('-', '')}`} />
                    ) : (
                      <Badge label="ครบแล้ว" />
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    label="ปรับยอด"
                    isDisabled={pending}
                    onClick={() => setAdjusting(adjusting === row.chargeId ? null : row.chargeId)}
                  />
                </div>

                {adjusting === row.chargeId ? (
                  <div className="mt-3 rounded-lg border p-3">
                    <RadioList
                      label="ประเภท"
                      orientation="horizontal"
                      size="sm"
                      value={adjustType}
                      onChange={(v) => setAdjustType(v as AdjustmentType)}
                    >
                      {(['refund', 'correction', 'credit'] as AdjustmentType[]).map((t) => (
                        <RadioListItem key={t} label={ADJUSTMENT_LABELS[t]} value={t} />
                      ))}
                    </RadioList>

                    <div className="mt-2 flex items-end gap-2">
                      <div className="w-32">
                        <TextInput
                          label="จำนวนเงิน"
                          size="sm"
                          value={adjustAmount}
                          onChange={setAdjustAmount}
                          description={adjustType === 'correction' ? 'บวก = เพิ่มหนี้' : 'ใส่ค่าติดลบ'}
                        />
                      </div>
                      <div className="flex-1">
                        <TextInput
                          label="เหตุผล"
                          size="sm"
                          value={adjustReason}
                          onChange={setAdjustReason}
                          placeholder="เช่น มาไม่ทันครึ่งหลัง"
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        label="บันทึก"
                        isDisabled={pending}
                        onClick={() => onAdjust(row.chargeId)}
                      />
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/*
        จ่ายแทนเพื่อน: เลือกหลายคน → ออกใบเดียว
        ยอดของใบ = ผลรวม "ยอดค้างจริง" ที่ฐานข้อมูลคำนวณ ไม่ใช่ตัวเลขจากหน้าจอ
      */}
      {selected.size > 0 ? (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-sm font-medium">รวมเป็นสลิปใบเดียว ({selected.size} รายการ)</p>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Selector
                label="คนจ่าย"
                size="sm"
                options={payers.map((p) => ({ value: p.userId, label: p.displayName }))}
                value={payer}
                onChange={setPayer}
              />
            </div>
            <Button
              size="sm"
              variant="primary"
              label="ออกใบจ่ายรวม"
              isDisabled={pending}
              onClick={onCombine}
            />
            <Button size="sm" label="ล้าง" onClick={() => setSelected(new Set())} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
