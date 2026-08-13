'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { enforceGuestRateLimit } from '@/server/guest/rate-limit';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';

/**
 * Server actions ที่ **ไม่ต้องล็อกอิน** — guest เรียกผ่านลิงก์เชิญ
 *
 * 🔴 กติกาของไฟล์นี้:
 *   1. ทุกตัวต้องผ่าน `enforceGuestRateLimit()` ก่อนแตะฐานข้อมูล
 *   2. ทุกตัวเรียก DB function ที่ validate token เอง — ไม่เชื่อ input ใดๆ
 *   3. ❌ ห้าม log plaintext token (baseline [v3.2])
 */

export type GuestRegistrationResult = {
  registrationId: string;
  status: string;
  /** plaintext — แสดงครั้งเดียวให้ guest เก็บลิงก์ไว้ ระบบจำไม่ได้อีก */
  guestToken: string;
};

export async function registerAsGuest(
  inviteToken: string,
  guestName: string,
  guestPhone?: string,
): Promise<ApiResponse<GuestRegistrationResult>> {
  const requestHeaders = await headers();
  const correlationId = correlationIdFrom(requestHeaders);

  return runAction(correlationId, async () => {
    if (guestName.trim() === '') {
      throw new AppError('VALIDATION_ERROR', 'กรุณากรอกชื่อ');
    }

    const admin = supabaseAdmin();

    // หา session จาก token ก่อน เพื่อใช้เป็น scope ของ rate limit
    const { data: sessions, error: lookupError } = await admin.rpc('session_by_invite_token', {
      p_token: inviteToken,
    });

    if (lookupError) throw lookupError;

    const session = (sessions as Array<{ session_id: string; is_open: boolean }> | null)?.[0];
    if (!session) {
      // ลิงก์ผิด/หมดอายุ/ใช้ครบ — ข้อความเดียวกันหมด ไม่บอกว่าสาเหตุไหน
      throw new AppError('INVITE_TOKEN_INVALID', 'ลิงก์เชิญไม่ถูกต้องหรือหมดอายุแล้ว');
    }

    await enforceGuestRateLimit({
      action: 'register',
      sessionId: session.session_id,
      headers: requestHeaders,
      limit: 5,
    });

    const { data, error } = await admin.rpc('register_guest', {
      p_session_id: session.session_id,
      p_guest_name: guestName,
      p_guest_phone: guestPhone ?? null,
      p_invite_token: inviteToken,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    const row = (data as Array<{
      registration_id: string;
      status: string;
      guest_token: string;
    }> | null)?.[0];

    if (!row) throw new AppError('INTERNAL_ERROR', 'register_guest ไม่คืนค่า');

    revalidatePath(`/join/${inviteToken}`);

    return {
      registrationId: row.registration_id,
      status: row.status,
      guestToken: row.guest_token,
    };
  });
}

export async function cancelAsGuest(
  registrationId: string,
  guestToken: string,
): Promise<ApiResponse<{ status: string }>> {
  const requestHeaders = await headers();
  const correlationId = correlationIdFrom(requestHeaders);

  return runAction(correlationId, async () => {
    await enforceGuestRateLimit({
      action: 'cancel',
      sessionId: registrationId,
      headers: requestHeaders,
      limit: 10,
    });

    const { data, error } = await supabaseAdmin().rpc('cancel_registration_as_guest', {
      p_registration_id: registrationId,
      p_guest_token: guestToken,
      p_correlation_id: correlationId,
    });

    if (error) throw error;

    return { status: (data as { status: string }).status };
  });
}
