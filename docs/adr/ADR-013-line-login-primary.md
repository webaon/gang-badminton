# ADR-013 — LINE Login เป็นทางเข้าหลักของแพลตฟอร์ม (B1)

| | |
|---|---|
| **สถานะ** | ✅ **Accepted** (27 ต.ค. 2026 · ตาม ★ ทั้งหมด ยกเว้น Q4/Q6 ที่ปรับให้ง่ายลง — ดู §0.1) · ⚠️ ข้อสมมติที่ spike S1–S3, S5 ยังไม่พิสูจน์ (§10) — ถ้า S2 ไม่ผ่าน ต้องกลับมาแก้ ADR นี้ |
| **คำตัดสิน** | `docs/phase6-redesign-plan.md` §11.1 (commit `21d4936`) |
| **วันที่ร่าง** | 27 ต.ค. 2026 |
| **ผู้ร่าง** | @gb-integrations (WO-B1-ADR · `docs/phase6-redesign-plan.md` §11) |
| **ที่มา** | คำตัดสิน C12/B1 (26 ต.ค.): *ไม่ทำ SMTP — ใช้ LINE Login เป็นทางเข้าหลัก* (`docs/phase6-redesign-plan.md` §3.1) |
| **เกี่ยวข้อง** | WO-4.B (`link.ts`) · WO-4.D (LINE Login ต่อก๊วน) · WO-4.E (LIFF) · WO-5.B (CSP) · WO-5.C (rate limit) · ADR-012 (B2) |
| **อ้างอิงโค้ดที่** | commit `0b39bfc` (path:line ทุกจุดตรวจจาก `git show HEAD:<path>`) |

> **วิธีอ่านเอกสารนี้** — ทุกข้อที่ต้องให้เจ้าของงานเลือกอยู่ใน **§9** ในรูป
> `แผนบอก X / ของจริงคือ Y / ทางเลือกคือ Z` โดย **★ = ที่แนะนำ** ·
> ข้อที่ **ยังพิสูจน์ไม่ได้จากเอกสาร/โค้ด** อยู่ใน **§10** (ต้อง spike ก่อนเขียนจริง) — ไม่ได้เดาให้เป็นข้อเท็จจริง

---

## 0.1 คำตัดสินที่บันทึกแล้ว (27 ต.ค. 2026)

| ข้อ | ผล |
|---|---|
| Q1 ทางเข้า | ✅ ★ Option A — Custom OIDC ของ Supabase |
| Q2 channel | ✅ ★ provider/channel แพลตฟอร์มแยก · ผูก OA ต่อก๊วนคงเดิม |
| Q3 อีเมล | ✅ ★ ไม่ขอ email scope + `email_optional` + ผูกด้วย `linkIdentity` ตอนล็อกอินอยู่เท่านั้น |
| **Q4 cutover** | ✅ **ปรับ:** ยังไม่มีผู้ใช้จริงจนกว่าจะ UAT ⇒ **ไม่ทำ cutover/แบนเนอร์** · เจ้าของงานผูก LINE กับบัญชีตัวเองตอน UAT (ผลคือ §4.3 และแถว "ต้อง cutover" ใน §11 **ไม่ต้องทำ** — เก็บไว้เป็นบริบทเผื่อวันที่มีผู้ใช้จริงก่อนเปิดทางนี้) |
| Q5 ทางสำรอง | ✅ ★ คงอีเมล+รหัสผ่านเป็นทางสำรอง · ปุ่ม LINE เป็นปุ่มหลัก |
| **Q6 spike** | ✅ **ปรับ:** ทดลองบนโปรเจกต์ cloud เดิม `emmzeriekkjryhucvctx` ได้ ไม่ต้องสร้างโปรเจกต์ใหม่ (ยังไม่ใช้งานจริง) — ⚠️ ยังมีข้อมูลทดสอบบน prod (ก๊วนเรนนี่) จึง **ห้ามแก้ค่า Auth ที่กระทบผู้ใช้เดิม** (เช่น ปิด email provider, เปลี่ยน Site URL) ระหว่าง spike |
| Q7 rate limit | ✅ ★ `auth:line-start` = 20/ชม./IP · `auth:callback` คงเดิมแล้ววัด |
| **Q8 ตีความกติกา link.ts** | ✅ ★ **`server/line/link.ts` ครอบเฉพาะ `member_line_links` ต่อก๊วน · ตัวตนระดับ Auth (การผูก LINE กับบัญชีผู้ใช้) ทำผ่าน Supabase Auth API เท่านั้น ห้ามเขียน `auth.*` ตรง** — ประโยคนี้เป็นกติกาของ ADR และต้องเติมลง `STATE.md` ตอนปิด WO-B1 |
| Q9 เชิญคนไม่มีอีเมล | ✅ ★ ไม่ทำใน B1 — planner เปิด WO แยก |

---

## 0. สรุป 8 บรรทัด

1. สร้าง **LINE Login channel ระดับแพลตฟอร์ม 1 ใบ** ใน **LINE Provider ใหม่แยกต่างหาก** (§2)
2. ★ เข้า Supabase Auth ผ่าน **Custom OIDC provider ของ Supabase** (`custom:line`, issuer `https://access.line.me`) — ไม่ออก session เอง (§3)
3. ★ **ไม่ขอ email scope** + ตั้ง `email_optional` ⇒ ไม่มีทางที่ Supabase จะ "auto-link ด้วยอีเมล" มายึดบัญชีเดิม (§4)
4. บัญชีเดิมผูก LINE ได้เฉพาะ **ตอนล็อกอินบัญชีนั้นอยู่** (manual linking) — LINE หนึ่งใบ ผูกได้บัญชีเดียว (§4)
5. 🔴 **userId ของ LINE คนละ provider = คนละค่า** ⇒ ตัว Login ระดับแพลตฟอร์ม **ใช้แทน `member_line_links` (ผูกต่อก๊วน) ไม่ได้** — ผูกต่อก๊วนยังต้องทำเหมือนเดิม (§2, §5)
6. LIFF และ LINE Login ต่อก๊วน (WO-4.D) **ไม่ต้องแก้โค้ด** — แต่ UX เปลี่ยน (§5)
7. CSP **ไม่ต้องแก้** ถ้าปุ่มเป็น `onClick → window.location` (ห้ามเป็น `<form action>`) · redirect URI ที่ต้องเพิ่มมี 2 จุด (§6)
8. env ใหม่ใน Vercel = **ไม่มี** (secret ของ channel อยู่ในค่าตั้ง Auth ของ Supabase) (§7)

**ขั้นต่อไป (อนุมัติแล้ว):** เจ้าของงานทำตาม `docs/ops/line-login-setup.md` → spike S1–S3, S5 (§10) บนโปรเจกต์เดิม `emmzeriekkjryhucvctx` (Q6 ที่ปรับแล้ว) · ระหว่างรอ โค้ดส่วนที่ไม่พึ่ง provider จริง (WO-B1.a) ทำได้โดย **ซ่อนปุ่มหลัง env flag** จน spike ผ่าน

---

## 1. Context — ของจริงที่มีอยู่ตอนนี้

