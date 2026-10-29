import { notFound } from 'next/navigation';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { summarize, type LedgerEntry } from '@/domain/billing/ledger';
import { baht, isZeroAmount } from '@/domain/sessions/close-view';
import { moneyFromDb } from '@/lib/supabase/money';
import { promptPayQrDataUrl } from '@/lib/promptpay/qr';
import { PayView } from '@/features/payments/PayView';

export const dynamic = 'force-dynamic';

/**
 * หน้าจ่ายเงินรายนัดของสมาชิก (hi-fi 30/31) — **[WO-2.5-D · reskin WO-6.3]**
 * เนื้อหาแสดงผลอยู่ที่ `features/payments/PayView` (ไม่คิดเงิน)
 *
 * ⚠️ TODO(WO-R3): ตอนนี้ยังเลือก payment ล่าสุดของ "ก๊วน" ไม่ผูกนัด (บั๊กที่ planner สั่งแก้ผ่าน loader ของ R3)
 *    เมื่อ R3 ลง ให้เปลี่ยนแหล่ง `payment` + ledger ของหน้านี้เป็น loader นั้น — PayView ไม่ต้องแก้
 */
export default async function PayPage({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  const user = await requireUser(`/gangs/${gangId}/sessions/${sessionId}/pay`);
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, snapshot')
    .eq('id', sessionId)
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) notFound();

  const { data: gang } = await supabase.from('gangs').select('name').eq('id', gangId).maybeSingle();

  // ยอดของฉันในนัดนี้ — RLS ให้เห็นเฉพาะ charge ของตัวเอง (หรือทั้งหมดถ้าเป็นแอดมิน)
  const { data: charges } = await supabase
    .from('session_charges')
    .select(
      `id, amount, breakdown,
       session_registrations!inner(user_id),
       payment_allocations(amount, payments(status)),
       payment_adjustments(amount)`,
    )
    .eq('session_id', sessionId)
    .eq('type', 'session');

  type ChargeRow = {
    id: string;
    amount: string | number;
    breakdown: Record<string, unknown>;
    session_registrations: { user_id: string | null };
    payment_allocations: { amount: string | number; payments: { status: string } | null }[];
    payment_adjustments: { amount: string | number }[];
  };

  const mine = ((charges ?? []) as unknown as ChargeRow[]).filter(
    (c) => c.session_registrations.user_id === user.id,
  );

  // 🔴 [WO-2.5-D] ยอดที่ต้องจ่าย = ledger ของ charge ตัวเอง ไม่ใช่ผลบวกดิบของ `amount`
  //    (เพื่อนอาจจ่ายแทนไปแล้ว หรือแอดมินอาจคืนเงินบางส่วน)
  const entries: LedgerEntry[] = mine.map((c) => ({
    chargeId: c.id,
    // ⚠️ PostgREST คืน numeric เป็น JSON number ⇒ แปลงที่ขอบก่อนเข้า domain
    amount: moneyFromDb(c.amount),
    allocated: c.payment_allocations
      .filter((a) => a.payments?.status === 'verified')
      .map((a) => moneyFromDb(a.amount)),
    adjustments: c.payment_adjustments.map((a) => moneyFromDb(a.amount)),
  }));

  const myLedger = summarize(entries);

  const { data: payment } = await supabase
    .from('payments')
    .select('id, amount, status, slip_url, reject_reason')
    .eq('gang_id', gangId)
    .eq('payer_user_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 🔴 PromptPay ID อ่านจาก snapshot ของนัด ไม่ใช่ค่าปัจจุบันของก๊วน
  const promptPayId = (session.snapshot as { promptpay_id?: string } | null)?.promptpay_id ?? null;

  let qr: string | null = null;
  if (payment && promptPayId && payment.status !== 'verified') {
    try {
      qr = await promptPayQrDataUrl(promptPayId, payment.amount);
    } catch {
      // PromptPay ID ของก๊วนใช้ไม่ได้ — แสดงยอดให้โอนเองแทนที่จะพังทั้งหน้า
      qr = null;
    }
  }

  return (
    <PayView
      gangId={gangId}
      gangName={gang?.name ?? 'ก๊วน'}
      sessionId={sessionId}
      sessionTitle={session.title}
      hasCharges={mine.length > 0}
      outstandingText={baht(myLedger.outstanding)}
      allocatedText={isZeroAmount(myLedger.allocated) ? null : baht(myLedger.allocated)}
      refundText={
        isZeroAmount(myLedger.credit) ? null : `ก๊วนต้องคืนให้ ${baht(myLedger.credit.replace('-', ''))}`
      }
      payment={
        payment
          ? {
              id: payment.id,
              amountText: baht(moneyFromDb(payment.amount)),
              status: payment.status,
              rejectReason: payment.reject_reason,
            }
          : null
      }
      qr={qr}
      promptPayId={promptPayId}
    />
  );
}
