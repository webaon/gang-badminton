'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';

import { addSkillLevel, removeSkillLevel, upsertPricingPlan } from '@/server/actions/gang-config';

export type SkillLevel = { id: string; label: string; rank: number };
export type PricingPlan = { id: string; name: string; amountPerPerson: string } | null;

/**
 * แผนราคา + ระดับฝีมือ
 *
 * MVP-0 มีแผนราคาแบบเดียว (flat_rate) ตาม ADR-002 ⇒ ฟอร์มไม่มีให้เลือกชนิด
 * เพิ่มชนิดอื่นเมื่อ Phase 2.5 เปิด `court_plus_shuttle`
 */
export function PricingAndSkills({
  gangId,
  plan,
  skillLevels,
}: {
  gangId: string;
  plan: PricingPlan;
  skillLevels: SkillLevel[];
}) {
  const router = useRouter();

  const [planName, setPlanName] = useState(plan?.name ?? 'เหมาจ่ายต่อหัว');
  const [amount, setAmount] = useState(plan?.amountPerPerson ?? '');
  const [planError, setPlanError] = useState<string | null>(null);
  const [planSaved, setPlanSaved] = useState(false);
  const [planPending, setPlanPending] = useState(false);

  const [skillLabel, setSkillLabel] = useState('');
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillPending, setSkillPending] = useState(false);

  async function onSavePlan(event: FormEvent) {
    event.preventDefault();
    setPlanPending(true);
    setPlanError(null);
    setPlanSaved(false);

    const result = await upsertPricingPlan(
      gangId,
      { name: planName, type: 'flat_rate', flatRate: { amountPerPerson: amount } },
      plan?.id,
    );

    if (result.success) {
      setPlanSaved(true);
      router.refresh();
    } else {
      setPlanError(result.error.message);
    }
    setPlanPending(false);
  }

  async function onAddSkill(event: FormEvent) {
    event.preventDefault();
    setSkillPending(true);
    setSkillError(null);

    const nextRank = Math.max(0, ...skillLevels.map((s) => s.rank)) + 1;
    const result = await addSkillLevel(gangId, skillLabel, nextRank);

    if (result.success) {
      setSkillLabel('');
      router.refresh();
    } else {
      setSkillError(result.error.message);
    }
    setSkillPending(false);
  }

  async function onRemoveSkill(id: string) {
    setSkillPending(true);
    setSkillError(null);

    const result = await removeSkillLevel(gangId, id);
    if (result.success) router.refresh();
    else setSkillError(result.error.message);

    setSkillPending(false);
  }

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold">แผนราคา</h2>
      <form onSubmit={onSavePlan} noValidate>
        <FormLayout direction="vertical">
          <TextInput label="ชื่อแผน" value={planName} onChange={setPlanName} isRequired />
          <TextInput
            label="ราคาต่อคน (บาท)"
            value={amount}
            onChange={setAmount}
            isRequired
            description="ทุกคนจ่ายเท่ากัน — โมเดลอื่นจะเปิดในเฟสถัดไป"
          />
        </FormLayout>

        {planError ? (
          <div className="mt-3">
            <Banner status="error" title={planError} />
          </div>
        ) : null}
        {planSaved ? (
          <div className="mt-3">
            <Banner
              status="success"
              title="บันทึกแผนราคาแล้ว"
              isDismissable
              onDismiss={() => setPlanSaved(false)}
            />
          </div>
        ) : null}

        <div className="mt-4">
          <Button type="submit" variant="primary" label="บันทึกแผนราคา" isLoading={planPending} />
        </div>
      </form>

      <h2 className="mt-8 mb-2 text-base font-semibold">ระดับฝีมือ</h2>
      {skillLevels.length === 0 ? (
        <p className="mb-3 text-sm">ยังไม่ได้ตั้งระดับฝีมือ — ใช้จัดคู่ในวันเล่น</p>
      ) : (
        <ul className="mb-3 divide-y">
          {skillLevels.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {s.rank}. {s.label}
              </span>
              <Button
                variant="ghost"
                size="sm"
                label="ลบ"
                isDisabled={skillPending}
                onClick={() => onRemoveSkill(s.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onAddSkill} noValidate>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <TextInput
              label="เพิ่มระดับฝีมือ"
              value={skillLabel}
              onChange={setSkillLabel}
              placeholder="เช่น มือใหม่"
            />
          </div>
          <Button
            type="submit"
            label="เพิ่ม"
            isLoading={skillPending}
            isDisabled={skillLabel.trim() === ''}
          />
        </div>
      </form>

      {skillError ? (
        <div className="mt-3">
          <Banner status="error" title={skillError} />
        </div>
      ) : null}
    </div>
  );
}
