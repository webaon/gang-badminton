import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { loadGangSettings } from '@/server/gangs/settings-loader';
import { errorText } from '@/lib/i18n/error-text';
import { GangSettingsForm } from './GangSettingsForm';
import { PricingAndSkills } from './PricingAndSkills';
import { MonthlyPlanForm } from '@/features/billing/MonthlyPlanForm';
import { RecomputeStatsButton } from '@/features/reports/RecomputeStatsButton';
import { LineSettingsPanel } from '@/features/line/LineSettingsPanel';

const SECTIONS = [
  ['general-settings', 'ข้อมูลก๊วน'], ['skills-settings', 'ระดับฝีมือ'],
  ['pricing-settings', 'โมเดลคิดเงิน'], ['cancellation-settings', 'กติกายกเลิก & รับเงิน'],
  ['monthly-settings', 'สมาชิกรายเดือน'], ['line-settings', 'LINE ของก๊วน'],
] as const;

export default async function GangSettingsPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const data = await loadGangSettings(gangId);
  const settings = data.settings;
  if (!settings) return (
    <VStack as="section" gap={4} padding={4} className="mx-auto w-full max-w-3xl">
      <Heading level={1}>{data.name}</Heading>
      <Banner status="info" title="เฉพาะแอดมินของก๊วนเท่านั้นที่แก้ตั้งค่าได้" />
      <Button label="ดูรายชื่อสมาชิก" href={`/gangs/${gangId}/members`} variant="secondary"><Text>ดูรายชื่อสมาชิก</Text></Button>
    </VStack>
  );
  return (
    <VStack as="section" gap={6} padding={4} className="mx-auto w-full max-w-4xl">
      <Heading level={1}>ตั้งค่าก๊วน</Heading>
      <Text color="secondary">{data.name} · จัดการข้อมูล กติกา และการรับเงินของก๊วน</Text>
      <HStack as="nav" aria-label="หมวดตั้งค่าก๊วน" gap={2} wrap="wrap">
        {SECTIONS.map(([id, label]) => <Button label={label} key={id} href={`#${id}`} variant="secondary" className="min-h-11"><Text>{label}</Text></Button>)}
        <Button label="ดูรายชื่อสมาชิก" href={`/gangs/${gangId}/members`} variant="secondary"><Text>สมาชิก</Text></Button>
      </HStack>
      <GangSettingsForm gangId={gangId} initial={settings.initial} />
      <PricingAndSkills gangId={gangId} plan={settings.plan} skillLevels={settings.skillLevels} />
      <Card padding={5}>
        <MonthlyPlanForm gangId={gangId} plan={settings.monthlyPlan} />
        <Button label="ดูรอบบิลรายเดือน" href={`/gangs/${gangId}/membership`} variant="secondary" className="mt-4 min-h-11"><Text>ดูรอบบิลรายเดือน</Text></Button>
      </Card>
      <Card padding={5}>
        <VStack gap={3}><Heading level={2}>สถิติสมาชิก</Heading><RecomputeStatsButton gangId={gangId} /></VStack>
      </Card>
      <VStack as="section" id="line-settings" gap={3} className="scroll-mt-24">
        <Card padding={5}>
          {settings.line.success ? <LineSettingsPanel gangId={gangId} initial={settings.line.data} usage={settings.usage.success ? settings.usage.data : null} login={settings.login.success ? settings.login.data : null} /> : <Banner status="error" title={errorText(settings.line.error)} />}
        </Card>
      </VStack>
    </VStack>
  );
}
