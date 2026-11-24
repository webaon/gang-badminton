'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useRef, useState, type FormEvent } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
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
  const submitRef = useRef(false);

  function patchPolicy(patch: Partial<CancellationPolicy>) {
    setForm((f) => ({ ...f, cancellationPolicy: { ...f.cancellationPolicy, ...patch } }));
  }

  const needsPenaltyValue =
    form.cancellationPolicy.penaltyType === 'fixed' ||
    form.cancellationPolicy.penaltyType === 'percent';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitRef.current) return;
    submitRef.current = true;
    setPending(true);
    setError(null);
    setSaved(false);

    try {
      const result = await updateGangSettings(gangId, form);
      if (result.success) setSaved(true);
      else setError(actionError(result.error));
    } catch {
      setError(actionError({ code: 'INTERNAL_ERROR' }));
    } finally {
      submitRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <VStack gap={6}>
        <VStack as="section" id="general-settings" gap={3} className="scroll-mt-24" aria-labelledby="general-settings-title">
          <h2 id="general-settings-title" className="text-lg font-semibold">ตั้งค่าทั่วไป</h2>
          <Text as="p" color="secondary" size="sm">ข้อมูลก๊วนและการค้นหา</Text>
          <Card padding={5}>
            <FormLayout direction="vertical">
              <TextInput
                size="lg"
                label="ชื่อก๊วน"
                value={form.name}
                onChange={(name) => setForm((f) => ({ ...f, name }))}
                isRequired
              />
              <TextInput
                size="lg"
                label="พื้นที่"
                value={form.area ?? ''}
                onChange={(area) => setForm((f) => ({ ...f, area: area || null }))}
                isOptional
              />
              <Switch
                className="min-h-11 [&_input]:min-h-11 [&_input]:min-w-11"
                labelPosition="start"
                labelSpacing="spread"
                label="เปิดให้ค้นหาก๊วนได้"
                value={form.isPublic}
                onChange={(isPublic) => setForm((f) => ({ ...f, isPublic }))}
                description="คนนอกจะเห็นชื่อและพื้นที่ของก๊วน แต่ไม่เห็นสมาชิกหรือนัด"
              />
            </FormLayout>
          </Card>
        </VStack>

        <VStack as="section" id="cancellation-settings" gap={3} className="scroll-mt-24" aria-labelledby="cancellation-settings-title">
          <h2 id="cancellation-settings-title" className="text-lg font-semibold">กติกาการยกเลิก</h2>
          <Text as="p" color="secondary" size="sm">กติกายกเลิก การเตือน และช่องทางรับเงินของก๊วน</Text>
          <Card padding={5}>
            <VStack gap={5}>
              <FormLayout direction="vertical">
                <TextInput
                  size="lg"
                  label="ยกเลิกฟรีก่อนเริ่มนัด (ชั่วโมง)"
                  value={String(form.cancellationPolicy.cutoffHours)}
                  onChange={(v) => patchPolicy({ cutoffHours: Number(v) || 0 })}
                  description="ยกเลิกก่อนเวลานี้ไม่คิดเงิน"
                />
                <Selector
                  size="lg"
                  label="ยกเลิกหลังเวลานี้ หรือไม่มา"
                  options={PENALTY_TYPES.map((t) => ({ value: t, label: PENALTY_LABELS[t] }))}
                  value={form.cancellationPolicy.penaltyType}
                  onChange={(v) => patchPolicy({ penaltyType: v as PenaltyType })}
                />
                {needsPenaltyValue ? (
                  <TextInput
                    size="lg"
                    label={form.cancellationPolicy.penaltyType === 'percent' ? 'เปอร์เซ็นต์' : 'จำนวนเงิน'}
                    value={form.cancellationPolicy.penaltyValue ?? ''}
                    onChange={(penaltyValue) => patchPolicy({ penaltyValue })}
                    isRequired
                  />
                ) : null}
                {/* [WO-2.5-G] เวลาเตือน — 0 = ปิดการเตือนนั้น */}
                <TextInput
                  size="lg"
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
                  size="lg"
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
                  size="lg"
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
              <VStack gap={3}>
                <h3 className="text-base font-semibold">รับเงิน</h3>
                <TextInput
                  size="lg"
                  label="พร้อมเพย์"
                  value={form.promptpayId ?? ''}
                  onChange={(promptpayId) => setForm((f) => ({ ...f, promptpayId: promptpayId || null }))}
                  isOptional
                  description="เบอร์โทรหรือเลขบัตรประชาชนที่ใช้รับเงิน"
                />
              </VStack>
            </VStack>
          </Card>

          {/* ADR-002: fixed/percent remain unsupported; preserve the warning. */}
          {needsPenaltyValue ? (
            <Banner
              status="warning"
              title="รูปแบบนี้ยังคิดเงินให้อัตโนมัติไม่ได้"
              description="ตอนนี้ระบบรองรับ “จ่ายเต็มเหมือนมาเล่น” กับ “ไม่คิดเงิน” เท่านั้น"
            />
          ) : null}
        </VStack>

        {error ? <Banner status="error" title={error} /> : null}
        {saved ? (
          <Banner status="success" title="บันทึกแล้ว" isDismissable onDismiss={() => setSaved(false)} />
        ) : null}
        <VStack gap={2}>
          <Text as="p" color="secondary" size="sm">บันทึกข้อมูลทั่วไป กติกาการยกเลิก การเตือน และพร้อมเพย์พร้อมกัน</Text>
          <Button
            type="submit"
            variant="primary"
            label="บันทึกการตั้งค่า"
            isLoading={pending}
            className="min-h-11 w-full sm:w-auto sm:self-start"
          />
        </VStack>
      </VStack>
    </form>
  );
}
