'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { planMatches } from '@/domain/matching/pipeline';
import type { MatchPlayer } from '@/domain/matching/types';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function sessionContext(sessionId: string, userId: string) {
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, gang_id, status, court_count')
    .eq('id', sessionId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!session) throw new AppError('NOT_FOUND', 'ไม่พบนัดนี้');

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', session.gang_id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  return { session, role: (membership?.role as GangRole | undefined) ?? null };
}

async function registrationSession(registrationId: string) {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from('session_registrations')
    .select('id, session_id, status')
    .eq('id', registrationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!data) throw new AppError('REGISTRATION_NOT_FOUND', 'ไม่พบการลงชื่อนี้');
  return data;
}

/**
 * เช็คอิน — `confirmed → checked_in` เท่านั้น
 *
 * DB function บังคับอยู่แล้ว (`INVALID_REGISTRATION_TRANSITION`)
 * ที่นี่ตรวจสิทธิ์ก่อนเรียก และปล่อยให้ DB เป็นคนตัดสินเรื่อง state machine
 */
export async function checkIn(registrationId: string): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const reg = await registrationSession(registrationId);
    const { session, role } = await sessionContext(reg.session_id, user.id);

    assertCan({ role }, 'registration.checkin');

    const { data, error } = await supabaseAdmin().rpc('check_in_registration', {
      p_registration_id: registrationId,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${session.gang_id}/sessions/${reg.session_id}/console`);
    return { status: (data as { status: string }).status };
  });
}

/**
 * mark no-show
 *
 * ⚠️ ไม่ใช่ transition ที่มี DB function เฉพาะ — เขียนตรงผ่าน RLS ไม่ได้เพราะ
 *    `session_registrations` ไม่มี policy เขียน [D-13] ⇒ ใช้ admin client
 *    และตรวจสิทธิ์เองที่นี่
 */
export async function markNoShow(registrationId: string): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const reg = await registrationSession(registrationId);
    const { session, role } = await sessionContext(reg.session_id, user.id);

    assertCan({ role }, 'registration.no_show');

    if (!['confirmed', 'checked_in'].includes(reg.status)) {
      throw new AppError(
        'INVALID_REGISTRATION_TRANSITION',
        'ทำเครื่องหมายไม่มาได้เฉพาะคนที่ได้ที่หรือเช็คอินแล้ว',
      );
    }

    const rows = unwrap(
      await supabaseAdmin()
        .from('session_registrations')
        .update({ status: 'no_show', updated_by: user.id })
        .eq('id', registrationId)
        .select('id'),
    );

    revalidatePath(`/gangs/${session.gang_id}/sessions/${reg.session_id}/console`);
    return assertOne<{ id: string }>(rows);
  });
}

export type ConsoleQueueRow = {
  registration_id: string;
  display_name: string;
  is_guest: boolean;
  skill_rank: number | null;
  games_played: number;
  waiting_since: string;
  current_game_id: string | null;
};

/**
 * จัดคู่รอบใหม่จากคนที่ว่างอยู่
 *
 * 🔴 logic การจัดคู่อยู่ใน `domain/matching` ทั้งหมด — action นี้แค่
 *    เตรียม input → เรียก engine → เขียนผลลง `games`
 *    ❌ ห้ามตัดสินใจจับคู่เองที่นี่ (baseline: engine เป็น pure function)
 *
 * 🔴 เขียน `player1..player4` **ตามลำดับที่ engine คืนมาเป๊ะ ห้ามเรียงใหม่**
 *    ลำดับมีความหมายเรื่องทีม (ADR-003) — เรียงใหม่ = ทำลายสมดุลทีม
 */
export async function generateGames(
  sessionId: string,
): Promise<ApiResponse<{ created: number; benched: number }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const { session, role } = await sessionContext(sessionId, user.id);

    assertCan({ role }, 'game.manage');

    const admin = supabaseAdmin();

    const { data: queueData, error: queueError } = await admin.rpc('session_console_queue', {
      p_session_id: sessionId,
    });
    if (queueError) throw queueError;

    const queue = (queueData ?? []) as ConsoleQueueRow[];

    // คนที่กำลังอยู่ในคอร์ทไม่เข้าคิวรอบนี้
    const idle = queue.filter((row) => row.current_game_id === null);
    const busyCourts = new Set(
      queue.map((r) => r.current_game_id).filter((id): id is string => id !== null),
    ).size;

    const availableCourts = Math.max(0, session.court_count - busyCourts);
    if (availableCourts === 0) {
      throw new AppError('VALIDATION_ERROR', 'คอร์ทเต็มอยู่ — จบเกมก่อนถึงจะจัดรอบใหม่ได้');
    }

    const players: MatchPlayer[] = idle.map((row) => ({
      registrationId: row.registration_id,
      skillRank: row.skill_rank,
      gamesPlayed: row.games_played,
      waitingSince: new Date(row.waiting_since).getTime(),
    }));

    // เกมล่าสุดของนัดนี้ ไว้ให้ engine เลี่ยงจับชุดเดิมซ้ำ
    const { data: recent } = await admin
      .from('games')
      .select(
        'player1_registration_id, player2_registration_id, player3_registration_id, player4_registration_id',
      )
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(10);

    const recentGames = (recent ?? []).map((g) => [
      g.player1_registration_id,
      g.player2_registration_id,
      g.player3_registration_id,
      g.player4_registration_id,
    ]);

    const plan = planMatches({ players, availableCourts, recentGames });

    if (plan.games.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'คนว่างไม่พอจัดเกม (ต้องมีอย่างน้อย 4 คน)');
    }

    // เลขคอร์ทที่ยังว่างจริง — engine นับ 1..n ตามจำนวนเกม ไม่รู้ว่าคอร์ทไหนใช้อยู่
    const { data: activeGames } = await admin
      .from('games')
      .select('court_no')
      .eq('session_id', sessionId)
      .is('ended_at', null);

    const usedCourts = new Set((activeGames ?? []).map((g) => g.court_no));
    const freeCourts: number[] = [];
    for (let no = 1; no <= session.court_count && freeCourts.length < plan.games.length; no++) {
      if (!usedCourts.has(no)) freeCourts.push(no);
    }

    const rows = plan.games.map((game, index) => ({
      session_id: sessionId,
      court_no: freeCourts[index],
      // ⚠️ ลำดับนี้คือทีม A/B ตาม ADR-003 — ห้ามเรียงใหม่
      player1_registration_id: game.players[0],
      player2_registration_id: game.players[1],
      player3_registration_id: game.players[2],
      player4_registration_id: game.players[3],
      started_at: new Date().toISOString(),
      created_by: user.id,
    }));

    const inserted = unwrap(await admin.from('games').insert(rows).select('id'));

    revalidatePath(`/gangs/${session.gang_id}/sessions/${sessionId}/console`);
    return { created: inserted.length, benched: plan.benched.length };
  });
}

/** จบเกม + บันทึกจำนวนลูกที่ใช้ */
export async function finishGame(
  gameId: string,
  shuttlesUsed: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: game } = await admin
      .from('games')
      .select('id, session_id, ended_at')
      .eq('id', gameId)
      .maybeSingle();

    if (!game) throw new AppError('NOT_FOUND', 'ไม่พบเกมนี้');

    const { session, role } = await sessionContext(game.session_id, user.id);
    assertCan({ role }, 'game.manage');

    if (game.ended_at) throw new AppError('VALIDATION_ERROR', 'เกมนี้จบไปแล้ว');

    // ลูกแบ่งกันได้ ⇒ ทศนิยมถูกต้อง แต่ห้ามติดลบ
    const shuttles = Number(shuttlesUsed);
    if (!Number.isFinite(shuttles) || shuttles < 0) {
      throw new AppError('VALIDATION_ERROR', 'จำนวนลูกต้องเป็นตัวเลขไม่ติดลบ');
    }

    const rows = unwrap(
      await admin
        .from('games')
        .update({
          ended_at: new Date().toISOString(),
          shuttles_used: shuttlesUsed,
          updated_by: user.id,
        })
        .eq('id', gameId)
        .select('id'),
    );

    revalidatePath(`/gangs/${session.gang_id}/sessions/${game.session_id}/console`);
    return assertOne<{ id: string }>(rows);
  });
}

/** แอดมินสลับตัวในคอร์ท — override ผลของ engine ได้เสมอ */
export async function substitutePlayer(
  gameId: string,
  slot: number,
  registrationId: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const admin = supabaseAdmin();

    const { data: game } = await admin
      .from('games')
      .select('id, session_id')
      .eq('id', gameId)
      .maybeSingle();

    if (!game) throw new AppError('NOT_FOUND', 'ไม่พบเกมนี้');

    const { session, role } = await sessionContext(game.session_id, user.id);
    assertCan({ role }, 'game.manage');

    const { data, error } = await admin.rpc('substitute_game_player', {
      p_game_id: gameId,
      p_slot: slot,
      p_registration_id: registrationId,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${session.gang_id}/sessions/${game.session_id}/console`);
    return { id: (data as { id: string }).id };
  });
}
