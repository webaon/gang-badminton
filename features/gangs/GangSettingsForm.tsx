'use client';

import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { TextInput } from '@astryxdesign/core/TextInput';

import { PENALTY_TYPES, type CancellationPolicy, type PenaltyType } from '@/domain/policies/cancellation';
import { updateGangSettings, type GangSettingsInput } from '@/server/actions/gangs';

const PENALTY_LABELS: Record<PenaltyType, string> = {
  full_share: 'จ่ายเต็มเหมือนมาเล่น',
  fixed: 'จ่ายจำนวนคงที่ (ยังไม่รองรับ)',
  percent: 'จ่ายเป็น % ของยอด (ยังไม่รองรับ)',
  none: 'ไม่คิดเงิน แค่บันทึกไว้',
};

export function GangSettingsForm({
  gangId,
  initial,
}: {
  gangId: string;
  initial: GangSettingsInput;
}) {
  const [form, setForm] = useState<GangSettingsInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  function patchPolicy(patch: Partial<CancellationPolicy>) {
    setForm((f) => ({ ...f, cancellationPolicy: { ...f.cancellationPolicy, ...patch } }));
  }

  const needsPenaltyValue =
    form.cancellationPolicy.penaltyType === 'fixed' ||
    form.cancellationPolicy.penaltyType === 'percent';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);

    const result = await updateGangSettings(gangId, form);

    if (result.success) setSaved(true);
    else setError(result.error.message);

    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormLayout direction="vertical">
        <TextInput
          label="ชื่อก๊วน"
          value={form.name}
          onChange={(name) => setForm((f) => ({ ...f, name }))}
          isRequired
        />
        <TextInput
          label="พื้นที่"
          value={form.area ?? ''}
          onChange={(area) => setForm((f) => ({ ...f, area: area || null }))}
          isOptional
        />
        <TextInput
          label="พร้อมเพย์"
          value={form.promptpayId ?? ''}
          onChange={(promptpayId) => setForm((f) => ({ ...f, promptpayId: promptpayId || null }))}
          isOptional
          description="เบอร์โทรหรือเลขบัตรประชาชนที่ใช้รับเงิน"
        />
        <Switch
          label="เปิดให้ค้นหาก๊วนได้"
          value={form.isPublic}
          onChange={(isPublic) => setForm((f) => ({ ...f, isPublic }))}
          description="คนนอกจะเห็นชื่อและพื้นที่ของก๊วน แต่ไม่เห็นสมาชิกหรือนัด"
        />
      </FormLayout>

      <h2 className="mt-6 mb-2 text-base font-semibold">กติกาการยกเลิก</h2>
      <FormLayout direction="vertical">
        <TextInput
          label="ยกเลิกฟรีก่อนเริ่มนัด (ชั่วโมง)"
          value={String(form.cancellationPolicy.cutoffHours)}
          onChange={(v) => patchPolicy({ cutoffHours: Number(v) || 0 })}
          description="ยกเลิกก่อนเวลานี้ไม่คิดเงิน"
        />
        <Selector
          label="ยกเลิกหลังเวลานี้ หรือไม่มา"
          options={PENALTY_TYPES.map((t) => ({ value: t, label: PENALTY_LABELS[t] }))}
          value={form.cancellationPolicy.penaltyType}
          onChange={(v) => patchPolicy({ penaltyType: v as PenaltyType })}
        />
        {needsPenaltyValue ? (
          <TextInput
            label={form.cancellationPolicy.penaltyType === 'percent' ? 'เปอร์เซ็นต์' : 'จำนวนเงิน'}
            value={form.cancellationPolicy.penaltyValue ?? ''}
            onChange={(penaltyValue) => patchPolicy({ penaltyValue })}
            isRequired
          />
        ) : null}
        {/* [WO-2.5-G] เวลาเตือน — 0 = ปิดการเตือนนั้น */}
        <TextInput
          label="เตือนก่อนถึงนัดกี่ชั่วโมง"
          value={String(form.reminder?.sessionHoursBefore ?? 24)}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              reminder: {
                sessionHoursBefore: Number(v) || 0,
                paymentDueAfterHours: f.reminder?.paymentDueAfterHours ?? 24,
              },
            }))
          }
          description="0 = ไม่เตือน · เตือนเฉพาะคนที่ได้ที่แล้ว"
        />
        <TextInput
          label="เตือนยอดค้างหลังนัดจบกี่ชั่วโมง"
          value={String(form.reminder?.paymentDueAfterHours ?? 24)}
          onChange={(v) =>
            setForm((f) => ({
              ...f,
              reminder: {
                sessionHoursBefore: f.reminder?.sessionHoursBefore ?? 24,
                paymentDueAfterHours: Number(v) || 0,
              },
            }))
          }
          description="0 = ไม่เตือน · เตือนเฉพาะคนที่ยังค้างจริงหลังหักที่จ่ายแล้ว"
        />

                {/* [ADR-004] ค่าตั้งต้น — แอดมินแก้ได้อีกทีตอนกดยกเลิกจริง */}
        <TextInput
          label="ยกเลิกกลางคัน เก็บกี่ % ของยอด"
          value={String(Math.round(form.cancellationPolicy.midwayCancelRatio * 100))}
          onChange={(v) => {
            const percent = Number(v);
            patchPolicy({
              midwayCancelRatio: Number.isFinite(percent)
                ? Math.min(100, Math.max(0, percent)) / 100
                : 0,
            });
          }}
          description="ค่าตั้งต้นเวลาไฟดับ/ฝนรั่วกลางคัน — ตอนกดยกเลิกจริงยังแก้ได้"
        />
      </FormLayout>

      {/* ADR-002: สองแบบนี้ยังไม่ implement — บอกล่วงหน้าดีกว่าให้บันทึกแล้วค่อย error */}
      {needsPenaltyValue ? (
        <div className="mt-3">
          <Banner
            status="warning"
            title="รูปแบบนี้ยังคิดเงินให้อัตโนมัติไม่ได้"
            description="ตอนนี้ระบบรองรับ “จ่ายเต็มเหมือนมาเล่น” กับ “ไม่คิดเงิน” เท่านั้น"
          />
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <Banner status="error" title={error} />
        </div>
      ) : null}
      {saved ? (
        <div className="mt-3">
          <Banner status="success" title="บันทึกแล้ว" isDismissable onDismiss={() => setSaved(false)} />
        </div>
      ) : null}

      <div className="mt-4">
        <Button type="submit" variant="primary" label="บันทึกการตั้งค่า" isLoading={pending} />
      </div>
    </form>
  );
}
