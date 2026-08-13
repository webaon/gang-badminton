import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { promptPayQrDataUrl } from '@/lib/promptpay/qr';
import { PaySlipForm } from '@/features/payments/PaySlipForm';
import { CreateMyPaymentButton } from '@/features/payments/CreateMyPaymentButton';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  pending: 'รอโอน',
  submitted: 'รอแอดมินยืนยัน',
  verified: 'ยืนยันแล้ว',
  rejected: 'ถูกปฏิเสธ',
};

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

  // ยอดของฉันในนัดนี้ — RLS ให้เห็นเฉพาะ charge ของตัวเอง (หรือทั้งหมดถ้าเป็นแอดมิน)
  const { data: charges } = await supabase
    .from('session_charges')
    .select('id, amount, breakdown, session_registrations!inner(user_id)')
    .eq('session_id', sessionId)
    .eq('type', 'session');

  type ChargeRow = {
    id: string;
    amount: string;
    breakdown: Record<string, unknown>;
    session_registrations: { user_id: string | null };
  };

  const mine = ((charges ?? []) as unknown as ChargeRow[]).filter(
    (c) => c.session_registrations.user_id === user.id,
  );

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
    <main className="mx-auto max-w-md p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">จ่ายเงิน</h1>
        <Link href={`/gangs/${gangId}/sessions/${sessionId}`} className="underline">
          กลับไปที่นัด
        </Link>
      </div>

      <Card padding={6}>
        <p className="text-sm">{session.title}</p>

        {mine.length === 0 ? (
          <p className="mt-3 text-sm">ยังไม่มียอดที่ต้องจ่ายในนัดนี้</p>
        ) : (
          <>
            <p className="mt-2 text-2xl font-semibold">
              {mine.reduce((sum, c) => sum + Number(c.amount), 0).toFixed(2)} บาท
            </p>

            {!payment ? (
              <div className="mt-4">
                <CreateMyPaymentButton sessionId={sessionId} />
              </div>
            ) : (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <Badge label={STATUS_LABELS[payment.status] ?? payment.status} />
                  <span className="text-sm">{payment.amount} บาท</span>
                </div>

                {payment.status === 'rejected' && payment.reject_reason ? (
                  <p className="mt-2 text-sm">เหตุผลที่ถูกปฏิเสธ: {payment.reject_reason}</p>
                ) : null}

                {qr ? (
                  <div className="mt-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qr} alt="PromptPay QR" className="mx-auto w-64" />
                    <p className="mt-2 text-center text-xs">สแกนด้วยแอปธนาคารเพื่อโอน</p>
                  </div>
                ) : payment.status !== 'verified' ? (
                  <p className="mt-3 text-sm">ก๊วนยังไม่ได้ตั้งพร้อมเพย์ — ติดต่อแอดมินเพื่อโอน</p>
                ) : null}

                <div className="mt-4">
                  <PaySlipForm paymentId={payment.id} status={payment.status} />
                </div>
              </>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
