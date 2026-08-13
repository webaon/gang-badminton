'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import {
  toJson as recurrenceToJson,
  validate as validateRecurrence,
  type Recurrence,
} from '@/domain/sessions/recurrence';
import { generateForTemplate } from '@/server/templates/generate';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, assertOne, runAction, unwrap } from '@/shared/action';

/**
 * ตารางนัดประจำ — **[WO-2.5-E]**
 *
 * ⚠️ แก้ตารางมีผลกับ**นัดที่ยังไม่ถูกสร้าง**เท่านั้น
 *    นัดที่ generate ไปแล้วเป็นของมันเอง (แก้ได้ทีละนัดตามปกติ)
 *    — ไม่ใช่ข้อจำกัดทางเทคนิค แต่เป็นเจตนา: คนลงชื่อไปแล้วต้องไม่ถูกย้ายเวลาเงียบๆ
 */

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

export type TemplateInput = {
  name: string;
  recurrence: Recurrence;
  venue: string | null;
  courtCount: number;
  maxPlayers: number;
  allowGuests: boolean;
  isActive?: boolean;
};

function assertValid(input: TemplateInput): void {
  if (input.name.trim() === '') throw new AppError('VALIDATION_ERROR', 'ต้องระบุชื่อตาราง');

  const issues = validateRecurrence(input.recurrence);
  if (issues.length > 0) {
    throw new AppError('VALIDATION_ERROR', issues.map((i) => i.message).join(' · '));
  }

  if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < 1) {
    throw new AppError('VALIDATION_ERROR', 'จำนวนคนสูงสุดต้องเป็นจำนวนเต็มตั้งแต่ 1');
  }
  if (!Number.isInteger(input.courtCount) || input.courtCount < 1) {
    throw new AppError('VALIDATION_ERROR', 'จำนวนคอร์ทต้องเป็นจำนวนเต็มตั้งแต่ 1');
  }
}

export async function createTemplate(
  gangId: string,
  input: TemplateInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'session.create');
    assertValid(input);

    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('session_templates')
        .insert({
          gang_id: gangId,
          name: input.name.trim(),
          recurrence: recurrenceToJson(input.recurrence),
          venue: input.venue?.trim() || null,
          court_count: input.courtCount,
          max_players: input.maxPlayers,
          allow_guests: input.allowGuests,
          is_active: input.isActive ?? true,
          created_by: user.id,
        })
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/templates`);
    return assertOne<{ id: string }>(rows);
  });
}

export async function updateTemplate(
  gangId: string,
  templateId: string,
  input: TemplateInput,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'session.update');
    assertValid(input);

    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('session_templates')
        .update({
          name: input.name.trim(),
          recurrence: recurrenceToJson(input.recurrence),
          venue: input.venue?.trim() || null,
          court_count: input.courtCount,
          max_players: input.maxPlayers,
          allow_guests: input.allowGuests,
          is_active: input.isActive ?? true,
          updated_by: user.id,
        })
        .eq('id', templateId)
        .eq('gang_id', gangId)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/templates`);
    return assertOne<{ id: string }>(rows);
  });
}

/**
 * ปิดตาราง — ไม่ลบทิ้ง
 *
 * ⚠️ นัดที่ generate ไปแล้วยังอยู่ (คนลงชื่อไว้แล้ว) — ปิดตารางแค่หยุดสร้างรอบใหม่
 */
export async function setTemplateActive(
  gangId: string,
  templateId: string,
  isActive: boolean,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'session.update');

    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('session_templates')
        .update({ is_active: isActive, updated_by: user.id })
        .eq('id', templateId)
        .eq('gang_id', gangId)
        .select('id'),
    );

    revalidatePath(`/gangs/${gangId}/templates`);
    return assertOne<{ id: string }>(rows);
  });
}

/**
 * สั่ง generate เดี๋ยวนี้ — ปกติ cron ทำให้เองทุกวัน
 *
 * 🔴 กดซ้ำได้ไม่จำกัด: unique index `(template_id, starts_at)` กันนัดซ้ำที่ระดับฐานข้อมูล
 */
export async function generateNow(
  gangId: string,
  templateId: string,
): Promise<ApiResponse<{ created: number; skipped: number }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();
    assertCan({ role: await roleInGang(gangId, user.id) }, 'session.create');

    const outcome = await generateForTemplate({ templateId, correlationId, actorId: user.id });

    if (!outcome) {
      throw new AppError('NOT_FOUND', 'ไม่พบตารางนี้ หรือตารางถูกปิดอยู่');
    }

    revalidatePath(`/gangs/${gangId}/templates`);
    revalidatePath(`/gangs/${gangId}/sessions`);
    return { created: outcome.created, skipped: outcome.skipped };
  });
}
