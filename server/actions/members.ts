'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import { GANG_ROLES, type GangRole } from '@/domain/permissions/types';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function roleInGang(gangId: string, userId: string): Promise<GangRole | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  return (data?.role as GangRole | undefined) ?? null;
}

/**
 * เพิ่มสมาชิกด้วยอีเมล [D-18]
 *
 * ⚠️ เชิญได้เฉพาะคนที่**มีบัญชีอยู่แล้ว** — ลิงก์เชิญเข้าก๊วนเป็นงาน Phase 3
 * ⚠️ ถ้าหาไม่เจอจะได้ `NOT_FOUND` ที่ไม่บอกว่าอีเมลนั้นมีบัญชีหรือไม่ (กัน user enumeration)
 */
export async function addMemberByEmail(
  gangId: string,
  email: string,
  role: GangRole = 'member',
): Promise<ApiResponse<{ memberId: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'gang.member.manage');

    const { data, error } = await supabaseAdmin().rpc('add_gang_member_by_email', {
      p_gang_id: gangId,
      p_email: email,
      p_role: role,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const member = data as { id: string } | null;
    if (!member) throw new AppError('INTERNAL_ERROR', 'add_gang_member_by_email ไม่คืนค่าสมาชิก');

    revalidatePath(`/gangs/${gangId}/members`);
    return { memberId: member.id };
  });
}

export async function changeMemberRole(
  gangId: string,
  memberId: string,
  role: GangRole,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'gang.member.manage');

    if (!GANG_ROLES.includes(role)) {
      throw new AppError('VALIDATION_ERROR', 'role ไม่ถูกต้อง');
    }

    const supabase = await supabaseServer();

    // 🔴 กันก๊วนไร้เจ้าของ: ถ้าแถวนี้เป็น owner คนสุดท้าย ห้ามลดขั้น
    //    ก๊วนที่ไม่มี owner/admin เหลือ = ไม่มีใครแก้อะไรได้อีกเลย (policy ต้องการ is_gang_admin)
    if (role !== 'owner') {
      const { count } = await supabase
        .from('gang_members')
        .select('id', { count: 'exact', head: true })
        .eq('gang_id', gangId)
        .eq('role', 'owner')
        .is('deleted_at', null);

      const { data: target } = await supabase
        .from('gang_members')
        .select('role')
        .eq('id', memberId)
        .maybeSingle();

      if (target?.role === 'owner' && (count ?? 0) <= 1) {
        throw new AppError('VALIDATION_ERROR', 'ก๊วนต้องมี owner อย่างน้อยหนึ่งคน');
      }
    }

    const rows = unwrap(
      await supabase
        .from('gang_members')
        .update({ role, updated_by: user.id })
        .eq('id', memberId)
        .eq('gang_id', gangId)
        .is('deleted_at', null)
        .select('id'),
    );

    const row = assertOne<{ id: string }>(rows);

    revalidatePath(`/gangs/${gangId}/members`);
    return { id: row.id };
  });
}

/** เอาสมาชิกออกจากก๊วน — soft delete ตามกติกา (ประวัติเงินต้องอยู่ครบ) */
export async function removeMember(
  gangId: string,
  memberId: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'gang.member.manage');

    const supabase = await supabaseServer();

    const { data: target } = await supabase
      .from('gang_members')
      .select('role')
      .eq('id', memberId)
      .eq('gang_id', gangId)
      .maybeSingle();

    if (target?.role === 'owner') {
      const { count } = await supabase
        .from('gang_members')
        .select('id', { count: 'exact', head: true })
        .eq('gang_id', gangId)
        .eq('role', 'owner')
        .is('deleted_at', null);

      if ((count ?? 0) <= 1) {
        throw new AppError('VALIDATION_ERROR', 'เอา owner คนสุดท้ายออกไม่ได้');
      }
    }

    const rows = unwrap(
      await supabase
        .from('gang_members')
        .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
        .eq('id', memberId)
        .eq('gang_id', gangId)
        .is('deleted_at', null)
        .select('id'),
    );

    const row = assertOne<{ id: string }>(rows);

    revalidatePath(`/gangs/${gangId}/members`);
    return { id: row.id };
  });
}
