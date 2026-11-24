import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/auth';
export const dynamic = 'force-dynamic';
export default async function PaymentsPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  await requireUser(`/gangs/${gangId}/payments`);
  redirect(`/gangs/${gangId}/payments/review`);
}
