import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { actionError } from '@/lib/i18n/error-text';
import { StatePanel } from '@/components/ui/StatePanel';
import { listGangCredits } from '@/server/actions/credit';
import { CreditWallet } from './CreditWallet';

export async function CreditWalletPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const path = `/gangs/${gangId}/payments/credits`;
  const user = await requireUser(path);
  const db = await supabaseServer();
  // Page permission context only; financial reads remain in the existing actions.
  const { data: membership, error } = await db.from('gang_members').select('role')
    .eq('gang_id', gangId).eq('user_id', user.id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  const ctx = { role: (membership?.role as GangRole | undefined) ?? null };
  if (!can(ctx, 'credit.read.other')) redirect(`/gangs/${gangId}/sessions`);
  const result = await listGangCredits(gangId);
  if (!result.success) return <StatePanel fullPage={false} tone="error" title="โหลดกระเป๋าเครดิตไม่ได้"
    description={actionError(result.error)} actions={[
      { label: 'ลองโหลดอีกครั้ง', href: path },
      { label: 'กลับหน้าการเงิน', href: `/gangs/${gangId}/payments` },
    ]} />;
  return <CreditWallet gangId={gangId} currentUserId={user.id} initial={result.data}
    canTopUp={can(ctx, 'credit.topup')} canPayOut={can(ctx, 'credit.payout.record')} />;
}
