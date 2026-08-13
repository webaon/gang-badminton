import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { ReviewPaymentActions } from '@/features/payments/ReviewPaymentActions';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<string, string> = {
  pending: 'รอโอน',
  submitted: 'รอยืนยัน',
  verified: 'ยืนยันแล้ว',
  rejected: 'ถูกปฏิเสธ',
};

/** dashboard ค้างจ่าย (baseline §โมดูล ข้อ 5) */
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

  // RLS ให้แอดมินเห็นทั้งก๊วน
  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount, status, slip_url, created_at, profiles:payer_user_id(display_name)')
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  type Row = {
    id: string;
    amount: string;
    status: string;
    slip_url: string | null;
    profiles: { display_name: string } | null;
  };

  const rows = (payments ?? []) as unknown as Row[];
  const outstanding = rows.filter((p) => p.status !== 'verified');

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">เก็บเงิน · {gang.name}</h1>
        <Link href={`/gangs/${gangId}/sessions`} className="underline">
          นัด
        </Link>
      </div>

      <Card padding={4} variant="muted">
        <p className="text-sm">
          ค้างจ่าย {outstanding.length} รายการ · รวม{' '}
          {outstanding.reduce((sum, p) => sum + Number(p.amount), 0).toFixed(2)} บาท
        </p>
      </Card>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm">ยังไม่มีรายการจ่าย</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.map((p) => (
            <li key={p.id}>
              <Card padding={4}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{p.profiles?.display_name ?? 'ไม่ทราบชื่อ'}</p>
                    <p className="text-sm">{p.amount} บาท</p>
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
