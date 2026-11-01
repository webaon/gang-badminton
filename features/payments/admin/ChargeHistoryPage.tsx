import { notFound } from 'next/navigation';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';
import { requireUser } from '@/lib/supabase/auth';
import { actionError } from '@/lib/i18n/error-text';
import { StatePanel } from '@/components/ui/StatePanel';
import { chargeHistory } from '@/server/actions/payment-admin';
import { ChargeHistory } from './ChargeHistory';

export async function ChargeHistoryPage({ params }: { params: Promise<{ gangId: string; chargeId: string }> }) {
  const { gangId, chargeId } = await params;
  await requireUser(`/gangs/${gangId}/payments/charges/${chargeId}`);
  const result = await chargeHistory(chargeId);
  if (!result.success) return <StatePanel fullPage={false} tone="error" title="เปิดประวัติไม่ได้"
    description={actionError(result.error)} actions={[{ label: 'กลับหน้าเก็บเงิน', href: `/gangs/${gangId}/payments` }]} />;
  if (result.data.gangId !== gangId) notFound();
  return <VStack gap={4} className="mx-auto w-full max-w-3xl p-4">
    <Button variant="ghost" label="กลับหน้าเก็บเงิน" href={`/gangs/${gangId}/payments`} />
    <ChargeHistory key={result.data.chargeId} initial={result.data} />
  </VStack>;
}
