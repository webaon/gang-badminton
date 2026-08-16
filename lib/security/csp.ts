/**
 * Content-Security-Policy — **[WO-5.B]**
 *
 * baseline §Security Checklist: "Security headers + CSP บน Next.js config"
 *
 * 🔴 **`script-src` ไม่มี `unsafe-inline` / `unsafe-eval` ใน production**
 *    สคริปต์ inline ของ Next ผ่านได้ด้วย **nonce ต่อ request** (สร้างใน `proxy.ts`)
 *    + `strict-dynamic` ที่ทำให้สคริปต์ซึ่งถูกโหลดโดยสคริปต์ที่เชื่อถือแล้วผ่านตามไปด้วย
 *
 * ⚠️ **`style-src` ยังต้องมี `unsafe-inline`** — React ใส่ `style="..."` เป็น attribute
 *    (และ Astryx ใช้ inline style ในบาง component) ซึ่ง nonce ครอบไม่ได้
 *    ⇒ ยอมรับโดยตั้งใจ · ข้อห้ามของใบนี้คือ `script-src` ซึ่งเป็นตัวที่ทำให้เกิด XSS จริง
 *
 * ⚠️ **dev ต้องมี `unsafe-eval`** — HMR ของ Next ใช้ `eval` ⇒ ถ้าบังคับเข้มใน dev
 *    จะแก้โค้ดแล้วหน้าไม่รีเฟรช และคนจะปิด CSP ทิ้งทั้งอัน (แย่กว่า)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 **ข้อยกเว้นของหน้าที่ prerender เป็น static (`STATIC_ROUTES`)**
 *
 * Next ติด `nonce=` ให้ `<script>` ได้เฉพาะหน้าที่ **render ตอน request** เท่านั้น
 * (วัดของจริงแล้ว: `/discover` = 16/16 script มี nonce · `/` = 0/16)
 * หน้าที่ prerender ไว้ตั้งแต่ build ไม่มีทางรู้ nonce ของ request ⇒ ถ้าส่ง CSP
 * แบบ nonce + `strict-dynamic` ไปให้ **สคริปต์ทั้งหน้าโดนบล็อก** = หน้าแรกพังสนิท
 *
 * ทางเลือกที่มี: (ก) บังคับ nonce แล้วหน้าแรกกลายเป็น dynamic — **ขัด DoD ของ WO-3.F**
 * ที่บังคับว่าหน้าแรกต้อง static/ISR · (ข) ยกเว้นเฉพาะหน้านั้นด้วย `'unsafe-inline'`
 *
 * เลือก (ข) เพราะหน้าแรก **ไม่มีข้อมูลของผู้ใช้เลยสักตัว** (WO-3.F: ตัวเลขมาจาก rollup
 * ระดับแพลตฟอร์ม ไม่มีชื่อก๊วน ไม่มีชื่อคน ไม่มี query string ที่เอาไปแสดง)
 * ⇒ ไม่มีช่องให้ฉีดสคริปต์ตั้งแต่ต้นทาง · หน้าอื่นที่มีข้อมูลผู้ใช้ยังเข้มเต็มที่
 *
 * ⚠️ **เพิ่มหน้า static ใหม่เมื่อไหร่ ต้องมาเติมใน `STATIC_ROUTES` ด้วย**
 *    ไม่งั้นหน้านั้นจะขาวเปล่าโดยไม่มี error ที่ server (เห็นแค่ใน console ของ browser)
 */

/** path ที่ Next prerender เป็น static — ตรวจได้จากผลลัพธ์ `npm run build` (`○`) */
export const STATIC_ROUTES: ReadonlySet<string> = new Set(['/']);

export type CspInput = {
  /** nonce ของ request นั้น (base64) */
  nonce: string;
  /** หน้านี้เป็น static prerender หรือไม่ (nonce ใช้ไม่ได้ — ดูหมายเหตุหัวไฟล์) */
  isStaticRoute?: boolean;
  /** `NEXT_PUBLIC_SUPABASE_URL` — 🔴 อ่านจาก env ห้าม hardcode โดเมนโปรเจกต์ */
  supabaseUrl: string;
  isProduction: boolean;
};

