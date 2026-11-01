import { notFound } from 'next/navigation';
import { StatePanel } from '@/components/ui/StatePanel';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { errorText } from '@/lib/i18n/error-text';
import { baht, isZeroAmount } from '@/domain/sessions/close-view';
import { promptPayQrDataUrl } from '@/lib/promptpay/qr';
import { myBalance, myChargeBreakdown, myPaymentForSession } from '@/server/actions/payments';
import { getMyCredit } from '@/server/actions/credit';
import { PayView } from './PayView';

/** R3 owns all money reads/calculations; UI receives session-linked results only. */
export async function SessionPayPage({ params }: { params: Promise<{ gangId: string; sessionId: string }> }) {
  const { gangId, sessionId } = await params;
  const href = `/gangs/${gangId}/sessions/${sessionId}/pay`;
  await requireUser(href);
  const supabase = await supabaseServer();
  const { data: session, error: sessionError } = await supabase.from('sessions')
    .select('id, title, snapshot').eq('id', sessionId).eq('gang_id', gangId).is('deleted_at', null).maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) notFound();
  const { data: gang, error: gangError } = await supabase.from('gangs').select('name')
    .eq('id', gangId).is('deleted_at', null).maybeSingle();
  if (gangError) throw gangError;

  const [balance, paymentResult, split, wallet] = await Promise.all([
    myBalance(gangId), myPaymentForSession(sessionId), myChargeBreakdown(sessionId), getMyCredit(gangId),
  ]);
  for (const result of [balance, paymentResult, split, wallet]) {
    if (!result.success) return <StatePanel fullPage={false} tone="error" title="โหลดยอดไม่สำเร็จ"
      description={errorText(result.error)} actions={[{ label: 'ลองใหม่', href }, { label: 'กลับไปที่นัด', href: `/gangs/${gangId}/sessions/${sessionId}`, variant: 'secondary' }]} />;
  }
  // Explicit narrowing keeps every failure above fail-closed (never turn a failed read into zero debt).
  if (!balance.success || !paymentResult.success || !split.success || !wallet.success) return null;
  const mine = balance.data.items.find((item) => item.kind === 'session' && item.sessionId === sessionId);
  const payment = paymentResult.data;
  const promptPayId = (session.snapshot as { promptpay_id?: string } | null)?.promptpay_id ?? null;
  let qr: string | null = null;
  if (payment && promptPayId && payment.status !== 'verified') {
    try { qr = await promptPayQrDataUrl(promptPayId, payment.amount); }
    catch { console.warn('[session-pay] QR generation failed', { sessionId }); }
  }
  return <PayView gangId={gangId} gangName={gang?.name ?? 'ก๊วน'} sessionId={sessionId}
    sessionTitle={session.title} hasCharges={Boolean(mine)}
    outstandingText={baht(mine?.outstanding ?? '0.00')}
    hasOutstanding={Boolean(mine && !isZeroAmount(mine.outstanding))}
    allocatedText={mine && !isZeroAmount(mine.paid) ? baht(mine.paid) : null}
    refundText={mine && !isZeroAmount(mine.credit) ? `ก๊วนต้องคืนให้ ${baht(mine.credit.replace(/^-/, ''))}` : null}
    creditBalanceText={isZeroAmount(wallet.data.balance) ? null : baht(wallet.data.balance)}
    breakdown={split.data?.total ?? null}
    combinedPaymentText={payment && payment.amount !== payment.amountForSession
      ? `QR นี้เป็นยอดทั้งใบ ${baht(payment.amount)} ครอบคลุมนัดนี้ ${baht(payment.amountForSession)} และรายการอื่นในใบเดียวกัน — อย่าโอนเฉพาะยอดนัดนี้ซ้ำ`
      : null}
    payment={payment ? { id: payment.id, amountText: baht(payment.amount), status: payment.status, rejectReason: payment.rejectReason } : null}
    qr={qr} promptPayId={promptPayId} />;
}
