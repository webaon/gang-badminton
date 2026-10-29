import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { can } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import type { ConsoleQueueRow } from '@/server/actions/game-console';

/**
 * loader ของคอนโซลวันเล่น — **ใช้ร่วมกัน** ระหว่าง `console/page.tsx` กับ `console/board/page.tsx` [WO-6.4a]
 *
 * กระดานคิวสด (hi-fi 24) เห็นข้อมูลชุดเดียวกับคอนโซล ด้วยสิทธิ์เดียวกัน (`game.manage`) —
 * ไม่ใช่หน้า public และไม่มี query ใหม่: ทุกอย่างย้ายมาจาก `console/page.tsx` เดิมโดยไม่เปลี่ยนเงื่อนไข
 *
 * 🔴 ที่นี่คือด่านสิทธิ์ของทั้งสองหน้า: ไม่ล็อกอิน → /sign-in (กลับมาที่ `nextPath`) · ไม่พบนัด → 404 ·
 *    ไม่มี `game.manage` → กลับหน้ารายละเอียดนัด (เหมือนคอนโซลเดิม)
 */

export type ConsoleSession = { id: string; title: string; status: string; courtCount: number };

export type ConsoleGameData = {
  id: string;
  courtNo: number;
  /** ลำดับมีความหมาย: [0]&[1] = ทีม A · [2]&[3] = ทีม B (ADR-003) */
  players: { registrationId: string; displayName: string }[];
};

export type ConsoleData = {
  session: ConsoleSession;
  queue: ConsoleQueueRow[];
  pendingCheckIn: { registrationId: string; displayName: string }[];
  games: ConsoleGameData[];
  finishedGames: { id: string; courtNo: number; shuttlesUsed: string }[];
  /** เวลา ณ ตอน render (ISO) — ใช้คำนวณ "พักมา N นาที" ให้ SSR กับ hydrate ตรงกัน */
  now: string;
  /** แสดงลิงก์ "ปิดรอบ" บนคอนโซลหรือไม่ — แค่การแสดงผล (หน้า /close ตรวจ `billing.close` ซ้ำฝั่ง server) */
  canClose: boolean;
};

export async function loadConsole(gangId: string, sessionId: string, nextPath: string): Promise<ConsoleData> {
  const user = await requireUser(nextPath);
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, title, status, court_count')
    .eq('id', sessionId)
    .eq('gang_id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) notFound();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const role = (membership?.role as GangRole | undefined) ?? null;

  // คอนโซล/กระดานเป็นเครื่องมือของแอดมิน — สมาชิกทั่วไปให้กลับไปหน้ารายละเอียดนัด
  if (!can({ role }, 'game.manage')) {
    redirect(`/gangs/${gangId}/sessions/${sessionId}`);
  }

  const admin = supabaseAdmin();

  const { data: queueData } = await admin.rpc('session_console_queue', { p_session_id: sessionId });
  const queue = (queueData ?? []) as ConsoleQueueRow[];

  // คนที่ได้ที่แล้วแต่ยังไม่เช็คอิน
  const { data: pending } = await supabase
    .from('session_registrations')
    // 🔴 ระบุ FK เสมอ — ดูเหตุผลใน `app/gangs/[gangId]/sessions/[sessionId]/page.tsx`
    .select('id, guest_name, profiles!session_registrations_user_id_fkey(display_name)')
    .eq('session_id', sessionId)
    .eq('status', 'confirmed')
    .is('deleted_at', null);

  type PendingRow = {
    id: string;
    guest_name: string | null;
    profiles: { display_name: string } | null;
  };

  const pendingCheckIn = ((pending ?? []) as unknown as PendingRow[]).map((r) => ({
    registrationId: r.id,
    displayName: r.profiles?.display_name ?? r.guest_name ?? 'ไม่ทราบชื่อ',
  }));

  const { data: activeGames } = await admin
    .from('games')
    .select(
      'id, court_no, player1_registration_id, player2_registration_id, player3_registration_id, player4_registration_id',
    )
    .eq('session_id', sessionId)
    .is('ended_at', null)
    .order('court_no');

  // เกมที่จบแล้ว — ให้แอดมินแก้จำนวนลูกก่อนปิดรอบ [WO-2.5-A]
  const { data: endedGames } = await admin
    .from('games')
    .select('id, court_no, shuttles_used')
    .eq('session_id', sessionId)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(50);

  const finishedGames = (endedGames ?? []).map((g) => ({
    id: g.id as string,
    courtNo: g.court_no as number,
    shuttlesUsed: String(g.shuttles_used ?? '0'),
  }));

  const nameOf = new Map(queue.map((r) => [r.registration_id, r.display_name]));

  const games: ConsoleGameData[] = (activeGames ?? []).map((g) => ({
    id: g.id as string,
    courtNo: g.court_no as number,
    // ⚠️ เรียงตามคอลัมน์เป๊ะ — ลำดับคือทีม A/B (ADR-003)
    players: [
      g.player1_registration_id,
      g.player2_registration_id,
      g.player3_registration_id,
      g.player4_registration_id,
    ].map((id) => ({ registrationId: id as string, displayName: nameOf.get(id as string) ?? 'ไม่ทราบชื่อ' })),
  }));

  return {
    session: {
      id: session.id as string,
      title: session.title as string,
      status: session.status as string,
      courtCount: session.court_count as number,
    },
    queue,
    pendingCheckIn,
    games,
    finishedGames,
    now: new Date().toISOString(),
    canClose: can({ role }, 'billing.close'),
  };
}
