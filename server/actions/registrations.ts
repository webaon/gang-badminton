'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

/** ข้อมูลนัด + role ของผู้ใช้ในก๊วนนั้น — ใช้ตัดสินสิทธิ์ก่อนเรียก DB function */
async function sessionContext(sessionId: string, userId: string) {
  const supabase = await supabaseServer();

  const { data: session } = await supabase
    .from('sessions')
    .select('id, gang_id, status')
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

  return {
    session,
    role: (membership?.role as GangRole | undefined) ?? null,
  };
}

/**
 * ลงชื่อเข้านัดของตัวเอง
 *
 * 🔴 ห้ามนับที่ว่างที่นี่ — `register_to_session()` ถือ lock แถว session แล้วนับเอง
 *    (CLAUDE.md §2.1) action ตัวนี้เป็น shell ล้วน
 */
export async function registerSelf(sessionId: string): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const { session, role } = await sessionContext(sessionId, user.id);

    assertCan({ role }, 'registration.create.self');

    const { data, error } = await supabaseAdmin().rpc('register_to_session', {
      p_session_id: sessionId,
      p_user_id: user.id,
      p_registered_by: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${session.gang_id}/sessions/${sessionId}`);
    return { status: (data as { status: string }).status };
  });
}

/** แอดมินลงชื่อแทนสมาชิกคนอื่น — `registered_by` บันทึกว่าใครเป็นคนลงให้ */
export async function registerMember(
  sessionId: string,
  memberUserId: string,
): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const { session, role } = await sessionContext(sessionId, user.id);

    assertCan({ role }, 'registration.create.other');

    const { data, error } = await supabaseAdmin().rpc('register_to_session', {
      p_session_id: sessionId,
      p_user_id: memberUserId,
      p_registered_by: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${session.gang_id}/sessions/${sessionId}`);
    return { status: (data as { status: string }).status };
  });
}

/**
 * ยกเลิกการลงชื่อ
 *
 * ตัวเองยกเลิกได้เสมอ · แอดมินยกเลิกแทนคนอื่นได้
 * penalty/cutoff/promote ทั้งหมดอยู่ใน `cancel_registration()` — ที่นี่ไม่ตัดสินอะไร
 */
export async function cancelRegistration(
  registrationId: string,
): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: reg } = await supabase
      .from('session_registrations')
      .select('id, user_id, session_id, sessions!inner(gang_id)')
      .eq('id', registrationId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!reg) throw new AppError('REGISTRATION_NOT_FOUND', 'ไม่พบการลงชื่อนี้');

    const gangId = (reg as unknown as { sessions: { gang_id: string } }).sessions.gang_id;

    const { data: membership } = await supabase
      .from('gang_members')
      .select('role')
      .eq('gang_id', gangId)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();

    const role = (membership?.role as GangRole | undefined) ?? null;
    const isSelf = reg.user_id === user.id;

    assertCan({ role }, isSelf ? 'registration.cancel.self' : 'registration.cancel.other');

    const { data, error } = await supabaseAdmin().rpc('cancel_registration', {
      p_registration_id: registrationId,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${gangId}/sessions/${reg.session_id}`);
    return { status: (data as { status: string }).status };
  });
}

/**
 * สร้างลิงก์เชิญ guest
 *
 * 🔴 คืน plaintext **ครั้งเดียว** — ระบบเก็บแค่ hash หลังจากนี้อ่านย้อนหลังไม่ได้
 *    ⇒ UI ต้องบอกผู้ใช้ให้คัดลอกเก็บไว้ทันที
 */
export async function createInviteLink(
  sessionId: string,
  maxUses = 20,
): Promise<ApiResponse<{ token: string; expiresAt: string; maxUses: number }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const { session, role } = await sessionContext(sessionId, user.id);

    // feature flag `guests` ถูกตรวจใน can() และใน register_to_session() อีกชั้น
    assertCan({ role, features: await gangFeatures(session.gang_id) }, 'session.invite.manage');

    const { data, error } = await supabaseAdmin().rpc('create_session_invite', {
      p_session_id: sessionId,
      p_max_uses: maxUses,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const row = (data as Array<{ token: string; expires_at: string; max_uses: number }> | null)?.[0];
    if (!row) throw new AppError('INTERNAL_ERROR', 'create_session_invite ไม่คืนค่า');

    return { token: row.token, expiresAt: row.expires_at, maxUses: row.max_uses };
  });
}

async function gangFeatures(gangId: string) {
  const supabase = await supabaseServer();
  const { data } = await supabase.from('gangs').select('features').eq('id', gangId).maybeSingle();
  return (data?.features ?? {}) as Record<string, boolean>;
}
