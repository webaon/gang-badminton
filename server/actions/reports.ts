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

/**
 * สถิติ/รายงาน — **[WO-3.A]**
 *
 * 🔴 baseline §ตาราง: `member_statistics` เป็น **แหล่งเดียวสำหรับการแสดงผล**
 *    ⇒ หน้าจออ่านจากตารางนั้น ไม่ query นับสด · ที่นี่มีแค่ปุ่มสั่งคำนวณใหม่
 */

/**
 * สั่งคำนวณสถิติของก๊วนใหม่เดี๋ยวนี้
 *
 * ⚠️ ปกติ cron ทำให้ทุกคืนอยู่แล้ว ปุ่มนี้มีไว้ตอนแอดมินเพิ่งปิดรอบแล้วอยากเห็นเลข
 * 🔴 กดซ้ำได้ไม่จำกัด — `rollup_member_statistics()` คำนวณใหม่ทั้งก้อนแล้ว upsert
 */
export async function recomputeGangStatistics(
  gangId: string,
): Promise<ApiResponse<{ members: number }>> {
  const correlationId = correlationIdFrom(await headers());

  return runAction(correlationId, async () => {
    const user = await requireUser();
    const supabase = await supabaseServer();

    const { data: membership } = await supabase
      .from('gang_members')
      .select('role')
      .eq('gang_id', gangId)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();

    assertCan({ role: (membership?.role as GangRole | undefined) ?? null }, 'gang.update');

    const { data, error } = await supabaseAdmin().rpc('rollup_member_statistics', {
      p_gang_id: gangId,
    });

    if (error) throw error;

    const members = Number(data ?? 0);

    // 🔴 ก๊วนที่ปิด `features.statistics` จะไม่ถูก rollup ⇒ ต้องบอกให้รู้
    //    ไม่ใช่ตอบ "สำเร็จ 0 คน" เฉยๆ แล้วปล่อยให้งง (CLAUDE.md §3 — flag ต้องมีผลจริง)
    if (members === 0) {
      const { data: gang } = await supabase
        .from('gangs')
        .select('features')
        .eq('id', gangId)
        .maybeSingle();

      const features = (gang?.features ?? {}) as Record<string, unknown>;
      if (features.statistics === false) {
        throw new AppError('FEATURE_DISABLED', 'ก๊วนนี้ปิดสถิติไว้ — เปิดในหน้าตั้งค่าก่อน');
      }
    }

    revalidatePath(`/gangs/${gangId}/settings`);
    return { members };
  });
}