/**
 * origin ของ Supabase ที่ browser ต้องคุยด้วย
 *
 * คืนทั้ง `https://` (REST/Storage/Auth) และ `wss://` (realtime ของ WO-2.5)
 * ⇒ ลืม `wss:` เมื่อไหร่ กระดานคิวสดจะเงียบไปเฉยๆ โดยไม่มี error ที่หน้าจอ
 */
export function supabaseOrigins(supabaseUrl: string): string[] {
  try {
    const url = new URL(supabaseUrl);
    const ws = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return [url.origin, `${ws}//${url.host}`];
  } catch {
    // env เพี้ยน = ไม่เติมอะไรเลย ดีกว่าเติม '*' แล้วเปิดกว้างโดยไม่มีใครรู้
    return [];
  }
}

export function buildContentSecurityPolicy({
  nonce,
  supabaseUrl,
  isProduction,
  isStaticRoute = false,
}: CspInput): string {
  const supabase = supabaseOrigins(supabaseUrl);

  //  หน้า static: nonce ใช้ไม่ได้ ⇒ ต้องยอม `'unsafe-inline'` (เหตุผลอยู่หัวไฟล์)
  //  ⚠️ ห้ามใส่ `strict-dynamic` ตรงนี้ — มันจะ **ยกเลิก** `'unsafe-inline'` ทิ้ง
  const scriptSrc = isStaticRoute
    ? ['script-src', "'self'", "'unsafe-inline'", ...(isProduction ? [] : ["'unsafe-eval'"])]
    : [
        'script-src',
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        ...(isProduction ? [] : ["'unsafe-eval'"]),
      ];

  const directives: string[][] = [
    ['default-src', "'self'"],
    scriptSrc,
    ['style-src', "'self'", "'unsafe-inline'"],
    // QR ของ PromptPay เป็น data: · รูปที่อัปอยู่บน Supabase Storage · preview ก่อนอัปเป็น blob:
    ['img-src', "'self'", 'data:', 'blob:', ...supabase],
    ['font-src', "'self'", 'data:'],
    ['connect-src', "'self'", ...supabase],
    // 🔴 ห้ามใครเอาหน้าเราไปฝังใน iframe (clickjacking)
    //    LIFF ไม่กระทบ — LINE เปิดด้วย WKWebView/Android WebView ไม่ใช่ iframe
    //    (developers.line.biz/en/docs/liff/overview — ตรวจแล้ว 16 ส.ค. 2026)
    ['frame-ancestors', "'none'"],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ...(isProduction ? [['upgrade-insecure-requests']] : []),
  ];

  return directives.map((parts) => parts.join(' ')).join('; ');
}

/**
 * header ที่ไม่ต้องใช้ nonce — ตั้งครั้งเดียวใน `next.config.ts`
 *
 * ⚠️ HSTS ตั้งเฉพาะ production — local เป็น `http://localhost` ถ้าเผลอส่ง HSTS
 *    เบราว์เซอร์จะจำแล้วบังคับ https กับ localhost ทุกโปรเจกต์หลังจากนั้น (แก้คืนยาก)
 */
export function staticSecurityHeaders(
  isProduction: boolean,
): { key: string; value: string }[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // คู่กับ frame-ancestors สำหรับเบราว์เซอร์เก่าที่ยังไม่รองรับ CSP level 2
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // 🔴 ปิดหมด — แอปนี้ **ไม่ใช้กล้องผ่านเบราว์เซอร์เลย** (WO-2.5-F จงใจให้สแกน QR
    //    ด้วยกล้องเนทีฟของเครื่องแทนการฝังไลบรารีอ่าน QR) ⇒ ไม่มีเหตุให้เปิดสิทธิ์ไว้
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    ...(isProduction
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
      : []),
  ];
}