| # | ของจริง | หลักฐาน |
|---|---|---|
| 1 | ผู้ใช้เข้าได้ 2 ทาง: อีเมล+รหัสผ่าน และ magic link — **ไม่มี OAuth provider ใดเลย** | `server/actions/auth.ts:32` (`signInWithPassword`), `:79` (`signInWithMagicLink`) · `supabase/config.toml` `[auth.external.*]` มีแค่ `apple` ที่ปิดอยู่ (`:326`) |
| 2 | ไม่มี SMTP ⇒ ปิดการยืนยันอีเมล (`mailer_autoconfirm = true`) ⇒ **อีเมลของทุกบัญชีเป็น "ยังไม่ยืนยัน" โดยพฤตินัย** · "ลืมรหัสผ่าน" ใช้ไม่ได้ | `STATE.md:398-399` |
| 3 | `/auth/callback` แลก `code` → session อยู่แล้ว (PKCE ของ `@supabase/ssr`) · กรอง `next` ด้วย `safeNext()` · rate limit `auth:callback` 30/ชม./IP | `app/auth/callback/route.ts:19` (`safeNext`), `:28` (scope), `:39` (`exchangeCodeForSession`) · `lib/url/safe-next.ts:17` · `docs/rate-limits.md:21` |
| 4 | LINE Login ปัจจุบัน (WO-4.D) = **channel ต่อก๊วน** เก็บ id/secret ใน **Vault** (`login_channel_secret_ref`) · ใช้ **ผูกบัญชีที่ล็อกอินอยู่แล้ว** เท่านั้น | `supabase/migrations/20260816000038_line_login.sql:24-26` (คอลัมน์), `:106-130` (`get_gang_line_login` → service_role) · `server/line/login.ts:11-19` |
| 5 | callback ของ WO-4.D ต้องมี Supabase session ก่อน และ `userId` ใน `state` ต้องตรงกับผู้ล็อกอิน (`not_signed_in` / `wrong_user`) | `server/line/login.ts:69-81` |
| 6 | ทางผูกบัญชีลง `member_line_links` ผ่าน `linkAndNotify()` → `link_line_account()` ที่เดียว (รหัสในแชต + LINE Login ต่อก๊วน) · **กติกา: ห้ามเขียนทางที่สาม** | `server/line/link.ts:13,22` · `STATE.md:432-433` |
| 7 | `member_line_links.line_user_id` = LINE `userId` ของ **provider ที่ถือ Messaging API ของก๊วนนั้น** · unique ต่อ (ก๊วน, LINE) และต่อ (ก๊วน, ผู้ใช้) | `supabase/migrations/20260810000006_line.sql:42,46,47` · `20260816000038_line_login.sql:4-6` · `.env.example:67-70` |
| 8 | ตัวแลก code ของ WO-4.D ใช้ `scope: 'profile openid'` ไม่มี PKCE และอ่าน `userId` จาก `/v2/profile` (ไม่ verify `id_token`) | `lib/line/client.ts:139`, `:151-153`, `:181` |
| 9 | LIFF ไม่ใช้ SDK / ไม่เชื่อ `liff.getProfile()` — ใช้ session Supabase ปกติ, ยังไม่ล็อกอิน → `/sign-in?next=` | `app/gangs/[gangId]/liff/page.tsx:21-25,33` · `lib/supabase/auth.ts:19` · `STATE.md:434` |
| 10 | trigger `handle_new_user` สร้าง `profiles` ให้ทุก `auth.users` ใหม่ และ **ทนกรณีไม่มีอีเมล** (fallback `'สมาชิกใหม่'`) แต่อ่านชื่อจาก `raw_user_meta_data->>'display_name'` เท่านั้น | `supabase/migrations/20260813000014_handle_new_user.sql:21-24,49-51` |
| 11 | แอดมินเพิ่มสมาชิกด้วย **อีเมล** | `server/actions/members.ts:37-50` (`add_gang_member_by_email`) |
| 12 | `/sign-in` อ่านแค่ `next` — **ไม่แสดง `?error=`** ที่ callback ส่งมา (`missing_code` / `rate_limited` / `invalid_code`) | `app/sign-in/page.tsx:14` · `app/auth/callback/route.ts:22` |
| 13 | prod Supabase ref `emmzeriekkjryhucvctx` · โดเมนแอป `gang-badminton.vercel.app` (+ alias `gang-badminton-ruddy.vercel.app`) | `STATE.md:92,363` |

---

## 2. (1) Channel ระดับแพลตฟอร์ม

**Decision (ร่าง):** สร้าง **LINE Login channel ใหม่ 1 ใบ** (ประเภท Web app) ใน **LINE Provider ใหม่** ชื่อเช่น "Gang Badminton Platform" ·
channel นี้ **ไม่ใช่** `gang_line_configs.login_channel_id` ของก๊วนไหน และ **ไม่เก็บใน Vault** (Vault = credentials ต่อก๊วนตามกติกาทีม; ของแพลตฟอร์มอยู่ที่ Supabase Auth — ดู §7)

**ทำไมต้อง provider แยก และผลที่ตามมา (สำคัญที่สุดของ ADR นี้):**

