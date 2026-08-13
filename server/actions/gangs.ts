'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import {
  toJson as cancellationToJson,
  validate as validateCancellation,
  type CancellationPolicy,
} from '@/domain/policies/cancellation';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

/**
 * Server actions ของก๊วน — shell ตาม CLAUDE.md §3
 *
 * 🔴 กติกาสองข้อที่ทุกฟังก์ชันในไฟล์นี้ยึด (ข้อจำกัดจาก Phase 1):
 *
 *   1. **ตรวจสิทธิ์ด้วย `can()` ก่อนใช้ `supabaseAdmin()` เสมอ**
 *      admin client bypass RLS ⇒ ถ้าไม่ตรวจเองก็ไม่มีใครตรวจให้
 *
 *   2. **mutation ผ่าน `supabaseServer()` + `.select()` + `assertOne()`**
 *      RLS ไม่ raise error แต่คืน 0 แถว ⇒ ไม่เช็คจำนวนแถว = ตอบ "บันทึกแล้ว"
 *      ทั้งที่ไม่มีอะไรเปลี่ยน
 */

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

/** อ่าน role ของผู้ใช้ปัจจุบันในก๊วนนั้น (null = ไม่ได้เป็นสมาชิก) */
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

export type CreateGangInput = {
  name: string;
  area?: string;
  timezone?: string;
};

export async function createGang(input: CreateGangInput): Promise<ApiResponse<{ gangId: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();

    if (input.name.trim() === '') {
      throw new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อก๊วน');
    }

    // 🔴 ส่ง id จาก session เท่านั้น — ห้ามรับ owner id จาก client
    const { data, error } = await supabaseAdmin().rpc('create_gang', {
      p_owner_id: user.id,
      p_name: input.name,
      p_area: input.area ?? null,
      p_timezone: input.timezone ?? 'Asia/Bangkok',
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const gang = data as { id: string } | null;
    if (!gang) throw new AppError('INTERNAL_ERROR', 'create_gang ไม่คืนค่าก๊วน');

    revalidatePath('/gangs');
    return { gangId: gang.id };
  });
}

export type GangSettingsInput = {
  name: string;
  area: string | null;
  isPublic: boolean;
  promptpayId: string | null;
  timezone: string;
  cancellationPolicy: CancellationPolicy;
};

export async function updateGangSettings(
  gangId: string,
  input: GangSettingsInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();

    const role = await roleInGang(gangId, user.id);
    assertCan({ role }, 'gang.update');

    if (input.name.trim() === '') {
      throw new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อก๊วน');
    }

    const issues = validateCancellation(input.cancellationPolicy);
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', issues.map((i) => i.message).join(' · '));
    }

    const supabase = await supabaseServer();

    // ใช้ client ที่ผูก session ⇒ RLS เป็นด่านสุดท้ายถ้า can() พลาด
    const rows = unwrap(
      await supabase
        .from('gangs')
        .update({
          name: input.name.trim(),
          area: input.area?.trim() || null,
          is_public: input.isPublic,
          promptpay_id: input.promptpayId?.trim() || null,
          timezone: input.timezone,
          cancellation_policy: cancellationToJson(input.cancellationPolicy),
          updated_by: user.id,
        })
        .eq('id', gangId)
        .is('deleted_at', null)
        .select('id'),
    );

    const row = assertOne<{ id: string }>(rows);

    revalidatePath(`/gangs/${gangId}/settings`);
    return { id: row.id };
  });
}

/** ก๊วนทั้งหมดที่ผู้ใช้ปัจจุบันเป็นสมาชิก — RLS กรองให้เองอยู่แล้ว */
export async function listMyGangs(): Promise<
  ApiResponse<Array<{ id: string; name: string; role: GangRole }>>
> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data, error } = await supabase
      .from('gang_members')
      .select('role, gangs!inner(id, name)')
      .eq('user_id', user.id)
      .is('deleted_at', null);

    if (error) throw error;

    type Row = { role: GangRole; gangs: { id: string; name: string } };
    return ((data ?? []) as unknown as Row[]).map((r) => ({
      id: r.gangs.id,
      name: r.gangs.name,
      role: r.role,
    }));
  });
}
