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
  /**
   * **[ADR-011]** แอดมินยกเลิกแทนแบบ "ไม่คิดค่าปรับ" — ต้องมีเหตุผล
   * (ใช้ตอน "เปลี่ยนคน": ส่ง `promoteRegistrationId` = B มาด้วยเพื่อเลื่อน B ใน transaction เดียวกัน)
   * ❌ ไม่ใช่ช่องให้สมาชิกยกเว้นค่าปรับให้ตัวเอง — `cancel_registration()` ตรวจสิทธิ์แอดมินซ้ำใน DB
   */
  options: { waivePenalty?: boolean; reason?: string; promoteRegistrationId?: string } = {},
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

    const waive = options.waivePenalty === true;
    if (waive) {
      // ยกเว้นค่าปรับ = งานแอดมิน แม้จะยกเลิกของตัวเอง · ต้องมีเหตุผล (DB ตรวจซ้ำ)
      assertCan({ role }, 'registration.cancel.other');
      if (!options.reason?.trim()) {
        throw new AppError('VALIDATION_ERROR', 'ต้องระบุเหตุผลที่ไม่คิดค่าปรับ');
      }
    }

    const promoteId = options.promoteRegistrationId;
    if (promoteId) {
      // "เปลี่ยนคน": ยกเลิกคนนี้แล้วเลื่อนคนที่เลือกใน transaction เดียว (DB ตรวจสิทธิ์แอดมิน/ที่ว่างซ้ำ)
      assertCan({ role }, 'registration.promote.other');
    }

    const { data, error } = await supabaseAdmin().rpc('cancel_registration', {
      p_registration_id: registrationId,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
      p_waive_penalty: waive,
      p_reason: waive ? options.reason!.trim() : null,
      p_promote_registration_id: promoteId ?? null,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${gangId}/sessions/${reg.session_id}`);
    return { status: (data as { status: string }).status };
  });
}

/**
 * ดูผลก่อนยกเลิก (read-only) — หน้าจอ 6.2 ใช้บอกผู้ใช้ว่า "ยกเลิกฟรีถึงเมื่อไหร่ / จะโดนปรับ / ยกเลิกไม่ได้"
 *
 * 🔴 ไม่คำนวณ cutoff/grace ใน TS — `fromJson()` ให้ default grace 3 ชม. กับนัดเก่าที่ DB ถือเป็น 0
 *    ตัดสินใน `preview_cancel_registration()` ซึ่งเรียกตัวตัดสินเดียวกับ `cancel_registration()`
 * ไม่คืนจำนวนเงิน — แสดงเฉพาะประเภท/เวลา (เงินคิดตอนปิดรอบ ADR-001)
 */
export type CancelPreview = {
  outcome: 'free_in_grace' | 'free_before_cutoff' | 'penalty' | 'blocked';
  /** ยกเลิกฟรีได้ถึงเมื่อไหร่ (ISO) — null = ไม่มีเส้นตาย/ไม่ฟรี */
  freeUntil: string | null;
  penaltyType: string | null;
  reason: 'waitlist' | 'before_cutoff' | 'promoted_grace' | 'late_cancel' | 'cutoff_passed';
};

export async function cancelPreview(registrationId: string): Promise<ApiResponse<CancelPreview>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: reg } = await supabase
      .from('session_registrations')
      .select('id, user_id, sessions!inner(gang_id)')
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
    // สิทธิ์เดียวกับการยกเลิกจริง
    assertCan({ role }, reg.user_id === user.id ? 'registration.cancel.self' : 'registration.cancel.other');

    const { data, error } = await supabaseAdmin().rpc('preview_cancel_registration', {
      p_registration_id: registrationId,
      p_actor_id: user.id,
    });

    if (error) throw error;

    const p = data as {
      outcome: CancelPreview['outcome'];
      free_until: string | null;
      penalty_type: string | null;
      reason: CancelPreview['reason'];
    };
    return { outcome: p.outcome, freeUntil: p.free_until, penaltyType: p.penalty_type, reason: p.reason };
  });
}

/**
 * แอดมินเลือกเลื่อนคนจาก waitlist เอง (ข้ามลำดับคิว) **[WO-B11 · ADR-011]**
 *
 * 🔴 ยังเป็นทางเลื่อนคิวทางเดียว — เรียก `promote_waitlist(p_registration_id)` ตัวเดิม
 *    (lock session → ตรวจสิทธิ์แอดมิน + มีที่ว่างจริงใน DB) ไม่เช็คที่ว่างใน TS
 * ไม่มีที่ว่าง = `SESSION_FULL` · "เปลี่ยนคน" = `cancelRegistration(A, { waivePenalty, reason, promoteRegistrationId: B })`
 * (ยกเลิก A + เลื่อน B ใน transaction เดียว — แยกเป็นสองคำสั่งไม่ได้ เพราะหัวคิวจะได้ที่ของ A ก่อน)
 */
export async function promoteRegistration(
  registrationId: string,
): Promise<ApiResponse<{ status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: reg } = await supabase
      .from('session_registrations')
      .select('id, session_id, sessions!inner(gang_id)')
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

    assertCan(
      { role: (membership?.role as GangRole | undefined) ?? null },
      'registration.promote.other',
    );

    const { data, error } = await supabaseAdmin().rpc('promote_waitlist', {
      p_session_id: reg.session_id,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
      p_registration_id: registrationId,
    });

    if (error) throw error;

    const promoted = (data as { status: string }[] | null)?.[0];
    if (!promoted) throw new AppError('INTERNAL_ERROR', 'promote_waitlist ไม่คืนแถวที่เลื่อน');

    revalidatePath(`/gangs/${gangId}/sessions/${reg.session_id}`);
    return { status: promoted.status };
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
