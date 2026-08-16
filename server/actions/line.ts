'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { requireUser } from '@/lib/supabase/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { getBotInfo, LineApiError } from '@/lib/line/client';
import { assertCan } from '@/domain/permissions/can';
import type { GangRole } from '@/domain/permissions/types';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

/**
 * ตั้งค่า LINE ต่อก๊วน — **[WO-4.A]**
 *
 * 🔴 credentials เก็บใน **Vault** เท่านั้น (`gang_line_configs` ถือแค่ secret id)
 *    ⇒ ทุก mutation ผ่าน DB function ที่ grant ให้ `service_role`
 *
 * 🔴 **ไม่มี action ไหนคืนค่า credential กลับไปที่ browser** — หน้าจอได้แค่
 *    `gang_line_status()` ที่ปิดบังไว้แล้ว (มี/ไม่มี + 4 ตัวท้าย)
 */

async function cid(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function assertLineAdmin(gangId: string): Promise<string> {
  const user = await requireUser();
  const supabase = await supabaseServer();

  const { data } = await supabase
    .from('gang_members')
    .select('role')
    .eq('gang_id', gangId)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  // ⚠️ ไม่ส่ง features เข้าไป — `gang.line.manage` จงใจไม่ผูกกับ `features.line`
  //    (ต้องตั้งค่าให้ครบก่อนถึงจะเปิด flag ได้ ⇒ gate ด้วย flag ตัวเองไม่ได้)
  assertCan({ role: (data?.role as GangRole | undefined) ?? null }, 'gang.line.manage');
  return user.id;
}

export type LineStatus = {
  hasAccessToken: boolean;
  tokenLast4: string | null;
  hasChannelSecret: boolean;
  secretLast4: string | null;
  liffId: string | null;
  isEnabled: boolean;
};

const EMPTY_STATUS: LineStatus = {
  hasAccessToken: false,
  tokenLast4: null,
  hasChannelSecret: false,
  secretLast4: null,
  liffId: null,
  isEnabled: false,
};

type StatusRow = {
  has_access_token: boolean;
  token_last4: string | null;
  has_channel_secret: boolean;
  secret_last4: string | null;
  liff_id: string | null;
  is_enabled: boolean;
};

/**
 * สถานะที่หน้าจอแสดงได้ — **ปิดบังแล้วตั้งแต่ในฐานข้อมูล**
 *
 * เรียกได้จากทั้ง server component และ client (หลังกดบันทึก)
 */
export async function lineStatus(gangId: string): Promise<ApiResponse<LineStatus>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    await assertLineAdmin(gangId);

    const { data, error } = await supabaseAdmin().rpc('gang_line_status', { p_gang_id: gangId });
    if (error) throw error;

    const row = (data as StatusRow[] | null)?.[0];
    if (!row) return EMPTY_STATUS;

    return {
      hasAccessToken: row.has_access_token,
      tokenLast4: row.token_last4,
      hasChannelSecret: row.has_channel_secret,
      secretLast4: row.secret_last4,
      liffId: row.liff_id,
      isEnabled: row.is_enabled,
    };
  });
}

export type LineCredentialsInput = {
  /** ไม่ส่งมา = คงค่าเดิม · สตริงว่าง = ล้างทิ้ง */
  accessToken?: string;
  channelSecret?: string;
  liffId?: string;
};

export async function saveLineCredentials(
  gangId: string,
  input: LineCredentialsInput,
): Promise<ApiResponse<LineStatus>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const actorId = await assertLineAdmin(gangId);

    const { error } = await supabaseAdmin().rpc('set_gang_line_credentials', {
      p_gang_id: gangId,
      p_access_token: input.accessToken ?? null,
      p_channel_secret: input.channelSecret ?? null,
      p_liff_id: input.liffId ?? null,
      p_actor_id: actorId,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${gangId}/settings`);

    // 🔴 คืน "สถานะ" ไม่ใช่ค่าที่เพิ่งบันทึก
    const status = await lineStatus(gangId);
    if (!status.success) throw new AppError(status.error.code, status.error.message);
    return status.data;
  });
}

export async function setLineEnabled(
  gangId: string,
  enabled: boolean,
): Promise<ApiResponse<{ isEnabled: boolean }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const actorId = await assertLineAdmin(gangId);

    const { data, error } = await supabaseAdmin().rpc('set_gang_line_enabled', {
      p_gang_id: gangId,
      p_enabled: enabled,
      p_actor_id: actorId,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${gangId}/settings`);
    return { isEnabled: (data as { is_enabled: boolean }).is_enabled };
  });
}

export async function clearLineCredentials(gangId: string): Promise<ApiResponse<LineStatus>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    const actorId = await assertLineAdmin(gangId);

    const { error } = await supabaseAdmin().rpc('clear_gang_line_credentials', {
      p_gang_id: gangId,
      p_actor_id: actorId,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    revalidatePath(`/gangs/${gangId}/settings`);
    return EMPTY_STATUS;
  });
}

/**
 * ทดสอบการเชื่อมต่อ — ยิง `/v2/bot/info` หนึ่งครั้ง
 *
 * ⚠️ เป็น GET ที่ไม่ส่งข้อความหาใคร ⇒ **ไม่กินโควต้าของก๊วน** กดกี่ครั้งก็ได้
 * 🔴 คืนแค่ชื่อ/ไอดีของ OA — ❌ ไม่มี token อยู่ในผลลัพธ์หรือในข้อความ error
 */
export async function testLineConnection(
  gangId: string,
): Promise<ApiResponse<{ displayName: string; basicId: string }>> {
  const correlationId = await cid();

  return runAction(correlationId, async () => {
    await assertLineAdmin(gangId);

    const { data, error } = await supabaseAdmin().rpc('get_gang_line_credentials', {
      p_gang_id: gangId,
    });

    if (error) throw error;

    const row = (data as Array<{ access_token: string | null }> | null)?.[0];
    if (!row?.access_token) {
      throw new AppError('VALIDATION_ERROR', 'ยังไม่ได้ตั้ง channel access token');
    }

    try {
      const info = await getBotInfo(row.access_token);
      return { displayName: info.displayName, basicId: info.basicId };
    } catch (err) {
      if (err instanceof LineApiError) {
        throw new AppError(
          err.status === 401 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
          err.message,
          { cause: err },
        );
      }
      throw err;
    }
  });
}
