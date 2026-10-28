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

/**
 * ขนาดหน้าของ query — 🔴 ต้อง **น้อยกว่า** `max_rows` ของ PostgREST (supabase/config.toml: 1000)
 * ไม่งั้น PostgREST ตัดผลเงียบๆ แล้วเราคิดว่าได้ครบ ⇒ นัด/ผู้เล่นส่วนที่เกินไม่ถูกเตือนโดยไม่มี error
 */
const PAGE_SIZE = 500;

/** จำนวน session id ต่อ 1 คำสั่ง `.in()` — กัน URL ยาวเกิน (uuid 36 ตัว × 100 ≈ 3.7KB) */
const SESSION_ID_CHUNK = 100;

/** ตัวเลือกสำหรับเทสต์เท่านั้น — production ใช้ค่าเริ่มต้น */
export type ReminderPaging = { pageSize?: number; registrationPageSize?: number };

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
export async function sendSessionReminders(
  correlationId: string,
  now: Date,
  paging: ReminderPaging = {},
): Promise<number> {
  const admin = supabaseAdmin();

  const pageSize = Math.max(1, paging.pageSize ?? PAGE_SIZE);
  const registrationPageSize = Math.max(1, paging.registrationPageSize ?? PAGE_SIZE);

  const horizon = new Date(now.getTime() + MAX_LOOKAHEAD_HOURS * 60 * 60 * 1000);

  type SessionRow = {
    id: string;
    gang_id: string;
    title: string;
    starts_at: string;
    gangs: { settings: unknown; deleted_at: string | null } | null;
  };

  let created = 0;

  /**
   * 🔴 keyset pagination ตาม (starts_at, id) — ไม่ใช้ offset
   *    · PostgREST ตัดที่ max_rows (1000) เงียบๆ ⇒ query เดียวไม่พอเมื่อมีนัดเปิดใน 14 วันเกินนั้น
   *    · offset จะ "ข้าม" แถวถ้ามีนัดปิด/ลบระหว่างวน ส่วน keyset ยึดตำแหน่งจริงของแถว
   *    · ช่วงเวลา (now, now+14d] คือช่วงแคบสุดที่ถูกต้องในระดับ SQL — ชั่วโมงเตือนจริงเป็นของแต่ละก๊วน
   *      (0–336 ชม. ใน `settings` JSON) จึงกรองต่อใน TS เหมือนเดิม
   */
  let cursor: { startsAt: string; id: string } | null = null;

  for (;;) {
    let query = admin
      .from('sessions')
      .select('id, gang_id, title, starts_at, gangs!inner(settings, deleted_at)')
      .eq('status', 'open')
      .is('deleted_at', null)
      .gt('starts_at', now.toISOString())
      .lte('starts_at', horizon.toISOString())
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(pageSize);

    if (cursor) {
      query = query.or(
        `starts_at.gt."${cursor.startsAt}",and(starts_at.eq."${cursor.startsAt}",id.gt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as unknown as SessionRow[];
    if (page.length === 0) break;

    const last = page[page.length - 1];
    cursor = { startsAt: last.starts_at, id: last.id };

    const sessions = page.filter((s) => {
      if (s.gangs?.deleted_at) return false;
      const { sessionHoursBefore } = reminderFromJson(s.gangs?.settings);
      return shouldRemindSession(new Date(s.starts_at), now, sessionHoursBefore);
    });

    created += await remindSessions(admin, correlationId, sessions, registrationPageSize);

    if (page.length < pageSize) break;
  }

  return created;
}

/** เข้าคิวเตือนของนัดกลุ่มหนึ่ง — อ่านผู้เล่นเป็นหน้าๆ (ผู้เล่นต่อนัดก็เกิน max_rows ได้เมื่อรวมหลายนัด) */
async function remindSessions(
  admin: ReturnType<typeof supabaseAdmin>,
  correlationId: string,
  sessions: { id: string; gang_id: string; title: string; starts_at: string }[],
  registrationPageSize: number,
): Promise<number> {
  if (sessions.length === 0) return 0;

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  let created = 0;

  for (let i = 0; i < sessions.length; i += SESSION_ID_CHUNK) {
    const ids = sessions.slice(i, i + SESSION_ID_CHUNK).map((s) => s.id);
    let afterId: string | null = null;

    for (;;) {
      let query = admin
        .from('session_registrations')
        .select('id, session_id, user_id')
        .in('session_id', ids)
        .eq('status', 'confirmed')
        .is('deleted_at', null)
        .not('user_id', 'is', null)
        .order('id', { ascending: true })
        .limit(registrationPageSize);

      if (afterId) query = query.gt('id', afterId);

      const { data, error } = await query;
      if (error) throw error;

      const registrations = (data ?? []) as { id: string; session_id: string; user_id: string }[];
      if (registrations.length === 0) break;

      afterId = registrations[registrations.length - 1].id;

      const rows: NotificationRow[] = registrations.map((r) => {
        const session = sessionById.get(r.session_id)!;
        return {
          gang_id: session.gang_id,
          recipient_id: r.user_id,
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

      created += await enqueue(rows);

      if (registrations.length < registrationPageSize) break;
    }
  }

  return created;
}

/**
 * เตือนยอดค้างจ่าย
 *
 * 🔴 "ค้างจริง" = `charge − allocations(verified) + adjustments > 0` (ledger, WO-2.5-D)
 *    ❌ ห้ามดูจาก `payments.status` — สลิปใบเดียวครอบหนี้ได้หลายคน และ refund
 *      ไม่ได้เปลี่ยน status ของอะไรเลย
 */
export async function sendPaymentReminders(
  correlationId: string,
  now: Date,
  paging: Pick<ReminderPaging, 'pageSize'> = {},
): Promise<number> {
  const admin = supabaseAdmin();

  const pageSize = Math.max(1, paging.pageSize ?? PAGE_SIZE);

  type ChargeRow = {
    id: string;
    gang_id: string;
    created_at: string;
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

  let created = 0;

  /**
   * 🔴 keyset pagination ตาม (created_at desc, id desc) — [WO-B13.1]
   *    เดิม `.limit(500)` ครั้งเดียว ⇒ ยอดค้างที่เก่ากว่า 500 รายการล่าสุดไม่ถูกตรวจเลยโดยไม่มี error
   *    · ยังเรียงใหม่→เก่าเหมือนเดิม (ถ้ารันไม่จบ ของใหม่ถูกเตือนก่อน)
   *    · logic "ใครถูกเตือน" ไม่เปลี่ยน: กรองเวลา/ledger ต่อใน TS แล้วเข้าคิวด้วย dedupe_key เดิม
   *    · ⚠️ ยังไม่จำกัดย้อนหลัง — ทุกรอบ cron จึงไล่ charge ทั้งหมด (ซ้ำแล้ว enqueue คืน 0 ด้วย dedupe)
   *      ถ้าข้อมูลโตจนช้า ให้พิจารณาตัดช่วงย้อนหลังเป็น WO แยก (เปลี่ยนว่าใครถูกเตือน ⇒ ต้องให้เจ้าของงานตัดสิน)
   */
  let cursor: { createdAt: string; id: string } | null = null;

  for (;;) {
    let query = admin
      .from('session_charges')
      .select(
        `id, gang_id, amount, type, created_at,
       sessions!inner(id, title, ends_at, gangs!inner(settings, deleted_at)),
       session_registrations!inner(user_id),
       payment_allocations(amount, payments(status)),
       payment_adjustments(amount)`,
      )
      .eq('type', 'session')
      .not('session_registrations.user_id', 'is', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(pageSize);

    if (cursor) {
      query = query.or(
        `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as unknown as ChargeRow[];
    if (page.length === 0) break;

    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };

    const rows: NotificationRow[] = [];

    for (const charge of page) {
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

    created += await enqueue(rows);

    if (page.length < pageSize) break;
  }

  return created;
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
