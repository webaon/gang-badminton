'use server';

import { headers } from 'next/headers';

import { DISABLED_STATE, findLineIdentity, canUnlinkLine, summarizeLineAccount, type LineAccountState } from '@/lib/line/identity';
import { isLinePlatformLoginEnabled, LINE_LINK_NEXT, LINE_PLATFORM_PROVIDER } from '@/lib/line/platform-login';
import { publicSupabaseEnv } from '@/lib/supabase/env';
import { currentUser, supabaseServer } from '@/lib/supabase/server';
import { resolveAppOrigin } from '@/lib/url/app-origin';
import { enforceRateLimit } from '@/server/security/rate-limit';
import { AppError, runAction } from '@/shared/action';
import { correlationIdFrom, type ApiResponse } from '@/shared/api';

/**
 * ผูก/ถอด LINE กับ **บัญชีที่ล็อกอินอยู่** (ระดับ Auth) — **[WO-B1.c · ADR-013]**
 *
 * ❗ คนละเรื่องกับ `server/actions/line.ts` (ผูก LINE ต่อก๊วน ผ่าน `link.ts`)
 * 🔴 ตัวตนระดับ Auth ผ่าน **Supabase Auth API เท่านั้น** (`linkIdentity` / `unlinkIdentity` / `getUserIdentities`)
 *    ❌ ไม่เขียน `auth.*` ตรง ❌ ไม่ใช้ service-role client ที่นี่เลย (Q8)
 * 🔴 ผูกได้เฉพาะตอนล็อกอินอยู่ — ทุก action อ่านผู้ใช้จาก session เอง ไม่รับ user id / identity id จาก client
 * 🔴 ซ่อนหลัง `LINE_PLATFORM_LOGIN_ENABLED` เหมือน B1.a (fail-closed)
 * 🔴 เพดานต่อ (ผู้ใช้ + IP): `auth:line-link` / `auth:line-unlink` 10/ชม. — ดู `docs/rate-limits.md`
 *
 * ⚠️ ต้องเปิด **Manual Linking** ใน Supabase (`docs/ops/line-login-setup.md` ข้อ D2) ไม่งั้น `linkIdentity` ล้ม
 */

async function correlationId(): Promise<string> {
  return correlationIdFrom(await headers());
}

async function requireSessionUser() {
  const user = await currentUser();
  if (!user) throw new AppError('UNAUTHENTICATED', 'ต้องเข้าสู่ระบบก่อน');
  return user;
}

function requireEnabled(): void {
  if (!isLinePlatformLoginEnabled()) {
    throw new AppError('FEATURE_DISABLED', 'LINE Login ระดับแพลตฟอร์มยังไม่เปิดใช้');
  }
}

async function loadIdentities() {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUserIdentities();

  if (error || !data) {
    // ❌ ไม่ log ตัว error เต็ม — แค่ code/status พอ
    console.warn('[auth] อ่าน identities ไม่สำเร็จ', { code: error?.code, status: error?.status });
    throw new AppError('INTERNAL_ERROR', 'อ่านวิธีเข้าสู่ระบบของบัญชีไม่สำเร็จ', { cause: error });
  }

  return { supabase, identities: data.identities };
}

/** สถานะการผูก LINE ของบัญชีนี้ — flag ปิด = `enabled:false` (ไม่ใช่ error) เพื่อให้หน้าโปรไฟล์ซ่อนส่วนนี้เงียบๆ */
export async function myLineAccount(): Promise<ApiResponse<LineAccountState>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    await requireSessionUser();
    if (!isLinePlatformLoginEnabled()) return DISABLED_STATE;

    const { identities } = await loadIdentities();
    return summarizeLineAccount(identities);
  });
}

