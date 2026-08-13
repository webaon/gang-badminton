'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { assertAffected, runAction, unwrap } from '@/shared/action';

/**
 * กระดิ่ง in-app
 *
 * 🔴 ผู้ใช้เห็นเฉพาะของตัวเอง — policy `notifications_select_own` บังคับอยู่แล้ว
 *    และ action นี้ใช้ `supabaseServer()` (ใต้ RLS) ไม่ใช่ admin client
 *    ⇒ ไม่มีทางอ่านของคนอื่นแม้จะส่ง id มั่วมา
 */
export async function markNotificationRead(
  notificationId: string,
): Promise<ApiResponse<{ id: string }>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    await requireUser();
    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', notificationId)
        .is('read_at', null)
        .select('id'),
    );

    // 0 แถว = ไม่ใช่ของเรา หรืออ่านไปแล้ว — RLS ไม่ raise จึงต้องเช็คเอง
    const [row] = assertAffected(rows, 'NOT_FOUND', 'ไม่พบการแจ้งเตือนนี้ หรืออ่านไปแล้ว');

    revalidatePath('/notifications');
    return row as { id: string };
  });
}

export async function markAllRead(): Promise<ApiResponse<{ count: number }>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const rows = unwrap(
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('recipient_id', user.id)
        .is('read_at', null)
        .select('id'),
    );

    revalidatePath('/notifications');
    return { count: rows.length };
  });
}
