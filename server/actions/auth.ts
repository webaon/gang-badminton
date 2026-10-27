'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { isLinePlatformLoginEnabled, LINE_PLATFORM_PROVIDER } from '@/lib/line/platform-login';
import { publicSupabaseEnv } from '@/lib/supabase/env';
import { supabaseServer } from '@/lib/supabase/server';
import { resolveAppOrigin } from '@/lib/url/app-origin';
import { safeNext } from '@/lib/url/safe-next';
import { enforceRateLimit } from '@/server/security/rate-limit';
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

/**
 * เริ่มเข้าสู่ระบบด้วย LINE (ระดับแพลตฟอร์ม) — คืน URL ให้หน้าจอพาไป **[WO-B1.a · ADR-013]**
 *
 * 🔴 เปิดสาธารณะ (คนยังไม่ล็อกอินเรียกได้ และเป็นประตูสมัครบัญชีใหม่) ⇒ เพดาน `auth:line-start`
 *    20/ชม./IP — ต้องตรงกับ `docs/rate-limits.md`
 * 🔴 ปิดอยู่จนกว่า `LINE_PLATFORM_LOGIN_ENABLED=true` (fail-closed → `FEATURE_DISABLED`)
 * 🔴 state / nonce / PKCE จัดการโดย Supabase Auth (code verifier ถูกเขียนลง cookie ผ่าน
 *    `supabaseServer()`) ⇒ ❌ ไม่เขียน state เอง ❌ ไม่แตะ `auth.*`
 * 🔴 `next` ผ่าน `safeNext()` ก่อนฝังใน `redirectTo` (กัน open redirect หลังล็อกอิน)
 * 🔴 URL ที่คืนต้องเป็น origin ของ Supabase ของเราเท่านั้น — กันกรณี SDK/ค่า config เพี้ยนแล้วพาผู้ใช้ออกนอกโดเมน
 */
export async function startLineSignIn(next?: string): Promise<ApiResponse<{ url: string }>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    if (!isLinePlatformLoginEnabled()) {
      throw new AppError('FEATURE_DISABLED', 'LINE Login ระดับแพลตฟอร์มยังไม่เปิดใช้');
    }

    const requestHeaders = await headers();

    await enforceRateLimit({
      scope: 'auth:line-start',
      headers: requestHeaders,
      limit: 20,
      window: '1 hour',
    });

    const origin = resolveAppOrigin(requestHeaders);
    if (!origin) {
      console.error('[auth] หาโดเมนของแอปไม่ได้ — ต้องตั้ง env APP_BASE_URL (production ไม่เชื่อ header)', { correlationId: cid });
      throw new AppError('INTERNAL_ERROR', 'หาโดเมนของแอปไม่ได้ — ตั้ง APP_BASE_URL');
    }

    const target = next ? safeNext(next) : null;
    const redirectTo = `${origin}/auth/callback${target ? `?next=${encodeURIComponent(target)}` : ''}`;

    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: LINE_PLATFORM_PROVIDER,
      options: { redirectTo, skipBrowserRedirect: true },
    });

    if (error || !data?.url) {
      throw new AppError('INTERNAL_ERROR', 'เริ่ม LINE Login ไม่สำเร็จ', { cause: error });
    }

    if (new URL(data.url).origin !== new URL(publicSupabaseEnv().url).origin) {
      throw new AppError('INTERNAL_ERROR', 'URL ของ LINE Login ไม่ใช่ของ Supabase ที่ตั้งไว้');
    }

    return { url: data.url };
  });
}

export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect('/sign-in');
}
