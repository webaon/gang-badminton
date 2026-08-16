import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { moneyFromDb } from '@/lib/supabase/money';
import { summarize, type LedgerEntry } from '@/domain/billing/ledger';

/**
 * ข้อมูลของหน้า LIFF — **[WO-4.E]**
 *
 * 🔴 รับ `client` เข้ามาแทนที่จะสร้างเอง ⇒ หน้าเว็บส่ง **client ที่ผูก session ของผู้ใช้**
 *    เข้ามา ⇒ RLS ยังเป็นด่านจริงทุก query · ❌ ไม่มีการใช้ service-role ในเส้นทางนี้เลย
 *
 * 🔴 ยอดค้างอ่านผ่าน **ledger** (`domain/billing/ledger.ts`) เท่านั้น
 *    ❌ ห้ามนับจาก `payments.status` (ข้อตกลงตั้งแต่ Phase 2.5)
 */

export type LiffSessionView = {
  id: string;
  title: string;
  venue: string | null;
  startsAt: string;
  seatsLeft: number;
  myRegistration: { id: string; status: string } | null;
};

export type LiffView = {
  sessions: LiffSessionView[];
  /** ยอดที่ยังต้องจ่ายของผู้ใช้คนนี้ในก๊วนนี้ */
  outstanding: string;
};

type SessionRow = {
  id: string;
  title: string;
  venue: string | null;
  starts_at: string;
  max_players: number;
};

type RegistrationRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  status: string;
};

type ChargeRow = {
  id: string;
  amount: string | number;
  registration_id: string | null;
  gang_member_id: string | null;
  payment_allocations: { amount: string | number; payments: { status: string } | null }[];
  payment_adjustments: { amount: string | number }[];
};

export async function buildLiffView(
  client: SupabaseClient,
  input: { gangId: string; userId: string; gangMemberId: string | null; now?: Date },
): Promise<LiffView> {
  const { gangId, userId, gangMemberId, now = new Date() } = input;

  const { data: sessionRows } = await client
    .from('sessions')
    .select('id, title, venue, starts_at, max_players')
    .eq('gang_id', gangId)
    .eq('status', 'open')
    .is('deleted_at', null)
    .gte('starts_at', now.toISOString())
    .order('starts_at')
    .limit(5);

  const openSessions = (sessionRows ?? []) as SessionRow[];
  const sessionIds = openSessions.map((s) => s.id);

  const { data: registrationRows } = sessionIds.length
    ? await client
        .from('session_registrations')
        .select('id, session_id, user_id, status')
        .in('session_id', sessionIds)
        .is('deleted_at', null)
    : { data: [] };

  const registrations = (registrationRows ?? []) as RegistrationRow[];

  const sessions: LiffSessionView[] = openSessions.map((session) => {
    // ที่นั่งที่ใช้แล้ว = confirmed + checked_in [D-10] — ต้องตรงกับที่ DB function นับ
    const occupied = registrations.filter(
      (r) => r.session_id === session.id && ['confirmed', 'checked_in'].includes(r.status),
    ).length;

    const mine = registrations.find(
      (r) => r.session_id === session.id && r.user_id === userId && r.status !== 'cancelled',
    );

    return {
      id: session.id,
      title: session.title,
      venue: session.venue,
      startsAt: session.starts_at,
      seatsLeft: Math.max(session.max_players - occupied, 0),
      myRegistration: mine ? { id: mine.id, status: mine.status } : null,
    };
  });

  // ⚠️ ต้องดึงการลงชื่อ **ทั้งหมดของฉันในก๊วนนี้** ไม่ใช่แค่ของนัดที่เปิดอยู่
  //    ไม่งั้นหนี้จากนัดที่ปิดไปแล้ว (ซึ่งเป็นหนี้ส่วนใหญ่) จะหายจากยอด
  const { data: myRegRows } = await client
    .from('session_registrations')
    .select('id, sessions!inner(gang_id)')
    .eq('user_id', userId)
    .eq('sessions.gang_id', gangId)
    .is('deleted_at', null);

  const myRegistrationIds = new Set(
    ((myRegRows ?? []) as unknown as { id: string }[]).map((r) => r.id),
  );

  const { data: chargeRows } = await client
    .from('session_charges')
    .select(
      'id, amount, registration_id, gang_member_id, payment_allocations(amount, payments(status)), payment_adjustments(amount)',
    )
    .eq('gang_id', gangId);

  // ⚠️ แอดมินมองเห็น charge ของทั้งก๊วนตาม RLS ⇒ กรองให้เหลือของตัวเองที่นี่
  const mineOnly = ((chargeRows ?? []) as unknown as ChargeRow[]).filter(
    (c) =>
      (c.registration_id !== null && myRegistrationIds.has(c.registration_id)) ||
      (c.gang_member_id !== null && c.gang_member_id === gangMemberId),
  );

  const entries: LedgerEntry[] = mineOnly.map((c) => ({
    chargeId: c.id,
    // ⚠️ PostgREST คืน numeric เป็น JSON number ⇒ แปลงที่ขอบก่อนเข้า domain
    amount: moneyFromDb(c.amount),
    // 🔴 นับเฉพาะสลิปที่ยืนยันแล้ว — ไม่งั้นอัปสลิปปลอมแล้วหนี้หายทันที
    allocated: c.payment_allocations
      .filter((a) => a.payments?.status === 'verified')
      .map((a) => moneyFromDb(a.amount)),
    adjustments: c.payment_adjustments.map((a) => moneyFromDb(a.amount)),
  }));

  return { sessions, outstanding: summarize(entries).outstanding };
}
