import { notFound } from 'next/navigation';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';
import { requireUser } from '@/lib/supabase/auth';
import { actionError } from '@/lib/i18n/error-text';
import { StatePanel } from '@/components/ui/StatePanel';
import { adminPaymentDetail } from '@/server/actions/payment-admin';
import { PaymentReview } from './PaymentReview';

export async function PaymentReviewPage({ params }: { params: Promise<{ gangId: string; paymentId: string }> }) {
  const { gangId, paymentId } = await params;
  await requireUser(`/gangs/${gangId}/payments/${paymentId}`);
  const result = await adminPaymentDetail(paymentId);
  if (!result.success) return <StatePanel fullPage={false} tone="error" title="เปิดรายการจ่ายไม่ได้"
    description={actionError(result.error)} actions={[{ label: 'กลับหน้าเก็บเงิน', href: `/gangs/${gangId}/payments` }]} />;
  if (result.data.gangId !== gangId) notFound();
  return <VStack gap={4} className="mx-auto w-full max-w-3xl p-4">
    <Button variant="ghost" label="กลับหน้าเก็บเงิน" href={`/gangs/${gangId}/payments`} />
    <PaymentReview key={result.data.id} initial={result.data} />
  </VStack>;
}
