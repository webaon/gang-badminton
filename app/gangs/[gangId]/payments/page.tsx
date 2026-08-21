import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { moneyFromDb } from '@/lib/supabase/money';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { summarize, type LedgerEntry } from '@/domain/billing/ledger';
import { LedgerPanel, type LedgerRow } from '@/features/payments/LedgerPanel';
import { ReviewPaymentActions } from '@/features/payments/ReviewPaymentActions';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  pending: 'รอโอน',
  submitted: 'รอยืนยัน',
  verified: 'ยืนยันแล้ว',
  rejected: 'ถูกปฏิเสธ',
};

/**
 * dashboard ค้างจ่าย (baseline §โมดูล ข้อ 5) — **[WO-2.5-D] คิดจาก ledger**
 *
 * 🔴 ยอดค้าง = `charge − allocations(verified) + adjustments` คำนวณสดทุกครั้ง
 *    ❌ ห้ามนับจาก `payments.status` — สลิปใบเดียวครอบหนี้ได้หลายคน (จ่ายแทนเพื่อน)
 *    และการคืนเงินไม่ได้เปลี่ยน status ของอะไรเลย
 */
export default async function PaymentsPage({ params }: { params: Promise<{ gangId: string }> }) {
  const { gangId } = await params;
  const user = await requireUser(`/gangs/${gangId}/payments`);
  const supabase = await supabaseServer();

  const { data: gang } = await supabase
    .from('gangs')
    .select('id, name')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!gang) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;
  if (!can({ role }, 'payment.verify')) redirect(`/gangs/${gangId}/sessions`);

  const admin = supabaseAdmin();

  // ---------------------------------------------------------------------------
  // ledger: หนี้ทุกก้อนของก๊วน + ที่จ่ายมาแล้ว + รายการปรับยอด
  // ---------------------------------------------------------------------------
  const { data: chargeRows } = await admin
    .from('session_charges')
    .select(
      `id, amount, type, billing_month,
       sessions(title),
       session_registrations(guest_name, user_id, profiles(display_name)),
       gang_members(user_id, profiles(display_name)),
       payment_allocations(amount, payments(status)),
       payment_adjustments(amount)`,
    )
    .eq('gang_id', gangId)
    .order('created_at', { ascending: false })
    .limit(200);

  type ChargeRow = {
    id: string;
    amount: string | number;
    type: string;
    billing_month: string | null;
    sessions: { title: string } | null;
    session_registrations: {
      guest_name: string | null;
      user_id: string | null;
      profiles: { display_name: string } | null;
    } | null;
    gang_members: { user_id: string; profiles: { display_name: string } | null } | null;
    payment_allocations: { amount: string | number; payments: { status: string } | null }[];
    payment_adjustments: { amount: string | number }[];
  };

  const charges = (chargeRows ?? []) as unknown as ChargeRow[];

  // ⚠️ PostgREST คืน numeric เป็น JSON number ⇒ แปลงที่ขอบก่อนเข้า domain
  const entries: LedgerEntry[] = charges.map((c) => ({
    chargeId: c.id,
    amount: moneyFromDb(c.amount),
    // 🔴 นับเฉพาะสลิปที่ยืนยันแล้ว — ไม่งั้นอัปสลิปปลอมแล้วหนี้หายทันที
    allocated: c.payment_allocations
      .filter((a) => a.payments?.status === 'verified')
      .map((a) => moneyFromDb(a.amount)),
    adjustments: c.payment_adjustments.map((a) => moneyFromDb(a.amount)),
  }));

  const summary = summarize(entries);
  const lineOf = new Map(summary.lines.map((l) => [l.chargeId, l]));

  const rows: LedgerRow[] = charges.map((c) => {
    const line = lineOf.get(c.id)!;
    const person = c.session_registrations ?? c.gang_members;
    const displayName =
      c.session_registrations?.profiles?.display_name ??
      c.session_registrations?.guest_name ??
      c.gang_members?.profiles?.display_name ??
      'ไม่ทราบชื่อ';

    return {
      chargeId: c.id,
      displayName,
      userId: (person && 'user_id' in person ? person.user_id : null) ?? null,
      label:
        c.type === 'monthly_fee'
          ? `ค่าสมาชิกเดือน ${c.billing_month?.slice(0, 7) ?? ''}`
          : (c.sessions?.title ?? 'นัดเล่น'),
      charge: line.charge,
      allocated: line.allocated,
      adjusted: line.adjusted,
      outstanding: line.outstanding,
    };
  });

  // คนที่เป็นผู้จ่ายได้ต้องมีบัญชี (guest ไม่มี `user_id`)
  const { data: memberRows } = await admin
    .from('gang_members')
    .select('user_id, profiles!gang_members_user_id_fkey!inner(display_name)')
    .eq('gang_id', gangId)
    .is('deleted_at', null);

  type MemberRow = { user_id: string; profiles: { display_name: string } };
  const payers = ((memberRows ?? []) as unknown as MemberRow[]).map((m) => ({
    userId: m.user_id,
    displayName: m.profiles.display_name,
  }));

  // ---------------------------------------------------------------------------
  // สลิปที่รอยืนยัน
  // ---------------------------------------------------------------------------
  const { data: payments } = await admin
    .from('payments')
    .select(
      `id, amount, status, slip_url, created_at,
       profiles:payer_user_id(display_name),
       payment_allocations(session_charge_id)`,
    )
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(50);

  type PaymentRow = {
    id: string;
    amount: string | number;
    status: string;
    slip_url: string | null;
    profiles: { display_name: string } | null;
    payment_allocations: { session_charge_id: string }[];
  };

  const paymentRows = (payments ?? []) as unknown as PaymentRow[];
  const nameOfCharge = new Map(rows.map((r) => [r.chargeId, r.displayName]));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">เก็บเงิน · {gang.name}</h1>
        <span className="flex gap-3">
          <Link href={`/gangs/${gangId}/reports`} className="underline">
            รายงาน
          </Link>
          <Link href={`/gangs/${gangId}/sessions`} className="underline">
            นัด
          </Link>
        </span>
      </div>

      <Card padding={4} variant="muted">
        <p className="text-sm">
          ค้างเก็บ <strong>{summary.outstanding} บาท</strong> · เก็บมาแล้ว {summary.allocated} บาท
          {summary.credit !== '0.00' ? ` · ต้องคืน ${summary.credit.replace('-', '')} บาท` : ''}
        </p>
        {/* 🔴 ค้างจ่ายกับเงินที่ต้องคืนแยกกัน ไม่หักกลบ — ไม่งั้นจะดูเหมือนเก็บครบทั้งที่ยังต้องตามทั้งสองทาง */}
      </Card>

      <div className="mt-4">
        <Card padding={4}>
          <h2 className="mb-3 text-base font-semibold">ยอดรายคน</h2>
          <LedgerPanel gangId={gangId} rows={rows} payers={payers} />
        </Card>
      </div>

      <h2 className="mt-6 mb-2 text-base font-semibold">สลิป ({paymentRows.length})</h2>
      {paymentRows.length === 0 ? (
        <p className="text-sm">ยังไม่มีรายการจ่าย</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {paymentRows.map((p) => (
            <li key={p.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{p.profiles?.display_name ?? 'ไม่ทราบชื่อ'}</p>
                    <p className="text-sm">{moneyFromDb(p.amount)} บาท</p>
                    {p.payment_allocations.length > 1 ? (
                      <p className="text-xs opacity-70">
                        ครอบ{' '}
                        {p.payment_allocations
                          .map((a) => nameOfCharge.get(a.session_charge_id) ?? '—')
                          .join(' · ')}
                      </p>
                    ) : null}
                  </div>
                  <Badge label={STATUS_LABELS[p.status] ?? p.status} />
                </div>

                {p.status === 'submitted' ? (
                  <div className="mt-3">
                    <ReviewPaymentActions paymentId={p.id} hasSlip={p.slip_url !== null} />
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
