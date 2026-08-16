import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { exchangeLoginCode } from '@/lib/line/client';
import { nonceMatches, verifyLoginState } from '@/lib/line/login-state';
import { linkAndNotify } from './link';

/**
 * ปลายทางของ LINE Login — **[WO-4.D]**
 *
 * ลำดับการตรวจ (ห้ามสลับ):
 *   1. `state` ต้องเป็นของเรา (ลายเซ็น + ยังไม่หมดอายุ)
 *   2. `nonce` ใน state ต้องตรงกับ cookie httpOnly ของเบราว์เซอร์นั้น  ← กัน login CSRF
 *   3. ผู้ใช้ที่ล็อกอินอยู่ **ต้องเป็นคนเดียวกับใน state**              ← กันผูกให้คนอื่น
 *   4. ค่อยแลก `code` กับ LINE เพื่อเอา `userId`
 *
 * 🔴 `lineUserId` มาจากการแลก code ฝั่ง server เท่านั้น
 *    ❌ ไม่มีทางที่ client จะส่ง `lineUserId` มาเองแล้วเราเชื่อ
 */

export type LoginCallbackResult =
  | { ok: true; gangId: string }
  | { ok: false; gangId: string | null; reason: LoginFailure };

export type LoginFailure =
  | 'invalid_state'
  | 'nonce_mismatch'
  | 'not_signed_in'
  | 'wrong_user'
  | 'not_configured'
  | 'exchange_failed'
  | 'link_failed'
  | 'denied';

type Deps = {
  /** ผู้ใช้ที่ล็อกอินอยู่ตอนนี้ (จาก Supabase session) */
  currentUserId: () => Promise<string | null>;
  /** แยกออกมาเพื่อให้เทสต์เดินเส้นทางเต็มได้โดยไม่ต้องยิง LINE จริง */
  exchange?: typeof exchangeLoginCode;
};

export async function handleLoginCallback(
  input: {
    code: string | null;
    state: string | null;
    error: string | null;
    nonceCookie: string | null;
    redirectUri: string;
    correlationId: string;
  },
  deps: Deps,
): Promise<LoginCallbackResult> {
  const { code, state, error, nonceCookie, redirectUri, correlationId } = input;

  // ผู้ใช้กด "ยกเลิก" ที่หน้า LINE
  if (error) return { ok: false, gangId: null, reason: 'denied' };

  const verified = state ? verifyLoginState(state) : null;
  if (!verified) {
    console.warn('[line] login state ใช้ไม่ได้', { correlationId });
    return { ok: false, gangId: null, reason: 'invalid_state' };
  }

  if (!nonceMatches(verified.nonce, nonceCookie)) {
    console.warn('[line] nonce ไม่ตรงกับ cookie', { correlationId, gangId: verified.gangId });
    return { ok: false, gangId: verified.gangId, reason: 'nonce_mismatch' };
  }

  const currentUserId = await deps.currentUserId();
  if (!currentUserId) {
    return { ok: false, gangId: verified.gangId, reason: 'not_signed_in' };
  }

  // 🔴 ต่อให้ state หลุดไปถึงคนอื่น ก็ผูกบัญชีข้ามคนไม่ได้
  if (currentUserId !== verified.userId) {
    console.warn('[line] ผู้ใช้ที่ล็อกอินไม่ตรงกับใน state', {
      correlationId,
      gangId: verified.gangId,
    });
    return { ok: false, gangId: verified.gangId, reason: 'wrong_user' };
  }

  if (!code) return { ok: false, gangId: verified.gangId, reason: 'exchange_failed' };

  const { data, error: configError } = await supabaseAdmin().rpc('get_gang_line_login', {
    p_gang_id: verified.gangId,
  });

  if (configError) throw configError;

  const config = (data as Array<{
    login_channel_id: string | null;
    login_channel_secret: string | null;
    is_enabled: boolean;
  }> | null)?.[0];

  if (!config?.login_channel_id || !config.login_channel_secret || !config.is_enabled) {
    return { ok: false, gangId: verified.gangId, reason: 'not_configured' };
  }

  let lineUserId: string;
  try {
    const exchange = deps.exchange ?? exchangeLoginCode;
    const profile = await exchange({
      code,
      redirectUri,
      channelId: config.login_channel_id,
      channelSecret: config.login_channel_secret,
    });
    lineUserId = profile.lineUserId;
  } catch (err) {
    // ❌ ห้าม log token — ข้อความของ LineApiError ไม่มี token อยู่แล้ว
    console.error('[line] แลก code ไม่สำเร็จ', {
      correlationId,
      gangId: verified.gangId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, gangId: verified.gangId, reason: 'exchange_failed' };
  }

  const linked = await linkAndNotify({
    gangId: verified.gangId,
    userId: verified.userId,
    lineUserId,
    correlationId,
  });

  if (!linked.ok) return { ok: false, gangId: verified.gangId, reason: 'link_failed' };

  return { ok: true, gangId: verified.gangId };
}
