import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { moneyFromDb } from '@/lib/supabase/money';
import { ledgerLineOf, type LedgerEntry } from '@/domain/billing/ledger';
import { toSatang } from '@/domain/billing/money';
import {
  reminderFromJson,
  shouldRemindPayment,
  shouldRemindSession,
} from '@/domain/gangs/settings';

/**
 * งานเตือน — **[WO-2.5-G]**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 **ห้ามสร้าง worker ใหม่** (Forbidden ของ WO นี้)
 *    ที่นี่แค่ **เข้าคิว** `notifications` — ตัวส่งยังเป็น `claim_notifications()`
 *    + `dispatchNotifications()` เดิม และแถวค้าง `processing` ยังถูก sweep เหมือนเดิม
 *
 * 🔴 กันส่งซ้ำด้วย `dedupe_key` + unique index (ไม่ใช่ check-then-act ใน TS)
 *
 * ⚠️ เตือนยอดค้าง **คิดจาก ledger** (WO-2.5-D) ไม่ใช่จาก `payments.status`
 *    ⇒ คนที่เพื่อนจ่ายแทนไปแล้ว หรือได้ refund จนหมดหนี้ ต้องไม่ถูกตามเก็บ
 */

/** ช่วงกว้างสุดที่ดึงนัดมาพิจารณา — ค่าจริงต่อก๊วนกรองอีกทีใน TS */
const MAX_LOOKAHEAD_HOURS = 24 * 14;

export type ReminderOutcome = {
  sessionReminders: number;
  paymentReminders: number;
};

type NotificationRow = {
  gang_id: string;
  recipient_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
};

async function enqueue(rows: NotificationRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const { data, error } = await supabaseAdmin().rpc('enqueue_notifications', { p_rows: rows });
  if (error) throw error;

  return Number(data ?? 0);
}

/**
 * เตือนก่อนถึงนัด — ตามชั่วโมงที่แต่ละก๊วนตั้งไว้
 *
 * ⚠️ เตือนเฉพาะคนที่ **ได้ที่แล้ว** (`confirmed`) — คนใน waitlist ยังไม่มีอะไรให้เตือน
 *    และคนที่ `checked_in` แล้วก็อยู่ที่สนามแล้ว
 */
export async function sendSessionReminders(correlationId: string, now: Date): Promise<number> {
  const admin = supabaseAdmin();

  const horizon = new Date(now.getTime() + MAX_LOOKAHEAD_HOURS * 60 * 60 * 1000);

  const { data, error } = await admin
    .from('sessions')
    .select('id, gang_id, title, starts_at, gangs!inner(settings, deleted_at)')
    .eq('status', 'open')
    .is('deleted_at', null)
    .gt('starts_at', now.toISOString())
    .lte('starts_at', horizon.toISOString());

  if (error) throw error;

  type SessionRow = {
    id: string;
    gang_id: string;
    title: string;
    starts_at: string;
    gangs: { settings: unknown; deleted_at: string | null } | null;
  };

  const sessions = ((data ?? []) as unknown as SessionRow[]).filter((s) => {
    if (s.gangs?.deleted_at) return false;
    const { sessionHoursBefore } = reminderFromJson(s.gangs?.settings);
    return shouldRemindSession(new Date(s.starts_at), now, sessionHoursBefore);
  });

  if (sessions.length === 0) return 0;

  const { data: registrations, error: regError } = await admin
    .from('session_registrations')
    .select('session_id, user_id')
    .in(
      'session_id',
      sessions.map((s) => s.id),
    )
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .not('user_id', 'is', null);

  if (regError) throw regError;

  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const rows: NotificationRow[] = (registrations ?? []).map((r) => {
    const session = sessionById.get(r.session_id as string)!;
    return {
      gang_id: session.gang_id,
      recipient_id: r.user_id as string,
      event_type: 'session.reminder',
      payload: {
        correlation_id: correlationId,
        session_id: session.id,
        session_title: session.title,
        starts_at: session.starts_at,
      },
      dedupe_key: `session_reminder:${session.id}:${r.user_id}`,
    };
  });

  return enqueue(rows);
}

/**
 * เตือนยอดค้างจ่าย
 *
 * 🔴 "ค้างจริง" = `charge − allocations(verified) + adjustments > 0` (ledger, WO-2.5-D)
 *    ❌ ห้ามดูจาก `payments.status` — สลิปใบเดียวครอบหนี้ได้หลายคน และ refund
 *      ไม่ได้เปลี่ยน status ของอะไรเลย
 */
export async function sendPaymentReminders(correlationId: string, now: Date): Promise<number> {
  const admin = supabaseAdmin();

  const { data, error } = await admin
    .from('session_charges')
    .select(
      `id, gang_id, amount, type,
       sessions!inner(id, title, ends_at, gangs!inner(settings, deleted_at)),
       session_registrations!inner(user_id),
       payment_allocations(amount, payments(status)),
       payment_adjustments(amount)`,
    )
    .eq('type', 'session')
    .not('session_registrations.user_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  type ChargeRow = {
    id: string;
    gang_id: string;
    amount: string | number;
    sessions: {
      id: string;
      title: string;
      ends_at: string;
      gangs: { settings: unknown; deleted_at: string | null } | null;
    };
    session_registrations: { user_id: string | null };
    payment_allocations: { amount: string | number; payments: { status: string } | null }[];
    payment_adjustments: { amount: string | number }[];
  };

  const rows: NotificationRow[] = [];

  for (const charge of (data ?? []) as unknown as ChargeRow[]) {
    const gang = charge.sessions.gangs;
    if (gang?.deleted_at) continue;

    const userId = charge.session_registrations.user_id;
    if (!userId) continue;

    const { paymentDueAfterHours } = reminderFromJson(gang?.settings);
    if (!shouldRemindPayment(new Date(charge.sessions.ends_at), now, paymentDueAfterHours)) {
      continue;
    }

    // ⚠️ PostgREST คืน numeric เป็น JSON number ⇒ แปลงที่ขอบก่อนเข้า domain
    const entry: LedgerEntry = {
      chargeId: charge.id,
      amount: moneyFromDb(charge.amount),
      allocated: charge.payment_allocations
        .filter((a) => a.payments?.status === 'verified')
        .map((a) => moneyFromDb(a.amount)),
      adjustments: charge.payment_adjustments.map((a) => moneyFromDb(a.amount)),
    };

    const line = ledgerLineOf(entry);
    if (toSatang(line.outstanding) <= 0) continue;

    rows.push({
      gang_id: charge.gang_id,
      recipient_id: userId,
      event_type: 'payment.overdue',
      payload: {
        correlation_id: correlationId,
        session_id: charge.sessions.id,
        session_title: charge.sessions.title,
        charge_id: charge.id,
        outstanding: line.outstanding,
      },
      dedupe_key: `payment_due:${charge.id}:${userId}`,
    });
  }

  return enqueue(rows);
}

/** งานของ cron — เตือนทั้งสองแบบในรอบเดียว */
export async function runReminders(
  correlationId: string,
  now: Date = new Date(),
): Promise<ReminderOutcome> {
  return {
    sessionReminders: await sendSessionReminders(correlationId, now),
    paymentReminders: await sendPaymentReminders(correlationId, now),
  };
}
