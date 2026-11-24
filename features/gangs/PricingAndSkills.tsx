'use client';

import { actionError } from '@/lib/i18n/error-text';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
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
  const planSubmitRef = useRef(false);

  const [skillLabel, setSkillLabel] = useState('');
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillPending, setSkillPending] = useState(false);
  const skillSubmitRef = useRef(false);

  async function onSavePlan(event: FormEvent) {
    event.preventDefault();
    if (planSubmitRef.current) return;
    planSubmitRef.current = true;
    setPlanPending(true);
    setPlanError(null);
    setPlanSaved(false);

    try {
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
        setPlanError(actionError(result.error));
      }
    } catch {
      setPlanError(actionError({ code: 'INTERNAL_ERROR' }));
    } finally {
      planSubmitRef.current = false;
      setPlanPending(false);
    }
  }

  async function onAddSkill(event: FormEvent) {
    event.preventDefault();
    if (skillSubmitRef.current) return;
    skillSubmitRef.current = true;
    setSkillPending(true);
    setSkillError(null);

    try {
      const nextRank = Math.max(0, ...skillLevels.map((s) => s.rank)) + 1;
      const result = await addSkillLevel(gangId, skillLabel, nextRank);

      if (result.success) {
        setSkillLabel('');
        router.refresh();
      } else {
        setSkillError(actionError(result.error));
      }
    } catch {
      setSkillError(actionError({ code: 'INTERNAL_ERROR' }));
    } finally {
      skillSubmitRef.current = false;
      setSkillPending(false);
    }
  }

  async function onRemoveSkill(id: string) {
    if (skillSubmitRef.current) return;
    skillSubmitRef.current = true;
    setSkillPending(true);
    setSkillError(null);

    try {
      const result = await removeSkillLevel(gangId, id);
      if (result.success) router.refresh();
      else setSkillError(actionError(result.error));
    } catch {
      setSkillError(actionError({ code: 'INTERNAL_ERROR' }));
    } finally {
      skillSubmitRef.current = false;
      setSkillPending(false);
    }
  }

  return (
    <VStack gap={6}>
      <VStack as="section" id="pricing-settings" gap={3} className="scroll-mt-24" aria-labelledby="pricing-settings-title">
        <h2 id="pricing-settings-title" className="text-lg font-semibold">แผนราคา</h2>
        <Text as="p" color="secondary" size="sm">โมเดลคิดเงินและการปัดเศษสำหรับนัดใหม่</Text>
        <Card padding={5}>
          <form onSubmit={onSavePlan} noValidate>
            <VStack gap={4}>
              <FormLayout direction="vertical">
                <TextInput size="lg" label="ชื่อแผน" value={planName} onChange={setPlanName} isRequired />

                <RadioList
                  label="โมเดลคิดเงิน"
                  value={planType}
                  onChange={(v) => setPlanType(v as PricingType)}
                >
                  <RadioListItem
                    className="min-h-11"
                    label="เหมาจ่ายต่อหัว"
                    value="flat_rate"
                    description="ทุกคนจ่ายเท่ากัน ไม่ต้องนับลูก"
                  />
                  <RadioListItem
                    className="min-h-11"
                    label="ค่าสนาม + ค่าลูกตามจริง"
                    value="court_plus_shuttle"
                    description="หารค่าสนามทั้งนัด + ค่าลูกตามจำนวนที่บันทึกในคอนโซล"
                  />
                </RadioList>

                {planType === 'flat_rate' ? (
                  <TextInput
                    size="lg"
                    label="ราคาต่อคน (บาท)"
                    value={amount}
                    onChange={setAmount}
                    isRequired
                    description="ทุกคนจ่ายเท่ากัน"
                  />
                ) : (
                  <>
                    <TextInput
                    size="lg"
                      label="ค่าสนามทั้งนัด (บาท)"
                      value={courtFee}
                      onChange={setCourtFee}
                      isRequired
                      description="ยอดรวมของทั้งนัด ไม่ใช่ต่อคน — ระบบหารให้ตอนปิดรอบ"
                    />
                    <TextInput
                    size="lg"
                      label="ราคาลูกละ (บาท)"
                      value={shuttlePrice}
                      onChange={setShuttlePrice}
                      isRequired
                      description="คูณกับจำนวนลูกที่บันทึกไว้ในคอนโซลวันเล่น"
                    />
                    <CheckboxInput
                      className="min-h-11"
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
                  <RadioListItem className="min-h-11" label="ปัดขึ้นเป็นบาท" value="ceil_baht" description="เช่น 250.33 → 251" />
                  <RadioListItem
                    className="min-h-11"
                    label="ปัดขึ้นเป็นสตางค์"
                    value="ceil_satang"
                    description="เช่น 250.333 → 250.34"
                  />
                  <RadioListItem
                    className="min-h-11"
                    label="ปัดลง ก๊วนรับส่วนต่างเอง"
                    value="absorb"
                    description="เก็บได้น้อยกว่าต้นทุนเล็กน้อย"
                  />
                </RadioList>
              </FormLayout>
              {planError ? <Banner status="error" title={planError} /> : null}
              {planSaved ? (
                <Banner
                  status="success"
                  title="บันทึกแผนราคาแล้ว"
                  isDismissable
                  onDismiss={() => setPlanSaved(false)}
                />
              ) : null}
              <Button type="submit" variant="secondary" label="บันทึกแผนราคา" isLoading={planPending} className="min-h-11 w-full sm:w-auto sm:self-start">
                <Text color="primary">บันทึกแผนราคา</Text>
              </Button>
            </VStack>
          </form>
        </Card>
      </VStack>

      <VStack as="section" id="skills-settings" gap={3} className="scroll-mt-24" aria-labelledby="skills-settings-title">
        <h2 id="skills-settings-title" className="text-lg font-semibold">ระดับฝีมือ</h2>
        <Text as="p" color="secondary" size="sm">ระดับฝีมือของก๊วนสำหรับจัดคู่ในวันเล่น</Text>
        {skillLevels.length === 0 ? (
          <Text as="p" color="secondary" size="sm">ยังไม่ได้ตั้งระดับฝีมือ — ใช้จัดคู่ในวันเล่น</Text>
        ) : (
          <VStack as="ul" gap={0}>
            {skillLevels.map((s) => (
              <HStack as="li" key={s.id} gap={3} vAlign="center" hAlign="between" paddingBlock={3} className="border-b border-border">
                <Text color="primary" className="min-w-0 break-words">{s.rank}. {s.label}</Text>
                <Button
                  variant="ghost"
                  size="md"
                  label="ลบ"
                  className="min-h-11 min-w-11 shrink-0"
                  isDisabled={skillPending}
                  onClick={() => onRemoveSkill(s.id)}
                >
                  <Text color="primary">ลบ</Text>
                </Button>
              </HStack>
            ))}
          </VStack>
        )}
        <Card padding={5}>
          <form onSubmit={onAddSkill} noValidate>
            <VStack gap={4}>
              <TextInput
                size="lg"
                label="เพิ่มระดับฝีมือ"
                value={skillLabel}
                onChange={setSkillLabel}
                placeholder="เช่น มือใหม่"
              />
              <Button
                type="submit"
                variant="secondary"
                label="เพิ่ม"
                className="min-h-11 w-full sm:w-auto sm:self-start"
                isLoading={skillPending}
                isDisabled={skillLabel.trim() === ''}
              >
                <Text color="primary">เพิ่ม</Text>
              </Button>
            </VStack>
          </form>
        </Card>
        {skillError ? <Banner status="error" title={skillError} /> : null}
      </VStack>
    </VStack>
  );
}
