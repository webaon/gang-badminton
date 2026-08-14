'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { PricingType, RoundingMode } from '@/domain/policies/pricing';
import { addSkillLevel, removeSkillLevel, upsertPricingPlan } from '@/server/actions/gang-config';

export type SkillLevel = { id: string; label: string; rank: number };
export type PricingPlan = {
  id: string;
  name: string;
  type: PricingType;
  amountPerPerson: string;
  courtFeeTotal: string;
  shuttlePrice: string;
  roundingMode: RoundingMode;
  monthlyMemberPaysShuttle: boolean;
} | null;

/**
 * แผนราคา + ระดับฝีมือ
 *
 * **[WO-2.5-B]** เลือกได้ 2 โมเดล: เหมาจ่ายต่อหัว (ADR-002) และ ค่าสนาม+ค่าลูกตามจริง
 * `monthly` ยังไม่เปิด — `isImplemented()` ใน domain เป็นคนกั้น ไม่ใช่แค่ UI
 *
 * 🔴 โหมดปัดเศษมีผลจริงเฉพาะโมเดลที่**มีการหาร** — เหมาจ่ายต่อหัวไม่มีเศษให้ปัด
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
  const [planType, setPlanType] = useState<PricingType>(plan?.type ?? 'flat_rate');
  const [amount, setAmount] = useState(plan?.amountPerPerson ?? '');
  const [courtFee, setCourtFee] = useState(plan?.courtFeeTotal ?? '');
  const [shuttlePrice, setShuttlePrice] = useState(plan?.shuttlePrice ?? '');
  const [roundingMode, setRoundingMode] = useState<RoundingMode>(plan?.roundingMode ?? 'ceil_baht');
  const [monthlyPaysShuttle, setMonthlyPaysShuttle] = useState(
    plan?.monthlyMemberPaysShuttle ?? true,
  );
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
      planType === 'court_plus_shuttle'
        ? {
            name: planName,
            type: 'court_plus_shuttle',
            courtPlusShuttle: { courtFeeTotal: courtFee, shuttlePrice },
            roundingMode,
            monthlyMemberPaysShuttle: monthlyPaysShuttle,
          }
        : {
            name: planName,
            type: 'flat_rate',
            flatRate: { amountPerPerson: amount },
            roundingMode,
            monthlyMemberPaysShuttle: monthlyPaysShuttle,
          },
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

          <RadioList
            label="โมเดลคิดเงิน"
            value={planType}
            onChange={(v) => setPlanType(v as PricingType)}
          >
            <RadioListItem
              label="เหมาจ่ายต่อหัว"
              value="flat_rate"
              description="ทุกคนจ่ายเท่ากัน ไม่ต้องนับลูก"
            />
            <RadioListItem
              label="ค่าสนาม + ค่าลูกตามจริง"
              value="court_plus_shuttle"
              description="หารค่าสนามทั้งนัด + ค่าลูกตามจำนวนที่บันทึกในคอนโซล"
            />
          </RadioList>

          {planType === 'flat_rate' ? (
            <TextInput
              label="ราคาต่อคน (บาท)"
              value={amount}
              onChange={setAmount}
              isRequired
              description="ทุกคนจ่ายเท่ากัน"
            />
          ) : (
            <>
              <TextInput
                label="ค่าสนามทั้งนัด (บาท)"
                value={courtFee}
                onChange={setCourtFee}
                isRequired
                description="ยอดรวมของทั้งนัด ไม่ใช่ต่อคน — ระบบหารให้ตอนปิดรอบ"
              />
              <TextInput
                label="ราคาลูกละ (บาท)"
                value={shuttlePrice}
                onChange={setShuttlePrice}
                isRequired
                description="คูณกับจำนวนลูกที่บันทึกไว้ในคอนโซลวันเล่น"
              />
              <CheckboxInput
                label="สมาชิกรายเดือนจ่ายค่าลูกตามจริง"
                description="ค่าสนามของสมาชิกรายเดือนเป็น 0 เสมอ · ติ๊กออก = ค่าลูกรวมอยู่ในค่ารายเดือนแล้ว"
                value={monthlyPaysShuttle}
                onChange={setMonthlyPaysShuttle}
              />
            </>
          )}

          <RadioList
            label="ปัดเศษยังไงเมื่อหารไม่ลงตัว"
            value={roundingMode}
            onChange={(v) => setRoundingMode(v as RoundingMode)}
            description={
              planType === 'flat_rate'
                ? 'เหมาจ่ายต่อหัวไม่มีการหาร ⇒ โหมดนี้ยังไม่มีผลจนกว่าจะเปลี่ยนโมเดล'
                : 'เศษที่เกินจากการปัดบันทึกเป็นรายรับก๊วน'
            }
          >
            <RadioListItem label="ปัดขึ้นเป็นบาท" value="ceil_baht" description="เช่น 250.33 → 251" />
            <RadioListItem
              label="ปัดขึ้นเป็นสตางค์"
              value="ceil_satang"
              description="เช่น 250.333 → 250.34"
            />
            <RadioListItem
              label="ปัดลง ก๊วนรับส่วนต่างเอง"
              value="absorb"
              description="เก็บได้น้อยกว่าต้นทุนเล็กน้อย"
            />
          </RadioList>
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
