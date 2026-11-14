import { notFound } from 'next/navigation';
import { Banner } from '@astryxdesign/core/Banner';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { requireUser } from '@/lib/supabase/auth';
import { actionError } from '@/lib/i18n/error-text';
import { dashboardOverview } from '@/server/actions/dashboard';
import { DashboardSummary } from './DashboardSummary';
import { DashboardDetails } from './DashboardDetails';

export default async function DashboardPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  await requireUser(`/gangs/${gangId}/dashboard`);
  const result = await dashboardOverview(gangId);
  if (!result.success && result.error.code === 'NOT_FOUND') notFound();
  return (
    <VStack as="section" gap={5} padding={4} className="mx-auto w-full max-w-7xl">
      <Heading level={1}>แดชบอร์ด</Heading>
      <Text color="secondary">ภาพรวมก๊วน · ข้อมูลตามสิทธิ์ของคุณ</Text>
      {!result.success ? <Banner status="error" title={actionError(result.error)} /> : (
        <>
          <DashboardSummary data={result.data} />
          <DashboardDetails data={result.data} gangId={gangId} />
        </>
      )}
    </VStack>
  );
}