- LINE ออก `userId` **ต่อ provider** — คำอธิบายนี้อยู่ในโค้ดเรา (`20260816000038_line_login.sql:4-6`, `.env.example:67-70`) และ discovery document ของ LINE ระบุ `"subject_types_supported": ["pairwise"]`
  (<https://access.line.me/.well-known/openid-configuration>, ตรวจ 27 ต.ค. 2026)
- ก๊วนแต่ละก๊วนสร้าง Messaging API (OA) ของตัวเอง ⇒ provider ของ OA ก๊วนหนึ่ง **ไม่ใช่** provider แพลตฟอร์มแน่ๆ
- ⇒ `sub` ที่ได้จาก channel แพลตฟอร์ม **≠** `member_line_links.line_user_id` (ซึ่ง LINE ใช้ส่ง push ผ่าน OA ของก๊วน)
- ⇒ **ห้ามเอา `sub` ของแพลตฟอร์มไปเขียนเป็น `line_user_id`** — push จะส่งไม่ถึง/ส่งผิดคน · และ `link_line_account()` ก็ไม่ควรถูกเรียกจากทางเข้าใหม่นี้

**ผลต่อ "ความคาดหวัง":** ผู้ใช้ที่เข้าด้วย LINE ยังต้อง **เพิ่มเพื่อน OA ของก๊วน + ผูกต่อก๊วน** (รหัสในแชต / LINE Login ต่อก๊วน) ถึงจะได้แจ้งเตือนทาง LINE — เหมือนเดิม ·
ข้อดีเดียวที่เพิ่มคือ "ชื่อ/รูปจาก LINE" กับ "กู้บัญชีได้"

⚠️ provider เปลี่ยนทีหลังไม่ได้แบบไม่เสียอะไร — `sub` ของผู้ใช้ทุกคนจะเปลี่ยนตาม ⇒ **เลือกให้ถูกตั้งแต่ก่อนมีผู้ใช้จริงบนทางนี้** (ตั้งชื่อ provider ให้เป็นของแพลตฟอร์มจริง ไม่ใช่ชื่อทดลอง)

---

## 3. (2) ทางเข้า Supabase Auth — เทียบ 2 แนวทาง

### Option A ★ — Custom OIDC provider ของ Supabase

- Supabase มี **Custom OAuth/OIDC providers**: id ต้องขึ้นต้น `custom:` · ใส่ `issuer` แล้ว discovery/JWKS/endpoint resolve เอง · **PKCE เปิดเป็นค่าเริ่มต้น** · verify ID token ด้วย JWKS · มี `email_optional` · แผน Free เพิ่มได้ **3 ตัว**
  (<https://supabase.com/docs/guides/auth/custom-oauth-providers>, ตรวจ 27 ต.ค. 2026)
- LINE เข้ากับเงื่อนไขนี้ได้: issuer `https://access.line.me` · ID token เซ็น **ES256** · รองรับ `code_challenge_methods: S256` · token endpoint รับ `client_secret_post/basic`
  (discovery document ข้างบน) — **Supabase ไม่มี LINE เป็น built-in provider** (รายชื่อใน `supabase/config.toml:323-324` ไม่มี `line`)
- ฝั่งเรา: ปุ่ม → server action เรียก `signInWithOAuth({ provider: 'custom:line', redirectTo: <origin>/auth/callback?next=<safeNext> })` → LINE → `https://<ref>.supabase.co/auth/v1/callback` → `/auth/callback` (**มีอยู่แล้ว** `app/auth/callback/route.ts`) → session

### Option B — custom flow: เราแลก code กับ LINE เองแล้วออก session เอง

- ใช้ต่อยอดโค้ด WO-4.D (`exchangeLoginCode`, `mintLoginState`) แต่ **Supabase ไม่มี API "ออก session ให้ user id นี้"** ที่เป็นทางการ ⇒ ทางที่ทำได้คือ `admin.createUser` (อีเมลสังเคราะห์ เช่น `line_<hash>@line.invalid`) + `admin.generateLink(magiclink)` + `verifyOtp(token_hash)` ฝั่ง server — *(ยังไม่ได้พิสูจน์ว่าทำงานจริง → §10 S4)*
- ต้องเก็บตารางจับคู่ LINE `sub` ↔ user เอง (ไม่ใช่ `auth.identities`)

### เทียบความเสี่ยง

| ประเด็น | A: Custom OIDC | B: custom flow |
|---|---|---|
| ใครตรวจ state/nonce/PKCE/ID token | **Supabase** (ผ่านการใช้งานวงกว้าง) | **เรา** — โค้ดเดิมยัง **ไม่มี PKCE** (`client.ts:134-141`) และไม่ verify `id_token` (`client.ts:151-153`) ⇒ ต้องเขียนเพิ่ม = พื้นผิวพลาดใหม่ |
| service-role ใน path สาธารณะ | **ไม่ต้อง** | ต้องเรียก `supabaseAdmin()` ใน route ที่คนไม่ล็อกอินเข้าถึงได้ — สวนแนวทางของ `lib/supabase/server.ts:15` ("admin เฉพาะหลังตรวจสิทธิ์") |
| กติกา "ห้ามให้ LINE ข้ามขั้นตอน auth ของ Supabase" | ✅ ตรง — session ออกโดย Supabase เอง | ⚠️ กำกวม — เรายืนยันตัวตนเองแล้วสั่ง Supabase ออกให้ (`app/gangs/[gangId]/liff/page.tsx:21-25`) |
| ตารางตัวตน | `auth.identities` (Supabase ดูแล, unique ต่อ provider+id) | ตารางใหม่ของเรา + อีเมลปลอมใน `auth.users.email` (รก, ผิดความหมาย) |
| ผูกบัญชีเดิม (§4) | `linkIdentity()` ทางการ | ต้องเขียนเอง ทุกเงื่อนไขกันยึดบัญชีเป็นภาระเรา |
| ความเสี่ยงของทางนี้ | ฟีเจอร์ใหม่ของ Supabase (ไม่มีใน CLI local → §10 S1) · ผูกกับแผน/quotaของ Supabase · `linkIdentity` กับ `custom:` ยังไม่ยืนยัน (S2) | ต้องดูแลเอง · ทดสอบ e2e จริงกับ LINE ยาก · ถ้า Supabase เปลี่ยนพฤติกรรม magiclink/OTP จะพัง |
| แรงงาน | S–M | M–L |
| ย้อนกลับ | ปิด provider ใน dashboard + ซ่อนปุ่ม (ผู้ใช้ LINE-only จะเข้าไม่ได้ — ดู §4 ข้อ R7) | ลบ route + ตาราง |

**แนะนำ:** Option A — ความเสี่ยงที่เหลือ (S1–S3) **ตรวจได้ถูกก่อนลงทุนเขียนโค้ด** · ถ้า S2 ไม่ผ่าน (linkIdentity ใช้กับ custom ไม่ได้) → กลับมาที่ planner ว่าจะ (i) ยอมให้ "บัญชีเดิมผูก LINE" ทำเป็นงาน operator เป็นรายเคส หรือ (ii) ย้ายไป Option B ทั้งก้อน

---

## 4. (3) บัญชีอีเมลเดิมผูก LINE เพื่อกู้บัญชี + กันการยึดบัญชี

### 4.1 ภัยที่ต้องกัน (อิงของจริงของระบบนี้)

| # | ภัย | ทำไมเสี่ยงจริงที่นี่ |
|---|---|---|
| T1 | **Pre-account-takeover ผ่านอีเมล**: คนร้ายสมัครด้วยอีเมลเหยื่อ+รหัสผ่านของตัวเองไว้ก่อน → เหยื่อมาเข้าด้วย LINE ที่คืนอีเมลเดียวกัน → Supabase **auto-link ตามอีเมล** → คนร้ายยังมีรหัสผ่านเข้าบัญชีเดียวกัน | Supabase เตือนเรื่องนี้เองว่า auto-link ต้องการอีเมลที่ยืนยันแล้ว (<https://supabase.com/docs/guides/auth/auth-identity-linking>) · **ระบบเราปิดการยืนยันอีเมล** (`STATE.md:398`) ⇒ อีเมลทุกบัญชีเชื่อไม่ได้ + `/sign-up` เปิดสาธารณะ (`config.toml:180,225`) |
| T2 | ผูก LINE ของคนอื่นเข้าบัญชีฉัน/ผูกบัญชีฉันกับ LINE คนอื่น (login CSRF) | ถ้าไม่มีผูก state กับเบราว์เซอร์ |
| T3 | LINE หนึ่งใบผูกได้หลายบัญชี → ใช้ LINE เดียวเข้าบัญชีที่ไม่ใช่ของตน | |
| T4 | ถอด LINE ออกจนบัญชีไม่เหลือทางเข้า (lockout) หรือถอดแล้วคนอื่นผูกต่อ | |
| T5 | สร้างบัญชีซ้ำโดยไม่ตั้งใจ (คนมีบัญชีอีเมลเดิมกด "เข้าด้วย LINE" ตอนยังไม่ได้ผูก) → ได้บัญชีใหม่ว่างเปล่า เงิน/ประวัติอยู่บัญชีเก่า | **เกิดแน่** ถ้าไม่จัดการ — ดู 4.3 |

### 4.2 กติกา (ร่าง — ทุกข้อต้องมีเทสต์ใน WO ที่ตามมา)

- **R1** ไม่ขอ `email` scope จาก LINE (ขอ `openid profile` เท่านั้น) และตั้ง provider เป็น `email_optional` ⇒ identity จาก LINE **ไม่มีอีเมล** ⇒ ไม่มีอะไรให้ auto-link จับคู่ (ตัด T1 ที่ต้นทาง) · LINE เองก็ต้องยื่นขอสิทธิ์อีเมลก่อนถึงจะได้ (<https://developers.line.biz/en/docs/line-login/integrate-line-login/>) — เราไม่ยื่น
- **R2** การผูก LINE เข้าบัญชีเดิมทำได้ **เฉพาะตอนล็อกอินบัญชีนั้นอยู่** ผ่าน `linkIdentity()` (manual linking) — ❌ ไม่มีการ "เดาว่าเป็นคนเดียวกัน" จากอีเมล/ชื่อ/เบอร์
- **R3** LINE `sub` หนึ่งค่าอยู่ใน `auth.identities` ได้ที่เดียว — ถ้าผูกอยู่กับบัญชีอื่นแล้ว `linkIdentity()` ล้ม (ตาม docs ของ Supabase; ยืนยันจริงใน S2) ⇒ UI ต้องบอกว่า "LINE นี้ถูกใช้กับบัญชีอื่นแล้ว" **โดยไม่บอกว่าเป็นบัญชีของใคร**
- **R4** state/nonce/PKCE ถูกจัดการโดย Supabase (Option A) — เราไม่เขียนเอง ⇒ ตัด T2 · ปลายทางหลังล็อกอิน `next` ต้องผ่าน `safeNext()` ก่อนฝังใน `redirectTo` (`lib/url/safe-next.ts:17` — hotfix open redirect `1edf989` เพิ่งปิดจุดนี้ที่ `/sign-in`)
- **R5** ห้ามถอด LINE ถ้าเป็นทางเข้าเดียวของบัญชี (Supabase บังคับให้เหลือ ≥ 2 identities ก่อน unlink ตามความเข้าใจ — **ยืนยันใน S2**; ถ้าไม่บังคับ เราต้องกันเอง)
- **R6** ❌ ห้ามเขียน `auth.identities` / `auth.users` ตรงจากโค้ดเรา (ใช้ API ของ Supabase Auth เท่านั้น)
- **R7** ถ้าวันหนึ่งปิด provider LINE ทิ้ง ผู้ใช้ **LINE-only** (ไม่มีอีเมล/รหัสผ่าน) จะเข้าไม่ได้ทันที ⇒ ก่อนปิดต้องมีแผนรองรับ (เช่น ให้เพิ่มอีเมล+รหัสผ่านให้บัญชี) — ระบุไว้เป็น consequence ไม่ใช่งานตอนนี้
- **R8** audit: `event_logs` ผูกกับก๊วนเสมอ (ทุก insert ที่เห็นมี `gang_id` เช่น `20260816000036_line_account_link.sql:101-105`) ⇒ **ยังไม่มีที่บันทึก "ผูก/ถอด LINE ระดับแพลตฟอร์ม"** · ใช้ Auth logs ของ Supabase ไปก่อน — อย่าอ้างว่ามี audit trail ของเราเอง

### 4.3 จุดที่ "กู้บัญชี" ยังไม่ครอบ (ต้องตัดสิน → Q4)

- แผน §3 C12 มองว่า LINE Login แทน "ลืมรหัสผ่าน" · **ของจริง:** LINE Login คืน **บัญชีใหม่** ถ้า LINE นั้นยังไม่เคยผูกกับบัญชีไหน (ไม่มีอีเมลให้จับคู่ — ตาม R1) ⇒ คนที่ลืมรหัสผ่านและ **ยังไม่ได้ผูก LINE ล่วงหน้า** กู้บัญชีเดิมไม่ได้ด้วยทางนี้
- ⇒ การกู้บัญชีใช้ได้เฉพาะ "คนที่ผูก LINE ไว้ตอนยังเข้าบัญชีได้" ⇒ ต้องมี **cutover**: ให้ผู้ใช้เดิม (รวมเจ้าของก๊วนจริง) ผูก LINE ก่อน + แบนเนอร์เตือนหลังล็อกอิน
- การ "รวมบัญชี" (merge) หลังเกิดเหตุ **แตะเงิน/ledger/registration** ⇒ ไม่ทำเป็นฟีเจอร์ในแอป · ถ้าจำเป็นให้เป็น runbook SQL โดย operator + หลักฐานยืนยันตัวตนนอกระบบ

### 4.4 ผลข้างเคียงของ "ไม่มีอีเมล" (ต้องรู้ก่อนเลือก R1)

- แอดมินเพิ่มสมาชิกด้วยอีเมล (`members.ts:37-50`) ⇒ **ผู้ใช้ LINE-only ถูกเพิ่มด้วยวิธีนี้ไม่ได้** · ยังไม่ได้ตรวจว่าก๊วน **private** มีทางเข้าที่ไม่ใช้อีเมลหรือไม่ (ใช้ `join_requests` ได้เฉพาะก๊วนที่ค้นเจอ — `STATE.md:440` ส่วน Phase 3) ⇒ ถือเป็น **gap ที่ WO ตามมาต้องตรวจ/ปิด**
- ชื่อ: trigger อ่านเฉพาะ `display_name` (`handle_new_user.sql:49`) ⇒ ผู้ใช้ LINE ใหม่จะได้ `'สมาชิกใหม่'` (`:51`) จนกว่าจะแก้ trigger ให้ดึงชื่อจาก claim ของ LINE (ชื่อ key ที่ Supabase ใส่ใน `raw_user_meta_data` สำหรับ custom OIDC → S3)

---

## 5. (4) ผลกับ LIFF และ LINE Login ต่อก๊วนที่มีอยู่

| ของเดิม | ผลกระทบ | ต้องแก้โค้ดไหม |
|---|---|---|
| `/api/line/login/callback` + `server/line/login.ts` (WO-4.D) | **แยกขาด**: redirect_uri คนละตัว (`/api/line/login/callback` vs `…supabase.co/auth/v1/callback`), cookie คนละชื่อ (`line_login_nonce` — `lib/line/login-state.ts:23`), channel คนละใบ, ยังต้องมี session ก่อน (`login.ts:69-81`) | ❌ ไม่ต้อง |
| `link.ts` / `link_line_account()` | ยังเป็น **ทางเดียว** ที่เขียน `member_line_links` · ทางเข้าใหม่นี้เขียนลง `auth.identities` ซึ่งเป็นคนละเรื่อง ⇒ **ตีความกติกา "ผูกบัญชีลง `link.ts` ทางเดียว" (`STATE.md:432-433`) ว่าครอบ `member_line_links` ต่อก๊วน — ไม่ครอบตัวตนระดับ Auth** (ขอยืนยัน → Q8) | ❌ ไม่ต้อง (แต่ควรเติมประโยคกำกับใน STATE.md ตอนปิด WO) |
| LIFF `/gangs/[id]/liff` | `requireUser()` → `/sign-in?next=/gangs/<id>/liff` (`lib/supabase/auth.ts:19`) ⇒ **หน้า sign-in ต้องมีปุ่ม LINE ที่ใช้ได้ใน in-app browser ของ LINE** (ผู้ใช้อยู่ใน LINE อยู่แล้ว → กด 1 ครั้ง) · `buildLiffView` ไม่แตะ (`server/line/liff.ts:57`) | ❌ ไม่ต้อง (แก้ที่หน้า sign-in) |
| ข้อความ UI ของ LINE Login ต่อก๊วน | ผู้ใช้จะสับสนระหว่าง "เข้าสู่ระบบด้วย LINE" (แพลตฟอร์ม) กับ "ผูกบัญชี LINE" (ก๊วน) | ✅ ปรับถ้อยคำ (งาน @gb-frontend) |
| Messaging API webhook | ไม่เกี่ยว | ❌ |

**ข้อสังเกต:** คนที่เข้าด้วย LINE แล้วเปิดหน้า `/gangs/<id>/line` จะเห็น "ยังไม่ผูก" (ถูกต้อง — คนละเรื่อง) ⇒ ต้องมีข้อความอธิบายสั้นๆ ไม่งั้นคิดว่าระบบพัง

---

## 6. (5) CSP / redirect URI / rate limit

### 6.1 CSP — ไม่ต้องแก้ ถ้าทำตามนี้

- `connect-src 'self' + Supabase` (`lib/security/csp.ts:107`) — เบราว์เซอร์ **ไม่เรียก LINE โดยตรง** (Supabase server แลก token เอง) ⇒ ไม่ต้องเพิ่ม `access.line.me` / `api.line.me`
- 🔴 `form-action 'self'` (`csp.ts:115`): **ห้ามทำปุ่มเป็น `<form action=…>` ที่ redirect ไป `access.line.me`** — เบราว์เซอร์ (อย่างน้อย Chrome) บังคับ `form-action` กับปลายทางของ redirect หลัง submit ด้วย *(จากความรู้ทั่วไปของสเปก CSP — ยังไม่ได้ทดสอบกับแอปนี้ → ต้องมี e2e ในเบราว์เซอร์จริง `e2e-browser/`)* ·
  ใช้รูปแบบเดียวกับของเดิม: `onClick` → server action คืน URL → `window.location.href = url` (`features/line/LinkLinePanel.tsx:123` ใช้อยู่แล้วกับ CSP ปัจจุบัน)
- `frame-ancestors 'none'` / `frame-src 'none'` (`csp.ts:111-112`) — ไม่กระทบ: ไม่ใช้ iframe/popup
- `/sign-in` เป็น dynamic (ไม่อยู่ใน `STATIC_ROUTES` — `csp.ts:46-51`) ⇒ nonce ทำงานปกติ · ถ้าจะวางปุ่มที่ `/sign-up` (static) ก็ใช้ได้ (หน้า static ใช้ `unsafe-inline`) · **ห้ามเพิ่มหน้า static ใหม่โดยไม่เติม `STATIC_ROUTES`** (`csp.ts:32`; มีเทสต์ manifest คุม)

### 6.2 Redirect URI ที่ต้องมี (ต้องตรงตัวอักษร)

| ที่ | ค่า | หมายเหตุ |
|---|---|---|
| **LINE Console → LINE Login → Callback URL** | `https://emmzeriekkjryhucvctx.supabase.co/auth/v1/callback` | ✅ **คัดลอกจากช่อง "Callback URL" ที่ Supabase โชว์ตอนสร้าง provider** แทนการพิมพ์เอง (Supabase แสดงให้ — docs ข้างบน) · ถ้าวันหนึ่งใช้ custom domain ของ Supabase ต้องแก้ทั้งสองฝั่ง |
| **Supabase Dashboard → Auth → URL Configuration → Redirect URLs** | `https://gang-badminton.vercel.app/auth/callback` (+ alias `https://gang-badminton-ruddy.vercel.app/auth/callback` ถ้ายังจะให้ใช้) | magic link ใช้ `${origin}/auth/callback?next=…` อยู่แล้ว (`server/actions/auth.ts:87,92`) จึง **น่าจะ** มีอยู่ — แต่ repo ไม่มีบันทึกค่าใน dashboard ⇒ **ตรวจของจริง อย่าสมมติ** |
| (ไม่เกี่ยว) LINE Callback ของ WO-4.D ต่อก๊วน | `<โดเมน>/api/line/login/callback` | ไม่เปลี่ยน — อยู่คนละ channel |
| local dev | ใช้ไม่ได้จนกว่า S1 ตอบ | `supabase/config.toml` ไม่มีช่องตั้ง custom provider (`:323-326` มีแต่ built-in) |

⚠️ **ความไม่สม่ำเสมอที่เจอ:** `startLineLogin` สร้าง origin จาก `APP_BASE_URL ?? x-forwarded-host` (`server/actions/line.ts:515`) แต่ magic link ใช้ header `origin` (`server/actions/auth.ts:87`). ทางเข้า LINE ใหม่ต้อง **เลือกอย่างเดียว** (★ `APP_BASE_URL` ถ้าตั้ง) ไม่งั้นเข้าผ่าน alias แล้ว `redirectTo` ไม่อยู่ใน allow-list

### 6.3 Rate limit (กติกาแข็ง: ทางเข้าสาธารณะใหม่ต้องมีเพดาน + ลง `docs/rate-limits.md`)

| ทางเข้าใหม่ | scope (เสนอ) | เพดาน (เสนอ) | เหตุผล |
|---|---|---|---|
| server action เริ่ม LINE sign-in (เรียกได้โดยคนไม่ล็อกอิน) | `auth:line-start` | **20 / ชม. / IP** | แค่สร้าง URL + cookie PKCE (ไม่ยิง LINE) แต่เป็นประตูสมัครบัญชีใหม่ — กันถล่มสร้าง user |
| `/auth/callback` (ใช้ร่วมกับอีเมลเดิม) | `auth:callback` (เดิม 30/ชม.) | **คงเดิม แล้ววัด** | ⚠️ คนที่ล็อกอินที่สนามเดียวกันใช้ IP เดียว (Wi-Fi/CGNAT) — LINE-first ทำให้ทุกคนผ่านทางนี้ ⇒ ตั้งเป็นเรื่องให้วัดหลังเปิดใช้ ไม่ปรับล่วงหน้า (Q7) |

เมื่อ implement: ต้องเพิ่มแถวใน `tests/security/rate-limit.test.ts:140` (`cases`) — เทสต์ตัวนั้นเทียบโค้ดกับ `docs/rate-limits.md` อยู่แล้ว · Supabase เองมีเพดาน `sign_in_sign_ups = 30 / 5 นาที / IP` ของฝั่ง Auth (`config.toml:211` — ค่า local, ของ cloud ตรวจใน dashboard)

---

## 7. (6) env / secret ใหม่

**Option A (★): ไม่มี env ใหม่ใน Vercel/`.env`**

| ค่า | อยู่ที่ไหน | เหตุผล |
|---|---|---|
| LINE Channel ID + Channel secret ของแพลตฟอร์ม | **Supabase Dashboard → Auth → Custom Providers** (Supabase เก็บเอง) | token endpoint ถูกเรียกจาก Supabase server ไม่ใช่ Next ⇒ แอปเราไม่ต้องเห็น secret เลย (ดีกว่าแบบที่ต้องมีใน env) |
| provider id `custom:line` | ค่าคงที่ในโค้ด (ไม่ลับ) | |
| โดเมนแอป | `APP_BASE_URL` (**มีอยู่แล้ว** — `.env.example:53`) | ต้อง **ตั้งจริง** บน production เพื่อให้ `redirectTo` นิ่ง (§6.2) |
| `LINE_LINK_SECRET` | **ไม่เกี่ยว** — ใช้เซ็น state ของ WO-4.B/4.D (`lib/line/login-state.ts:26`) | Option A ไม่ใช้ |

- ❌ **ห้ามใส่ Channel secret ของแพลตฟอร์มลง repo, `.env.example`, Vault ต่อก๊วน, แชต หรือ log** · ไม่ต้องบอกบอท — เจ้าของงานกรอกเองใน dashboard (กติกาห้ามพิมพ์/รับ secret ในแชต)
- ถ้า Dashboard ไม่มีช่อง `email_optional` ต้องสร้าง provider ผ่าน Auth admin API (`auth.admin.customProviders.createProvider`) ซึ่งต้องใช้ secret key ของโปรเจกต์ → สคริปต์ครั้งเดียว **รันโดยเจ้าของงาน ไม่ commit key** (S1)
- ต้องแก้เอกสาร: `.env.example`/`README.md` (เพิ่มส่วน "LINE Login ระดับแพลตฟอร์ม — ตั้งใน Supabase ไม่ใช่ env") และ `STATE.md`

**Option B (ถ้าถูกเลือก):** `LINE_PLATFORM_CHANNEL_ID`, `LINE_PLATFORM_CHANNEL_SECRET` (Vercel server-only) + ใช้ `LINE_LINK_SECRET` เดิมเซ็น state — และข้อห้ามเรื่อง log เดียวกัน

---

## 8. (7) ขั้นตอนที่เจ้าของงานต้องทำ — LINE Developers Console + Supabase

> ชื่อเมนูอาจต่างเล็กน้อยตามหน้าคอนโซลจริง — ถ้าไม่ตรง ให้ถ่ายหน้าจอส่ง @gb-integrations (ปิดบัง secret) · ลำดับสำคัญ: **Supabase ให้ Callback URL ตอนสร้าง provider** จึงต้องสลับไปมาตามข้อ 6–8
> 🔴 **ห้ามส่ง Channel secret ให้ใคร/บอทใดๆ**

**ก่อนเริ่ม (ครั้งเดียว)** — [ปรับตาม Q6 §0.1] ทำบนโปรเจกต์เดิม `emmzeriekkjryhucvctx` ได้เลย (ยังไม่มีผู้ใช้จริง) แต่ห้ามแก้ค่า Auth ที่กระทบผู้ใช้เดิม · ขั้นตอนฉบับคลิกต่อคลิกอยู่ที่ `docs/ops/line-login-setup.md`

1. เข้า <https://developers.line.biz/console/> ด้วยบัญชี LINE ที่จะเป็น "เจ้าของแพลตฟอร์ม" (แนะนำบัญชีที่ไม่หายง่าย — ผู้ดูแล provider คนเดียวที่หายไป = เสียสิทธิ์จัดการ channel)
2. **Create a new provider** → ชื่อ `Gang Badminton Platform` (หรือชื่อทางการที่ต้องการ — **เปลี่ยนทีหลังไม่ได้แบบไม่เสีย `sub` ผู้ใช้**; ต้องเป็น provider ใหม่ ไม่ใช้ร่วมกับ provider ของ OA ก๊วนใด)
3. ใน provider นั้น → **Create a new channel → LINE Login**
   - Region: ประเทศที่ให้บริการ (Thailand) · Channel name: ชื่อที่ผู้ใช้เห็นในหน้าขออนุญาตของ LINE (เช่น "Gang Badminton") · Description · Icon
   - **App types: เลือก "Web app" เท่านั้น**
   - ยอมรับข้อตกลง → Create
4. แท็บ **Basic settings** → จด **Channel ID** และ **Channel secret** (เก็บใน password manager) · ใส่ **Privacy policy URL / Terms of use URL** ถ้ามีหน้าแล้ว (ควรมีก่อนเปิดจริง — ผูกกับ B3 PDPA)
5. **OpenID Connect → Email address permission: ไม่ต้อง Apply** (ตาม R1)
6. เปิด **Supabase Dashboard** (โปรเจกต์ทดสอบก่อน) → Authentication → Sign In / Providers → ท้ายหน้า **Custom Providers → New Provider** → เลือก **Auto-discovery (OIDC)**
   - Identifier: `custom:line` · Client ID = Channel ID · Client Secret = Channel secret · Issuer URL: `https://access.line.me` · Scopes: `openid profile` · เปิด **email optional** (ถ้าไม่มีช่อง → ดู §7)
   - **ก่อนกด Create**: คัดลอก **Callback URL** ที่หน้าฟอร์มโชว์
7. กลับ LINE Console → แท็บ **LINE Login** → **Callback URL** → วางค่าจากข้อ 6 → Save
8. กลับ Supabase → **Create and enable provider**
9. Supabase → Authentication → **URL Configuration** → ตรวจ/เพิ่ม **Redirect URLs** ตาม §6.2 · Authentication → **Sign In / Providers (หรือ Settings)** → เปิด **Manual Linking** (ใช้กับ `linkIdentity`; ใน `config.toml` local เป็น `false` — `:184`; ค่า cloud ตรวจจาก dashboard)
10. **ทดสอบในโหมด Developing:** channel ใหม่อยู่สถานะ *Developing* — ล็อกอินได้เฉพาะ admin/tester ของ channel (เพิ่มคนทดสอบที่แท็บ **Roles**) · ให้ @gb-qa เดินตาม DoD ของ spike
11. **ก่อนเปิดจริง: เปลี่ยน channel เป็น Published** (ปุ่มสถานะด้านบนหน้า channel) — ไม่ทำ = ผู้ใช้ทั่วไปเข้าไม่ได้
12. ~~ทำซ้ำบน prod แยกจากโปรเจกต์ทดสอบ~~ — [ยกเลิกตาม Q6 §0.1] spike กับ prod เป็นโปรเจกต์เดียวกัน จึงไม่มีรอบสองให้ทำซ้ำ
13. จด "ใครมีสิทธิ์ admin ใน provider/channel นี้" ใน README (คน ไม่ใช่ secret)

---

## 9. คำถามที่ต้องให้เจ้าของงานตัดสิน

| # | แผนบอก | ของจริงคือ | ทางเลือกคือ (★ = แนะนำ) |
|---|---|---|---|
| **Q1** | `phase6-redesign-plan.md` §5 B1: "ทางเข้า Supabase Auth (OIDC)" | Supabase มี Custom OIDC (Free ได้ 3 ตัว, PKCE ในตัว, `email_optional`) แต่ **ไม่มี LINE built-in** (`config.toml:323-324`) และ **local CLI ตั้งไม่ได้** (ไม่มีช่องใน `config.toml`) ⇒ ทดสอบ e2e กับ LINE จริงทำได้เฉพาะบน cloud | **★ A** Custom OIDC · B custom flow (ออก session เอง — งานมากกว่า ความเสี่ยงสูงกว่า §3) |
| **Q2** | "channel ระดับแพลตฟอร์ม" (เหมือนเป็นขั้นต่อของ WO-4.D) | `userId` ผูกกับ provider (`…0038_line_login.sql:4-6`) ⇒ `sub` ของแพลตฟอร์ม ≠ `member_line_links.line_user_id` ของก๊วน ⇒ **Login แพลตฟอร์มแทนการผูกต่อก๊วนไม่ได้** | **★ provider ใหม่แยก + ผูกต่อก๊วนยังทำเหมือนเดิม** · ทางเลือก: ใช้ provider เดียวกับ OA ของก๊วนเรา (ได้ก๊วนเดียว ไม่ขยายได้ — ไม่แนะนำ) |
| **Q3** | "บัญชีอีเมลเดิมผูก LINE เพื่อกู้บัญชี" | อีเมลทุกบัญชี **ไม่เคยยืนยัน** (`STATE.md:398`) + Supabase auto-link ตามอีเมลเสี่ยงยึดบัญชี | **★ ไม่ขอ email scope + `email_optional` + ผูกด้วย `linkIdentity` ตอนล็อกอินอยู่เท่านั้น** · ทางเลือก: ขอสิทธิ์อีเมลจาก LINE + ยืนยันอีเมลก่อน (ต้องมี SMTP = ขัดคำตัดสิน C12) |
| **Q4** | LINE Login ใช้แทน "ลืมรหัสผ่าน" (C12) | LINE ที่ไม่เคยผูก → ได้ **บัญชีใหม่ว่าง** ไม่ใช่บัญชีเดิม ⇒ ใครลืมรหัสผ่านก่อนผูก LINE กู้ไม่ได้ | **★ cutover: ผู้ใช้เดิมทุกคน (รวมเจ้าของก๊วนจริง) ผูก LINE ก่อนเปิดทางหลัก + แบนเนอร์เตือน · เคสตกหล่น = runbook SQL โดย operator** · ทางเลือก: สร้างเครื่องมือ merge ในแอป (แตะเงิน — ไม่แนะนำ) |
| **Q5** | "ทางเข้าหลัก" (ไม่ใช่ "ทางเดียว") | `/sign-up` อีเมลเปิดสาธารณะอยู่ (`config.toml:180,225`); ผู้ใช้เดิมใช้รหัสผ่านอยู่ | **★ คงอีเมล+รหัสผ่านเป็นทางสำรอง, ปุ่ม LINE เป็นปุ่มหลักบนสุด** · ทางเลือก: ปิดสมัครอีเมลใหม่ (LINE-only สำหรับคนใหม่; ผู้ใช้เดิมยังเข้าได้) |
| **Q6** | (แผนไม่ได้พูด) | prod Supabase มีก๊วนจริง (`STATE.md:389` ก๊วนเรนนี่) · การเปิด provider/Manual Linking/Redirect URLs เป็นการแก้ค่าตั้ง Auth ของ prod | **★ spike S1–S3 บนโปรเจกต์ Supabase ทดสอบแยกก่อน (เจ้าของงานสร้างโปรเจกต์ว่าง 1 อัน) → ผ่านแล้วค่อยขอ OK แก้ prod** · ทางเลือก: ลองบน prod เลย (ไม่แนะนำ) |
| **Q7** | (แผนไม่ได้พูดเลข) | `auth:callback` = 30/ชม./IP (`rate-limits.md:21`) ถูกตั้งตอนใช้แค่ลิงก์อีเมล · LINE-first + ผู้เล่นอยู่สนามเดียวกัน (IP เดียว) | **★ `auth:line-start` = 20/ชม./IP (ใหม่) · `auth:callback` คงเดิมแล้ววัดหลังเปิดใช้** · ทางเลือก: ขยาย callback เป็น 60/ชม. ตั้งแต่แรก |
| **Q8** | กติกา "ผูกบัญชีลง `link.ts` ทางเดียว" (`STATE.md:432-433`) | Option A เพิ่มการ "ผูก LINE กับบัญชี" ระดับ Auth ที่ **ไม่ผ่าน `link.ts`** (เขียน `auth.identities` ผ่าน Supabase) | **★ ตีความ: `link.ts` = `member_line_links` ต่อก๊วน; ตัวตนระดับ Auth = Supabase Auth API เท่านั้น (ห้ามเขียน `auth.*` ตรง) — เติมประโยคนี้ใน STATE.md** · ทางเลือก: ขยายกติกาให้ห้ามทุกอย่างที่ไม่ผ่าน `link.ts` (จะบังคับ Option B) |
| **Q9** | (แผนไม่ได้พูด) | ผู้ใช้ LINE-only ไม่มีอีเมล ⇒ **แอดมินเพิ่มด้วยอีเมลไม่ได้** (`members.ts:37-50`) และยังไม่ได้ตรวจว่าก๊วน private มีทางเชิญอื่น | **★ ให้ WO ที่ตามมาตรวจทางเข้าก๊วนของคนไม่มีอีเมลก่อนเปิดใช้ ถ้าไม่มีให้เพิ่ม (เช่น ลิงก์/รหัสเชิญเข้าก๊วน) — ทำเป็น WO แยก ไม่ยัดใน B1** · ทางเลือก: ยอมรับว่าผู้ใช้ LINE-only เข้าก๊วนผ่าน join request ได้เท่านั้น |

---

## 10. สิ่งที่ยัง "ไม่ยืนยัน" — ต้อง spike ก่อนเขียนโค้ดจริง

| # | คำถาม | ทำไมสำคัญ | วิธีพิสูจน์ (บนโปรเจกต์ทดสอบ) |
|---|---|---|---|
| **S1** | สร้าง custom OIDC ของ LINE ได้จริงไหม · `email_optional` มีใน Dashboard หรือต้องใช้ admin API · local `supabase start` รองรับ custom provider ไหม | ถ้า local ไม่รองรับ ⇒ เทสต์อัตโนมัติของ flow นี้ทำบน cloud/mocked เท่านั้น (ต้องกำหนดกลยุทธ์เทสต์ใน WO) | ทำตาม §8 ข้อ 6–8 แล้วเปิด `…/auth/v1/authorize?provider=custom:line` |
| **S2** | `linkIdentity({ provider: 'custom:line' })` ทำงานกับ custom provider ไหม · ล้มเมื่อ LINE นั้นผูกบัญชีอื่น · `unlinkIdentity` ถูกกันเมื่อเหลือ identity เดียวหรือไม่ | R2/R3/R5 ทั้งหมดพึ่งสิ่งนี้ — **ถ้าไม่ผ่าน ADR ต้องกลับมาตัดสินใหม่** | เปิด Manual Linking → ล็อกอินอีเมล → `linkIdentity` → ตรวจแถวใน `auth.identities` → ลองผูก LINE เดิมกับบัญชีที่สอง → ลอง unlink |
| **S3** | claim จาก LINE (`name`, `picture`) ลง `raw_user_meta_data` ด้วย key อะไร · บัญชีที่ไม่มีอีเมลสร้างได้และ `handle_new_user` ผ่านไหม | กำหนดการแก้ trigger/`profiles` (ชื่อที่แสดง) | ล็อกอินด้วยบัญชีทดสอบแล้วอ่าน `auth.users` + `profiles` |
| **S4** | (เฉพาะถ้าเลือก Option B) `generateLink(magiclink)` + `verifyOtp(token_hash)` ออก session ให้ user ที่ไม่มีอีเมลจริงได้ไหม | ฐานของ Option B ทั้งหมด | ไม่ทำจนกว่า S2 ล้ม |
| **S5** | ในเบราว์เซอร์ in-app ของ LINE (เปิดผ่าน LIFF) flow OAuth ไป-กลับ `access.line.me` → `supabase.co` → แอปเรา **เก็บ cookie PKCE ครบ** ไหม | LIFF เป็นเหตุผลหลักที่คนจะกดปุ่มนี้ | ทดสอบบนมือถือจริงในโหมด Developing |
| **S6** | `form-action` ครอบ redirect จริงไหมในเบราว์เซอร์ที่ใช้ (ถ้าใครทำปุ่มเป็นฟอร์ม) | §6.1 | เทสต์ e2e-browser เดินปุ่มจริง ตรวจ console violation |

### 10.1 ข้อสมมติที่โค้ด WO-B1.c พึ่งอยู่ (เขียนไว้ตรงๆ — ยังไม่พิสูจน์บน cloud)

WO-B1.c (`server/actions/line-identity.ts`, `lib/line/identity.ts`, `features/profile/LineAccount*.tsx`) เขียนและเทสต์ด้วย **mock ฝั่ง Supabase**
(`tests/auth/line-identity.test.ts`) — เทสต์พิสูจน์ว่า *เรา* เรียก SDK ถูก (รวมเทสต์ที่ใช้ `supabase-js` จริงกับ fetch ที่ stub: ยิง `GET /auth/v1/user/identities/authorize?provider=custom:line` พร้อม JWT ผู้ใช้ + PKCE S256)
แต่ **ไม่ได้พิสูจน์พฤติกรรมของ Supabase cloud** — ถ้าข้อใดผิด แก้ที่ระบุในคอลัมน์ขวา

| # | ข้อสมมติ | พึ่งที่ไหน | ถ้าผิด จะเห็นอะไร / แก้ที่ไหน |
|---|---|---|---|
| A1 | identity ของ Custom OIDC มี `provider === 'custom:line'` | `findLineIdentity()` (`lib/line/identity.ts`) | UI ขึ้น "ยังไม่ผูก" ทั้งที่ผูกแล้ว และถอดไม่ได้ (fail-safe) · แก้ค่าคงที่ที่เดียว |
| A2 | `linkIdentity` กับ `custom:` ใช้ได้ เมื่อเปิด Manual Linking | `startLineLink()` | `linkIdentity` คืน error → INTERNAL_ERROR + log code/status · ถ้าใช้ไม่ได้จริง ADR ต้องกลับมาตัดสินใหม่ (ดู S2) |
| A3 | LINE ที่ผูกกับบัญชีอื่นแล้ว → Supabase redirect กลับพร้อม `error_code=identity_already_exists` | `app/auth/callback/route.ts` (→ `/profile?line=in_use`) | ตกเป็น `failed` (ข้อความกลางๆ) ไม่เปิดเผยว่าเป็นบัญชีของใคร — ปลอดภัย แต่ข้อความไม่เจาะจง |
| A4 | ผูกสำเร็จ → Supabase redirect ไป `redirectTo` พร้อม `code` และ `exchangeCodeForSession` ได้ session ของ **ผู้ใช้เดิม** | callback | ผู้ใช้เห็น `?line=linked` แต่ panel ยังขึ้น "ยังไม่ผูก" (แบนเนอร์ "ผูกแล้ว" ซ่อนเมื่อสถานะจริงไม่ตรง) |
| A5 | `unlinkIdentity` ถูกกันที่ Supabase เมื่อเหลือ identity เดียว (ตามเอกสาร SDK) | R5 | เรามีด่านของเราเองก่อนยิง (`canUnlinkLine`) จึงไม่พึ่งข้อนี้เป็นด่านเดียว |

**การตีความ R5:** "มี identity อื่นเหลือ" ≠ "เข้าได้จริง" (เช่น identity อีเมลที่ไม่เคยตั้งรหัสผ่าน + ไม่มี SMTP) — ฟอร์มสมัครของเราบังคับรหัสผ่านอยู่แล้ว จึงยอมรับ · ถ้าวันหนึ่งเปิดทางสมัคร LINE-only แล้วให้ "เพิ่มอีเมล+รหัสผ่านทีหลัง" ต้องมีหน้านั้นก่อนถึงจะถอด LINE ได้

**ภัย login CSRF / ผูก LINE ของคนร้ายเข้าบัญชีเหยื่อ (T2):** เริ่ม flow ได้เฉพาะ server action ที่ใช้ session เหยื่อ (Next ตรวจ origin ของ server action) และ PKCE verifier อยู่ใน cookie ของเบราว์เซอร์เหยื่อ ⇒ code ที่คนร้ายป้อนมาให้ callback แลกไม่ได้ — *พึ่ง PKCE ของ Supabase (A4) ซึ่งต้อง spike ยืนยัน*

---

## 11. Consequences (ถ้าอนุมัติแนวทาง ★)

**ดี**
- ไม่ต้องมี SMTP · session/PKCE/ID token ถูกจัดการโดย Supabase · ไม่มีตาราง/secret ใหม่ในแอป · ใช้ `/auth/callback` เดิมทั้งหมด
- ผู้เล่นที่อยู่ใน LINE อยู่แล้ว (เปิด LIFF) เข้าได้ด้วยการกดครั้งเดียว

**แลก**
- พึ่งฟีเจอร์ Custom OIDC ของ Supabase (ใหม่ · ไม่มีใน CLI local) ⇒ ต้องมีกลยุทธ์เทสต์บน cloud
- ผู้ใช้ LINE-only: ไม่มีอีเมล ⇒ เพิ่มด้วยอีเมลไม่ได้ (Q9) · เสีย LINE = เสียบัญชี ถ้าไม่ได้ผูกอีเมลไว้ (R7)
- ต้อง cutover ผู้ใช้เดิม (Q4) — คนตกหล่นต้องให้ operator ช่วยรายเคส
- ผู้ใช้ต้องผูก LINE ต่อก๊วนอีกชั้นเพื่อรับแจ้งเตือน (§2) — ต้องสื่อสารใน UI ไม่ให้สับสน

**ห้ามทำ (กติกาที่ ADR นี้ตั้ง)**
- ❌ เอา `sub` แพลตฟอร์มไปเขียน `member_line_links` · ❌ auto-link ด้วยอีเมล · ❌ เขียน `auth.identities` ตรง · ❌ ปุ่มเป็น `<form action>` ที่ redirect ออกนอกโดเมน · ❌ ใส่ secret ของ channel ใน repo/env/log/แชต

---

## 12. ขอบเขตงานที่จะตามมา (ยังไม่ใช่ตอนนี้ — รอ Q1–Q9 + spike)

| ใบ | เจ้าของ | เนื้อหา |
|---|---|---|
| WO-B1.a | @gb-integrations | server action เริ่ม LINE sign-in (+ `safeNext`, rate limit `auth:line-start`, เติม `docs/rate-limits.md` + เทสต์ `rate-limit.test.ts`) · helper origin กลาง · e2e-browser ตรวจ CSP |
| WO-B1.b | @gb-backend | migration: แก้ `handle_new_user` ดึงชื่อจาก claim LINE (หลัง S3) · เทสต์ว่า user ไม่มีอีเมลสร้างได้ |
| WO-B1.c | @gb-frontend | ปุ่ม LINE บน `/sign-in` (+ ใน LIFF) · แสดง `?error=` ที่ `/sign-in` (`page.tsx:14` ยังไม่อ่าน) · หน้า/ส่วน "ผูก LINE กับบัญชี" ใน `/profile` + แบนเนอร์ cutover · ปรับถ้อยคำ LINE ต่อก๊วน (§5) |
| WO-B1.d | @gb-qa | เทสต์ R1–R8 · e2e-browser ใน in-app/มือถือ (S5) |
| WO-B1.e | @gb-docs | `STATE.md` (ประโยคตีความ Q8) · `README.md` ส่วน LINE · `.env.example` |

**DoD ร่างของ spike (ก่อนเปิด WO-B1.a):** S1–S3 และ S5 มีผลจริงบันทึกลง ADR นี้ (แก้สถานะเป็น "ยอมรับ"/"ปรับ") · ไม่มีการแตะ Supabase prod

---

## 13. แหล่งอ้างอิงภายนอก (ตรวจ 27 ต.ค. 2026)

- Supabase — Custom OAuth/OIDC Providers: <https://supabase.com/docs/guides/auth/custom-oauth-providers>
- Supabase — Identity Linking: <https://supabase.com/docs/guides/auth/auth-identity-linking>
- LINE — OpenID Connect discovery: <https://access.line.me/.well-known/openid-configuration>
- LINE — Integrating LINE Login with your web app (scopes, email permission): <https://developers.line.biz/en/docs/line-login/integrate-line-login/>
- LINE — Get profile information from ID tokens: <https://developers.line.biz/en/docs/line-login/verify-id-token/>