/**
 * เริ่มผูก LINE — คืน URL ให้หน้าจอพาไป (`onClick → window.location` เท่านั้น · CSP `form-action 'self'`)
 *
 * PKCE: SDK สร้าง code verifier ลง cookie ผ่าน `supabaseServer()` ⇒ callback ที่ไม่ได้เริ่มจากเบราว์เซอร์นี้
 * แลก code ไม่ได้ (กันคนร้ายเอา code ของ LINE ตัวเองมาให้เหยื่อเปิด — login CSRF / ผูก LINE คนร้ายเข้าบัญชีเหยื่อ)
 */
export async function startLineLink(): Promise<ApiResponse<{ url: string }>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    const user = await requireSessionUser();
    requireEnabled();

    const requestHeaders = await headers();
    await enforceRateLimit({
      scope: 'auth:line-link',
      subject: user.id,
      headers: requestHeaders,
      limit: 10,
      window: '1 hour',
    });

    const { supabase, identities } = await loadIdentities();

    // ผูกซ้ำไม่มีความหมาย (และ Supabase จะล้มอยู่ดี) — บอกให้ชัดแทนที่จะพาไป LINE เปล่าๆ
    if (findLineIdentity(identities)) {
      throw new AppError('VALIDATION_ERROR', 'บัญชีนี้ผูก LINE ไว้แล้ว');
    }

    const origin = resolveAppOrigin(requestHeaders);
    if (!origin) throw new AppError('INTERNAL_ERROR', 'หาโดเมนของแอปไม่ได้ — ตั้ง APP_BASE_URL');

    const { data, error } = await supabase.auth.linkIdentity({
      provider: LINE_PLATFORM_PROVIDER,
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(LINE_LINK_NEXT)}`,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      console.warn('[auth] linkIdentity ไม่สำเร็จ', { correlationId: cid, code: error?.code, status: error?.status });
      throw new AppError('INTERNAL_ERROR', 'เริ่มผูก LINE ไม่สำเร็จ', { cause: error });
    }

    if (new URL(data.url).origin !== new URL(publicSupabaseEnv().url).origin) {
      throw new AppError('INTERNAL_ERROR', 'URL ผูก LINE ไม่ใช่ของ Supabase ที่ตั้งไว้');
    }

    return { url: data.url };
  });
}

/**
 * ถอด LINE ออกจากบัญชี
 *
 * 🔴 ADR-013 R5: ถอดไม่ได้ถ้า LINE เป็นวิธีเข้าสู่ระบบเดียวที่เหลือ (บัญชี LINE-only) — เช็คที่นี่ก่อนยิง
 *    และ Supabase บังคับ ≥ 2 identities ซ้ำอีกชั้น
 * 🔴 หา identity เองจาก session — ไม่รับ `identity_id` จาก client (กันถอด identity ของคนอื่น/ของวิธีอื่น)
 * ผลต่อการผูก LINE ต่อก๊วน: **ไม่แตะ** — ยังรับแจ้งเตือนของก๊วนได้ตามเดิม
 */
export async function unlinkLineAccount(): Promise<ApiResponse<{ removed: true }>> {
  const cid = await correlationId();

  return runAction(cid, async () => {
    const user = await requireSessionUser();
    requireEnabled();

    await enforceRateLimit({
      scope: 'auth:line-unlink',
      subject: user.id,
      headers: await headers(),
      limit: 10,
      window: '1 hour',
    });

    const { supabase, identities } = await loadIdentities();
    const line = findLineIdentity(identities);

    if (!line) throw new AppError('VALIDATION_ERROR', 'บัญชีนี้ยังไม่ได้ผูก LINE');

    if (!canUnlinkLine(identities)) {
      throw new AppError('VALIDATION_ERROR', 'ถอด LINE ไม่ได้ — เป็นวิธีเข้าสู่ระบบเดียวของบัญชีนี้');
    }

    const { error } = await supabase.auth.unlinkIdentity(line);

    if (error) {
      console.warn('[auth] unlinkIdentity ไม่สำเร็จ', { correlationId: cid, code: error.code, status: error.status });
      throw new AppError('INTERNAL_ERROR', 'ถอด LINE ไม่สำเร็จ', { cause: error });
    }

    return { removed: true as const };
  });
}
