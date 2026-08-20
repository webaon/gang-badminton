'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { assertCan } from '@/domain/permissions/can';
import type { GangFeatures, GangRole } from '@/domain/permissions/types';
import { enforceRateLimit } from '@/server/security/rate-limit';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { runAction } from '@/shared/action';

/**
 * Discovery + คำขอเข้าก๊วน — **[WO-3.E]**
 *
 * 🔴 `join_requests` เขียนผ่าน DB function เท่านั้น (migration 0033 ถอน INSERT/UPDATE
 *    ของ `authenticated` ออกแล้ว) ⇒ ที่นี่เรียก RPC ล้วน ไม่มี `.insert()` / `.update()`
 *
 * 🔴 ก๊วนที่ `is_public = false` หรือปิด `features.discovery` **ไม่โผล่ในผลค้นหา**
 *    บังคับใน `search_public_gangs()` ⇒ ยิง action ตรงก็ผ่านด่านเดียวกัน ไม่ใช่แค่ UI ซ่อน
 */

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

export type GangSearchResult = {
  id: string;
  name: string;
  description: string | null;
  area: string | null;
  memberCount: number;
  /** 'member' = อยู่ก๊วนนี้แล้ว · 'pending' = ขอไปแล้วรออยู่ · null = ขอได้ */
  viewerStatus: 'member' | 'pending' | null;
};

type SearchRow = {
  id: string;
  name: string;
  description: string | null;
  area: string | null;
  member_count: number;
  viewer_status: 'member' | 'pending' | null;
};

/**
 * ค้นก๊วนสาธารณะ — **เปิดให้คนที่ยังไม่ล็อกอินค้นได้** (หน้า discovery เป็นทางเข้าของคนใหม่)
 *
 * คนที่ล็อกอินอยู่จะได้ `viewerStatus` ติดมาด้วย เพื่อไม่ให้ปุ่ม "ขอเข้าก๊วน" โผล่
 * ในก๊วนที่ตัวเองอยู่แล้วหรือขอค้างไว้อยู่
 */
export async function searchGangs(query: string): Promise<ApiResponse<GangSearchResult[]>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    // ❗ ไม่ใช้ `requireUser()` — หน้านี้เปิดสาธารณะ ⇒ ไม่มี user ก็ค้นได้
    // 🔴 **[WO-5.C]** จึงต้องมีเพดานต่อ IP: query นี้เป็น trgm บนตารางก๊วนทั้งแพลตฟอร์ม
    //    ปล่อยไว้เท่ากับเปิดให้ใครก็ได้ยิงงานหนักใส่ฐานข้อมูลฟรีๆ
    await enforceRateLimit({
      scope: 'discovery:search',
      headers: await headers(),
      limit: 30,
      window: '1 minute',
    });

    const user = await currentUser();

    const { data, error } = await supabaseAdmin().rpc('search_public_gangs', {
      p_query: query,
      p_limit: 20,
      p_viewer_id: user?.id ?? null,
    });

    if (error) throw error;

    return ((data ?? []) as SearchRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      area: row.area,
      memberCount: row.member_count,
      viewerStatus: row.viewer_status,
    }));
  });
}

/**
 * ขอเข้าก๊วน
 *
 * ขอซ้ำระหว่างที่ใบเดิมยังรออยู่ = ได้ใบเดิมกลับมา (ฟังก์ชันเป็น idempotent)
 * ⇒ ไม่ต้องเช็คก่อนยิงในหน้าจอ ซึ่งเป็น check-then-act ที่แข่งกันเองได้
 */
export async function requestToJoin(
  gangId: string,
  message?: string,
): Promise<ApiResponse<{ requestId: string; status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();

    const { data, error } = await supabaseAdmin().rpc('request_to_join_gang', {
      p_gang_id: gangId,
      p_user_id: user.id,
      p_message: message ?? null,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const row = data as { id: string; status: string };
    revalidatePath('/discover');
    return { requestId: row.id, status: row.status };
  });
}

/** ยกเลิกคำขอของตัวเอง — ใบที่แอดมินตัดสินไปแล้วยกเลิกไม่ได้ (`INVALID_TRANSITION`) */
export async function cancelJoinRequest(
  requestId: string,
): Promise<ApiResponse<{ requestId: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const user = await requireUser();

    const { error } = await supabaseAdmin().rpc('cancel_join_request', {
      p_request_id: requestId,
      p_actor_id: user.id,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath('/discover');
    return { requestId };
  });
}

async function assertJoinRequestAdmin(gangId: string): Promise<string> {
  const user = await requireUser();
  const supabase = await supabaseServer();

  const { data: membership } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  const { data: gang } = await supabase
    .from('gangs')
    .select('features')
    .eq('id', gangId)
    .is('deleted_at', null)
    .maybeSingle();

  assertCan(
    {
      role: (membership?.role as GangRole | undefined) ?? null,
      features: (gang?.features ?? {}) as Partial<GangFeatures>,
    },
    'gang.join_request.manage',
  );

  return user.id;
}

/**
 * อนุมัติ / ปฏิเสธคำขอ
 *
 * 🔴 `decide_join_request()` เป็นจุดเดียวที่คำขอกลายเป็นสมาชิก — ห้ามเพิ่ม
 *    `gang_members` จากที่นี่เอง (ไม่งั้นสถานะคำขอกับสมาชิกจะหลุดจากกันได้)
 */
export async function decideJoinRequest(
  gangId: string,
  requestId: string,
  decision: 'approved' | 'rejected',
): Promise<ApiResponse<{ requestId: string; status: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const actorId = await assertJoinRequestAdmin(gangId);

    // 🔴 `p_gang_id` ผูกคำขอกับก๊วนที่ตรวจสิทธิ์มาแล้ว **ในธุรกรรมเดียวกัน**
    //    ⇒ ยิง id ของคำขอก๊วนอื่นมา จะได้ NOT_FOUND โดยยังไม่มีสมาชิกถูกสร้าง
    //    (ถ้าไปเช็คหลังฟังก์ชันทำงาน สมาชิกเกิดไปแล้ว error ก็สายเกินไป)
    const { data, error } = await supabaseAdmin().rpc('decide_join_request', {
      p_request_id: requestId,
      p_gang_id: gangId,
      p_decision: decision,
      p_actor_id: actorId,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const row = data as { id: string; status: string };

    revalidatePath(`/gangs/${gangId}/join-requests`);
    revalidatePath(`/gangs/${gangId}/members`);
    return { requestId: row.id, status: row.status };
  });
}
