'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { supabaseServer } from '@/lib/supabase/server';
import { correlationIdFrom } from '@/shared/api';
import { AppError, runAction } from '@/shared/action';
import type { ApiResponse } from '@/shared/api';

/**
 * Server actions ของ auth — shell บางๆ ตาม CLAUDE.md §3
 *
 * ทุกตัวตอบตาม API response contract ผ่าน `runAction()` ⇒ หน้าจอไม่ต้องเดา
 * ว่าจะได้ error รูปแบบไหน และ error code มาจาก `docs/errors.md` เท่านั้น
 *
 * ⚠️ ใช้ `supabaseServer()` (ผูก session ผู้ใช้) ไม่ใช่ `supabaseAdmin()`
 *    งาน auth ไม่มีเหตุผลให้ bypass RLS
 */

async function correlationId(): Promise<string> {
  return correlationIdFrom(await headers());
}

/** อีเมลที่ยังไม่มีในระบบ ล็อกอินด้วยรหัสผ่านไม่ได้ — Supabase ตอบรวมเป็น error เดียว */
function authError(message: string): never {
  // ⚠️ ไม่แยกว่า "ไม่มีอีเมลนี้" หรือ "รหัสผิด" โดยตั้งใจ
  //    การแยกให้ = บอกคนนอกว่าอีเมลไหนมีบัญชีอยู่ (user enumeration)
  throw new AppError('UNAUTHENTICATED', message);
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<ApiResponse<{ userId: string }>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) authError('อีเมลหรือรหัสผ่านไม่ถูกต้อง');

    return { userId: data.user.id };
  });
}

export async function signUpWithPassword(
  email: string,
  password: string,
  displayName: string,
): Promise<ApiResponse<{ needsEmailConfirmation: boolean }>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    if (displayName.trim().length === 0) {
      throw new AppError('VALIDATION_ERROR', 'กรุณากรอกชื่อที่ใช้แสดง');
    }

    const supabase = await supabaseServer();

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // 🔴 trigger `handle_new_user` อ่านชื่อจากตรงนี้ (migration 0014)
        //    ถ้าไม่ส่งมา ผู้ใช้จะได้ชื่อ fallback จากส่วนหน้าของอีเมลแทน
        data: { display_name: displayName.trim() },
      },
    });

    if (error) throw new AppError('VALIDATION_ERROR', error.message, { cause: error });

    // ถ้าโปรเจกต์เปิด email confirmation จะยังไม่มี session กลับมา
    return { needsEmailConfirmation: data.session === null };
  });
}

export async function signInWithMagicLink(
  email: string,
  next?: string,
): Promise<ApiResponse<{ sent: true }>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    const supabase = await supabaseServer();
    const origin = (await headers()).get('origin') ?? '';

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${origin}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ''}`,
      },
    });

    if (error) throw new AppError('VALIDATION_ERROR', error.message, { cause: error });

    return { sent: true as const };
  });
}

export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect('/sign-in');
}
