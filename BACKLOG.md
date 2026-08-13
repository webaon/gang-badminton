# BACKLOG

> ของที่ "ควรทำ" แต่**อยู่นอก scope ของ WO ปัจจุบัน** — ตามกติกาข้อ 3 ใน `AGENT-EXECUTION.md`
> เห็นแล้วจดที่นี่ **ไม่ทำเลย** จนกว่าจะมี WO รองรับ

---

## จาก WO-1.1 (Scaffold)

### 🔴 ความปลอดภัย — ต้องปิดก่อน production

- [ ] **`npm audit`: 3 high severity ใน transitive deps ของ `next@15.5.23`**
  - `postcss <=8.5.22` — XSS ผ่าน unescaped `</style>`, path traversal ผ่าน `sourceMappingURL` (4 CVE)
  - `sharp <0.35.0` — libvips CVE-2026-33327 / 33328 / 35590 / 35591
  - `npm audit fix --force` จะดัน **next@16.3.0** = breaking + ขัด baseline ("Next.js 15") ⇒ **ต้องผ่าน ADR**
  - ⚠️ `sharp` คือตัวที่ `next/image` ใช้ประมวลผลรูป — โปรเจกต์นี้จะมี **avatar + สลิปโอนเงินที่ user อัปโหลด**
    ⇒ ประเมินความเสี่ยงจริงตอน Phase 3 (avatars) และ **บังคับปิดใน Phase 5 Security Checklist**
  - ทางเลือกที่ไม่ต้องขึ้น major: รอ Next 15.5.x patch, หรือ `overrides` ใน package.json บังคับ postcss/sharp เวอร์ชันใหม่

### CI / Tooling (baseline §Verification + §CI Gates — ยังไม่มี WO รองรับ)

- [x] ~~**lint rule ตรวจ `domain/` ไม่ import next/react/supabase**~~ — ✅ WO-2.1
      `@typescript-eslint/no-restricted-imports` + ห้ามพึ่งชั้นนอกด้วย
      พิสูจน์ด้วย `tests/domain/layer-boundary.test.ts` ที่รัน eslint จริง (ถอด rule = เทสต์พัง)
- [x] ~~**vitest setup**~~ — ✅ เสร็จใน WO-1.3 (`npm test`)
- [ ] **Playwright setup** — E2E ผ่านเบราว์เซอร์จริง (Phase 5)
      ⚠️ `tests/e2e/mvp0-full-path.test.ts` เดินเส้นเต็มตาม baseline แล้วผ่าน **DB + domain จริง**
      ซึ่งเป็นชั้นที่ correctness อยู่ แต่ **ไม่ครอบการ render / กดปุ่ม / อัปโหลดไฟล์จริง**
      ⇒ ยังต้องมี Playwright ตามที่ baseline กำหนด ห้ามถือว่าเทสต์นั้นแทนกันได้
- [x] ~~**GitHub Actions workflow (PR gate)**~~ — ✅ WO-2.1 · `.github/workflows/ci.yml`
      typecheck → lint → vitest (Supabase จริง ไม่ใช่ Postgres เปล่า) → build
      ยังไม่มี: job แยกสำหรับ main+nightly และ Playwright smoke (รอ WO ที่มี E2E)
- [ ] **actions ที่ใช้ยัง target Node 20** — GitHub เตือน deprecation (บังคับรันบน Node 24 ให้แล้ว)
      ไม่กระทบตอนนี้ แต่ควรอัป `actions/checkout` / `setup-node` / `supabase/setup-cli` เมื่อมีเวอร์ชันใหม่
- [ ] **Prettier / formatting config** — ยังไม่มี; ตกลงสไตล์ก่อนโค้ดเยอะ

### Config ที่ค้างไว้

- [ ] **`next.config.ts` ยังว่าง** — ต้องเพิ่ม security headers + CSP (Phase 5 Security Checklist)
- [x] ~~**`.env.example`**~~ — ✅ เสร็จใน WO-1.5 (ยังไม่มี key สำหรับ AES fallback — เพิ่มตอน Phase 4 LINE)
- [ ] **`app/page.tsx` เป็น foundation smoke check ไม่ใช่หน้าจริง** — Phase 2 (MVP-0) ต้องแทนที่
- [ ] **`public/` ยังเป็นไฟล์ boilerplate ของ create-next-app** (svg ต่างๆ) — ลบตอนทำ UI จริง
- [ ] **README (ไทย)** — baseline กำหนดไว้ Phase 5: setup Supabase, env vars, Vault, cron, deploy Vercel

### สังเกตจาก Astryx

- [ ] **`@astryxdesign/lab` + `@astryxdesign/charts` ยังเป็น `0.0.0-bootstrap.0`** (placeholder ยังไม่ปล่อยจริง)
      — CLI list ไว้เป็น peer dependency แต่ไม่ได้ติดตั้ง ⇒ ถ้า Phase 3 ต้องทำกราฟรายงาน ต้องเช็คว่า `charts` ปล่อยจริงหรือยัง
      ไม่งั้นต้องหาทางอื่นที่ไม่ขัดกติกา "ห้าม import ไลบรารี UI อื่น"
- [ ] **Astryx 0.3.0 เป็น Beta** — ก่อนอัปเวอร์ชันต้องรัน `npm run astryx -- upgrade` (codemod) และอัปทั้งชุด core/theme/cli พร้อมกัน

---

## จาก WO-1.2 (Schema migrations)

### 🔴 Environment — กระทบ WO-1.3 โดยตรง

- [ ] **`supabase start` (local) ใช้ไม่ได้บนเครื่องนี้** — image `supabase/postgres:17.6.1.158`
      ต้องการพื้นที่ว่างราว 20 GB (มี nix store พ่วง) เครื่องมี 228 GB แต่ใช้ไป ~197 GB
      ⇒ WO-1.2 verify ผ่าน **Supabase cloud** (`db push` + Management API) แทน
- [ ] **WO-1.3 concurrency tests ต้องการ local** — baseline §Verification บังคับให้รันผ่าน
      **pooled port (transaction pooling)** และยิง request พร้อมกัน; ทำบน cloud free tier
      ได้แต่ช้าและกิน quota ⇒ ต้องเคลียร์ดิสก์ก่อนเริ่ม WO-1.3 หรือหาเครื่องอื่น
      (`config.toml` เปิด `[db.pooler]` ไว้ให้แล้ว — local pooler port คือ **54329** ไม่ใช่ 6543
      ที่ baseline อ้าง ซึ่งเป็นพอร์ตของ cloud)
- [ ] **Docker Desktop ล่มระหว่างทำ WO-1.2** (containerd meta.db I/O error ตอนดิสก์เต็ม)
      กระทบ container ของโปรเจกต์อื่น (`qr-marco-postgres`, `qr-marco-redis`) — ต้องเคลียร์ดิสก์ถึงจะ boot กลับ

### Tooling

- [ ] **supabase CLI 2.112.0 `link` พัง** — API ส่ง `inserted_at` รูปแบบที่ schema validator
      ของ CLI ไม่รับ (`LegacyLinkApiKeysNetworkError`) แต่เขียน `linked-project.json` สำเร็จ
      **workaround**: เขียน `supabase/.temp/project-ref` เองแล้ว `db push --linked` ทำงานปกติ
      ⇒ เช็คตอนอัป CLI ครั้งหน้าว่าแก้แล้วหรือยัง แล้วลบ workaround
- [ ] **ไม่มี `psql` ในเครื่อง** — audit ใช้ Supabase Management API
      (`POST /v1/projects/{ref}/database/query`) แทน; ถ้าจะทำ RLS/concurrency tests จริงจัง
      ควรลง `libpq` หรือใช้ client ผ่าน `pg` ใน vitest

### ตัดสินใจไว้ รอทบทวนเมื่อมีข้อมูลจริง

- [ ] **40 index บนคอลัมน์ audit** (`created_by`/`updated_by`/`deleted_by`) เพิ่มใน migration `0007`
      เพื่อทำตาม baseline "ทุก FK มี index" ตามตัวอักษร — index เหล่านี้แทบไม่มี query ใช้จริง
      ⇒ ถ้าวัดแล้วพบว่ากระทบ write throughput ให้ลบออก (migration เดียว) ไม่ต้องผ่าน ADR
      เพราะไม่ใช่การเปลี่ยนสถาปัตยกรรม

---

## จาก WO-1.3 (DB functions + triggers)

### ช่องโหว่ที่เปิดค้างไว้ — ✅ ปิดแล้วใน WO-1.4 (ยกเว้นข้อ transition_payment)

- [x] ~~**`transition_payment()` ยังไม่มี**~~ — ✅ WO-2.9
      baseline สั่งให้ติด GUC trigger บน `payments` ด้วย "pattern เดียวกัน" (§State Machines v3.2)
      แต่ลิสต์ 6 ฟังก์ชันของ Phase 1 ไม่มีตัวที่ set GUC ให้ payments
      ✅ **ปิดแล้วใน WO-2.9** (migration 0022) — เขียน `transition_payment()` ตามที่
      baseline สั่ง ไม่ได้ถอด trigger ออก
- [x] ~~**GUC guard คุมเฉพาะ UPDATE ไม่คุม INSERT**~~ — ✅ ปิดแล้ว [D-14]
      policy `sessions_insert_admin_draft_only` บังคับ `status = 'draft'` ตอน INSERT
      (fixture ของเทสต์ยังใช้ช่องนี้ได้เพราะรันเป็น `postgres` ซึ่ง bypass RLS — ตั้งใจ)
- [x] ~~**EXECUTE grant ของ DB functions ยังเป็น default**~~ — ✅ ปิดแล้วใน 0010 ส่วนที่ 5
      revoke จาก public/anon/authenticated ครบทุกตัว เหลือ grant ให้ `service_role` เท่านั้น
      ⇒ **ทุก DB function ต้องเรียกผ่าน server action ห้ามเรียกจาก browser**
- [x] ~~**`waitlist → confirmed` ยังบังคับได้แค่ตามกติกา**~~ — ✅ ปิดแล้ว [D-13]
      `session_registrations` มี policy เฉพาะ SELECT และ grant เฉพาะ `select`
      ⇒ ไม่มีใครนอกจาก definer functions เขียนได้ แม้แต่แอดมินก๊วน

### Phase 2 — ของที่ WO-1.3 จงใจไม่ทำ

- [x] ~~**`guest_access_token_hash` ยังไม่ถูก generate**~~ — ✅ WO-2.5 (`register_guest()`)
- [ ] **สวิตช์ปิด waitlist ต่อนัด** — `SESSION_FULL` ใน `docs/errors.md` ต้องมีสวิตช์นี้ถึงจะ
      raise ได้จริง ตอนนี้คนมาช้าเข้า waitlist เสมอ ⇒ ถ้าก๊วนอยากปิด ต้องเพิ่มคอลัมน์/flag
- [x] ~~**penalty เป็นตัวเงิน**~~ — ✅ WO-2.8 (`SessionBilling` อ่าน `cancelled_at` + snapshot)
- [ ] **`cancellation_policy` schema ยังไม่นิ่ง** — WO-1.3 ใช้แค่ `cutoff_hours` +
      `allow_cancel_after_cutoff` ส่วนคีย์ penalty (`penalty_type` / `penalty_value`)
      ยังไม่ได้ตกลง ⇒ สรุปให้จบตอนทำ SessionBilling แล้วเขียนลง baseline/ADR
- [x] ~~**`claim_notifications()` ยังไม่มีตัวส่งจริง**~~ — ✅ WO-2.10 (`/api/cron/notification-dispatch`)
- [ ] **`rate_limits` ยังไม่มีใครเรียก** — ตาราง + `check_rate_limit()` + cron กวาด ✅ พร้อมแล้ว
      แต่ route handler ของ guest/public ที่ต้องเรียกยังไม่มี (Phase 2)

### Environment / tooling

- [ ] **`supabase start` เต็มชุดไม่ขึ้น — analytics stack (logflare + vector) กับ studio เท่านั้น**
      ต้องรันแบบตัดบริการ: `npm run supabase -- start -x studio,logflare,vector,edge-runtime,mailpit`
      ได้ `db`/`pooler`/`kong`/`rest`/`auth`/`storage`/`realtime`/`pg_meta` ครบ healthy
      ⇒ ไม่กระทบ WO-1.4 (storage ใช้ได้) แต่ยังไม่มี Studio UI กับ log drain ให้ดู
      **ไม่ใช่ปัญหา RAM** — วัดแล้วใช้ ~1.2 GB จาก 3.8 GB (เคยสรุปผิดไว้ตอนแรก)
      ยังไม่ได้หาสาเหตุจริงของ logflare/vector — ถ้าอยากได้ Studio ต้องไล่ต่อ
- [ ] **vitest ยังไม่ได้ต่อเข้า CI** — มี `npm test` แล้วแต่ GitHub Actions workflow ยังไม่มี
      (อยู่ในลิสต์ CI/Tooling ด้านบน) เทสต์ชุดนี้ต้องมี Postgres จริงใน CI ถึงจะรันได้

---

## จาก WO-1.4 (RLS + storage)

### 🔴 กับดักที่ต้องรู้ก่อนเพิ่มตารางใหม่

- [ ] **ตารางใหม่ทุกตารางต้อง `enable RLS` + `revoke` + `grant` + `create policy`**
      🔴 **default ACL ของ local กับ cloud ไม่เหมือนกัน** — local ให้ anon/authenticated แค่
      `Dxtm` แต่ cloud ให้ `arwdDxtm` ⇒ ตอน push 0010 ขึ้น cloud พบว่า `anon` มี SELECT
      บนตาราง server-only (ข้อมูลไม่รั่วเพราะ RLS กันอยู่ แต่เหลือกำแพงชั้นเดียว
      และพฤติกรรมต่างกันสองที่ = เทสต์บนเครื่องพิสูจน์อะไรเกี่ยวกับ production ไม่ได้)
      migration `0013` แก้ด้วยการ revoke ทั้งหมดแล้ว grant กลับตามรายการที่ประกาศ
      ⇒ **ห้ามพึ่ง "ไม่ได้ grant = แตะไม่ได้" อีก ต้อง revoke ให้ชัดเสมอ**
      `tests/rls/grant-matrix.test.ts` คุมไว้แล้ว — ตารางใหม่ที่ไม่ประกาศสิทธิ์จะทำให้เทสต์แดง
- [ ] **`storage.objects` ตรวจสิทธิ์จาก path เท่านั้น** [D-15] — ไม่มีคอลัมน์ `gang_id`
      ข้อตกลง: `payment-slips/<gang_id>/<payment_id>/<file>` · `avatars/<user_id>/<file>` ·
      `gang-assets/<gang_id>/<file>` · `announcement-images/<gang_id>/<file>`
      ⇒ **server action ต้องประกอบ path เอง ห้ามรับ path จาก client** ไม่งั้นสิทธิ์ผิดทันที
      ยังไม่มีโค้ดฝั่ง TS ที่บังคับข้อนี้ (Phase 2) — ควรทำเป็น helper ตัวเดียวใน `lib/`
- [ ] **`avatars` / `gang-assets` เป็น bucket public** — ใครมี URL เปิดดูได้โดยไม่ผ่าน RLS
      ⇒ ห้ามเอาของที่เป็นความลับไปวาง (สลิปต้องอยู่ `payment-slips` เท่านั้น)

### ตัดสินใจไว้ รอทบทวน

- [ ] **[D-12] `profiles` อ่านได้เฉพาะตัวเอง + คนในก๊วนเดียวกัน** — baseline ไม่ได้ระบุ
      ถ้า Phase 3 (discovery/หาคนเล่น) ต้องโชว์โปรไฟล์คนนอกก๊วน ต้องกลับมาทบทวนข้อนี้
- [ ] **`gang_line_configs` ปิดแม้แต่แอดมินก๊วน** — baseline เขียน "server-only" ตรงตัว
      ⇒ หน้าตั้งค่า LINE (Phase 4) ต้องอ่าน/เขียนผ่าน server action เท่านั้น ห้ามให้ client query ตรง
- [ ] **`event_logs` ที่ `gang_id` เป็น null ไม่มีใครอ่านได้** — policy บังคับ `gang_id is not null`
      event ระดับแพลตฟอร์ม (ถ้ามี) จะมองไม่เห็นจาก client ⇒ ตั้งใจ แต่ถ้า Phase 3 ต้องการ
      หน้า audit ระดับ platform ต้องเพิ่ม policy สำหรับ admin ของแพลตฟอร์ม (ซึ่งยังไม่มีแนวคิดนี้)

---

## จาก WO-1.5 (Cron + seed)

### 🔴 ต้องทำต่อทันที

- [ ] **แตก WO ของ Phase 2** — baseline สั่งให้แตกตอนจบ Phase 1 ซึ่ง**ถึงแล้ว**
      (อย่าแตกก่อนหน้านี้เพราะจะเจอ deviation จาก Phase 1 ที่เปลี่ยนรายละเอียด — ตอนนี้รู้ครบแล้ว)
      deviation ที่ต้องเอาเข้าไปคิดด้วย: D-7 ถึง D-16 โดยเฉพาะ
      **D-13/EXECUTE grant** ที่ทำให้ client เรียก DB function ตรงไม่ได้อีกแล้ว
- [x] ~~**push migration ขึ้น cloud**~~ — ✅ เสร็จ 12 ส.ค. 2026 (13/13 · ไม่ได้ push seed)

### Phase 2

- [ ] **worker ส่ง notification จริง** — ดูหัวข้อ WO-1.3 ด้านบน
- [x] ~~**`lib/` helper ประกอบ path ของ storage**~~ — ✅ WO-2.1 · `lib/storage/paths.ts`
      sanitize ชื่อไฟล์ + บังคับ id เป็น UUID · **ยังต้องบังคับใช้จริงตอนทำ upload ใน WO-2.9**
- [ ] **seed มี guard กัน production หรือยัง** — ตอนนี้ยังไม่มี ถ้าเผลอชี้ `db reset` ไป cloud
      จะยัดข้อมูลปลอมลงฐานจริง ⇒ ควรเช็ค env/ชื่อ database ก่อนรัน
- [ ] **`server-only` ถูก stub ตอนรันเทสต์** — `tests/helpers/server-only-stub.ts` + alias ใน
      `vitest.config.ts` (ไม่ลดการป้องกันของ build จริง แต่ต้องรู้ว่ามีอยู่)

### บันทึกการตัดสินใจ

- [ ] **pg_cron กับ Vercel Cron ตั้งเวลาซ้อนกันโดยตั้งใจ** — [D-16] pg_cron เป็นตัวหลัก
      (ไม่พึ่งแอป) Vercel Cron เป็นเส้นสำรองที่พกพาได้ ตั้งเวลาเหลื่อมกันไว้
      ปลอดภัยเพราะทั้งสามงาน idempotent — ถ้าวันหนึ่งเพิ่มงานที่ **ไม่** idempotent
      ต้องเลือกอย่างใดอย่างหนึ่ง ห้ามตั้งทั้งคู่
- [ ] **pg_cron ใช้เวลา UTC ล้วน** — ไม่สนใจ `gangs.timezone` งานกวาดปัจจุบันไม่ผูกกับ
      เวลาท้องถิ่นจึงไม่มีปัญหา แต่ job ที่ต้องรันตามเวลาไทย (เช่นสรุปยอดสิ้นวัน) ต้องแปลงเอง
- [ ] **rollup `member_statistics` / `daily_metrics` ยังไม่ได้ตั้ง cron** — เป็น logic ของ
      Phase 3 ไม่ใช่ infrastructure ⇒ ตั้ง job ตอนเขียน rollup จริง

---

## จาก WO-2.2 (Auth + โปรไฟล์)

- [ ] **Astryx `TextInput` ไม่มี prop `autoComplete`** และไม่มีช่องส่ง HTML attribute ดิบ
      ⇒ ฟอร์ม auth ใช้ `htmlName` ให้เบราว์เซอร์เดาแทน ซึ่งอ่อนกว่า `autocomplete` จริง
      (password manager บางตัวไม่เติมรหัสให้อัตโนมัติ / ไม่เสนอบันทึกรหัสใหม่)
      ทางเลือก: `npm run astryx -- swizzle TextInput` แล้วเพิ่ม prop เอง — แต่จะกลายเป็น
      component ที่เราดูแลเองและหลุดจาก upgrade path ⇒ **ยังไม่ทำ** รอดูว่า Astryx
      เวอร์ชันหน้าเพิ่มให้ไหม (ตอนนี้ pin 0.3.0 ซึ่งเป็น Beta)
- [ ] **ยังไม่ได้ทำ avatar upload** — WO-2.2 ระบุว่าทำได้ถ้า helper พร้อม ซึ่งพร้อมแล้ว
      (`lib/storage/paths.ts` มี `avatarPath()`) แต่กันขอบเขตไว้ให้ WO ที่ทำ storage จริง
- [ ] **ยังไม่มี mapping `ErrorCode` → ข้อความไทยรวมศูนย์** — ตอนนี้หน้าจอโชว์ `message`
      ที่ server ส่งมาตรงๆ CLAUDE.md §4 บอกว่า frontend ต้องแปลจาก code
      ⇒ ทำตอนที่มีหน้าจอมากพอจะเห็นรูปแบบซ้ำ (Phase 2 กลางๆ)
- [ ] **ทุกหน้าที่อ่าน session ต้องมี `export const dynamic = 'force-dynamic'`**
      เจอตอน build: `/profile` ถูกพยายาม prerender แล้วพัง ถ้าบังเอิญ build ผ่าน
      จะแย่กว่านั้นมาก (หน้าโปรไฟล์ของคนหนึ่งถูก cache เสิร์ฟให้ทุกคน)
      ⇒ ควรหาวิธีบังคับด้วย lint/CI แทนที่จะพึ่งความจำ

---

## จาก WO-2.3 (ก๊วน/สมาชิก/pricing)

- [ ] **เชิญคนที่ยังไม่มีบัญชีเข้าก๊วนไม่ได้** [D-18] — `add_gang_member_by_email()` หาได้เฉพาะ
      คนที่สมัครแล้ว เพราะ `gang_members.user_id` เป็น NOT NULL
      ⇒ ตอนนี้ต้องบอกให้เขาสมัครเองก่อน แล้วแอดมินค่อยเพิ่ม
      ลิงก์เชิญเข้าก๊วน (แบบเดียวกับ `session_invite_tokens`) เป็นงาน Phase 3 พร้อม discovery
- [ ] **`penalty_type` แบบ `fixed` / `percent` ยังไม่ implement** (ADR-002)
      UI เตือนไว้แล้วว่าเลือกได้แต่ระบบยังคิดให้ไม่ได้ ⇒ `domain/billing` (WO-2.8)
      ต้อง raise ถ้าเจอ **ห้ามคิดเป็น 0 เงียบๆ** (`isImplemented()` มีให้เรียกแล้ว)
- [ ] **pricing โมเดล `court_plus_shuttle` / `monthly` ยังไม่ implement** (ADR-002)
      `upsertPricingPlan()` ปฏิเสธไว้ตั้งแต่ต้นทาง — เปิดใน Phase 2.5
      ⚠️ Game Console (WO-2.7) ยังต้องทำหน้านับลูกตาม baseline แต่ตัวเลขยังไม่เข้าสูตร
      คิดเงินใน MVP-0 จนกว่าจะเปิด `court_plus_shuttle`
- [x] ~~**ยังไม่มีหน้าจัดการ skill levels / pricing plan**~~ — ✅ WO-2.4 (`PricingAndSkills`)
- [ ] **เปลี่ยน role ตัวเองเป็น member ได้ถ้ามี owner คนอื่นอยู่** — ตั้งใจ (ก๊วนอาจมีหลาย owner)
      แต่ UI ยังไม่เตือนว่ากำลังลดสิทธิ์ตัวเอง ⇒ กดพลาดแล้วต้องให้ owner อีกคนกู้ให้

---

## จาก WO-2.4 (สร้างนัด + snapshot)

- [ ] **Astryx ไม่มี date-time input** — `CreateSessionForm` ใช้ `<input type="datetime-local">`
      ดิบห่อด้วย label เอง ตาม fallback rule §1 (Tailwind เสริมเมื่อ Astryx ไม่มี prop)
      ⇒ หน้าตาไม่เข้าชุดกับ TextInput ตัวอื่น และไม่มี validation UI ของ Astryx
      ทางเลือก: เขียน custom ใน `components/ui/` ที่ใช้ Astryx token · หรือรอ Astryx เพิ่ม
- [ ] **แก้นัดแล้ว snapshot ไม่เปลี่ยนตาม (ตั้งใจ)** — `updateSession()` ไม่แตะ snapshot
      ⇒ ถ้าแอดมินแก้ราคาแล้วอยากให้นัดที่สร้างไว้ใช้ราคาใหม่ **ต้องลบแล้วสร้างใหม่**
      ยังไม่มี UI อธิบายเรื่องนี้ให้แอดมินเข้าใจ
- [ ] **ยังไม่มีหน้า "นัดของฉัน" ฝั่งสมาชิก** — ตอนนี้ดูนัดได้จากหน้าก๊วนเท่านั้น
      สมาชิกที่อยู่หลายก๊วนต้องไล่เปิดทีละก๊วน (Phase 2 ปลายๆ)
- [x] ~~**`in_play → cancelled` ยังไม่ผ่าน close_session_with_charges**~~ — ✅ WO-2.8

---

## จาก WO-2.5 (ลงชื่อ + guest + waitlist + realtime)

### 🔴 ข้อจำกัดด้านความปลอดภัยที่ยอมรับไว้ใน MVP-0

- [ ] **guest token อยู่ใน query string** (`/guest/<id>?t=<token>`)
      ⇒ อาจติดไปกับ `Referer` ที่ส่งไปเว็บอื่น และไปโผล่ใน log ของ proxy/CDN
      ยอมรับใน MVP-0 เพราะ guest ไม่มีบัญชีให้ผูก session
      **ทางแก้**: แลก token เป็น cookie (httpOnly) ครั้งแรกที่เปิดหน้า แล้ว redirect
      ทิ้ง query string — ทำได้โดยไม่แตะ schema
- [ ] **ยังไม่มีวิธีขอลิงก์ guest ใหม่ถ้าทำหาย** — token แสดงครั้งเดียว ระบบเก็บแค่ hash
      ถ้า guest ปิดหน้าไปโดยไม่เก็บลิงก์ ต้องให้แอดมินยกเลิกให้แทน
      ⇒ ควรมีปุ่ม "ออกลิงก์ใหม่" ฝั่งแอดมิน (เขียน hash ใหม่ทับของเดิม)

### UI ที่ยังไม่ได้ทำ (server action พร้อมแล้ว)

- [ ] **แอดมินลงชื่อแทนสมาชิก** — `registerMember()` เขียนแล้วแต่ยังไม่มีปุ่มในหน้านัด
- [ ] **แอดมินยกเลิกแทนสมาชิก** — `cancelRegistration()` รองรับแล้ว (ตรวจ
      `registration.cancel.other`) แต่หน้ารายชื่อยังไม่มีปุ่ม
- [ ] **ยังไม่เตือนก่อนยกเลิกหลัง cutoff** — DB คิด penalty ให้ถูกต้องแล้ว
      (`is_late_cancel` ใน event) แต่ผู้ใช้กดยกเลิกโดยไม่รู้ว่าจะโดนคิดเงิน
      ⇒ ต้องอ่าน `cutoff_hours` จาก snapshot มาเตือนก่อนกด

### realtime

- [ ] **realtime เปิดเฉพาะ `session_registrations`** (migration 0018)
      ถ้า Phase ถัดไปอยากให้ `games` sync สดด้วย ต้องเพิ่มเข้า publication เอง
      ⚠️ ทุกตารางใน publication กิน quota ของ free tier — เพิ่มเท่าที่จำเป็น
- [ ] **ยังไม่ได้ทดสอบ fallback ในเบราว์เซอร์จริง** — ตรรกะมี unit test คุมครบ
      (`lib/sync/fallback.ts`) แต่การต่อ/หลุดจริงยังไม่ได้ลองปิด realtime แล้วดูหน้าจอ
      ⇒ ทำตอน E2E (Playwright) ใน Phase 5

---

## จาก WO-2.6 (Matching Engine)

- [ ] **`avoidRepeat` ใช้วิธีสลับแบบ greedy** — ลองสลับทีละคู่จนกว่าจะแก้การซ้ำได้
      พอสำหรับคอร์ท 2-4 คอร์ทที่ก๊วนจริงใช้ แต่ไม่ได้ค้นหาแผนที่ดีที่สุดทั่วโลก
      ⇒ ถ้าวันหนึ่งมีก๊วนคอร์ทเยอะมากแล้วผลจับคู่ดูแปลก ให้กลับมาดูตรงนี้
      (อย่าเพิ่งแก้จนกว่าจะเจอปัญหาจริง — baseline §ADR "ไม่รับ" เตือนเรื่อง over-engineer)
- [ ] **ยังไม่มี Constraint stage** (คู่ห้ามเจอกัน / tag) — baseline §ADR "ไม่รับ" ระบุว่า
      ต้นทุนจริงคือ data model ของ constraint ไม่ใช่ engine ⇒ รอจนมีก๊วนต้องการจริง
      pipeline เสียบ stage เพิ่มได้อยู่แล้วโดยไม่ต้องรื้อของเดิม
- [x] ~~**`waitingSince` ยังไม่มีใครคำนวณให้**~~ — ✅ WO-2.7 (`session_console_queue()`)
- [x] ~~**ผลจัดคู่ยังไม่ถูกบันทึกลง `games`**~~ — ✅ WO-2.7 (`generateGames()` เขียนตามลำดับ engine เป๊ะ)
- [ ] **`games` ยังไม่มีคอลัมน์ทีม/ผลแพ้ชนะ** — ความหมายทีมอยู่ที่ลำดับคอลัมน์ (ADR-003)
      ถ้าอนาคตต้องเก็บสกอร์รายทีม ค่อยเพิ่มคอลัมน์แบบ expand → migrate → contract

---

## จาก WO-2.7 (Game Console)

- [ ] **[D-19] "ลากสลับ" ทำเป็นแตะเลือกแล้วแตะสลับ ไม่ใช่ drag & drop**
      baseline เขียนว่า "ลากสลับ" แต่แอปเป็น mobile-first และหน้านี้ใช้ตอนยืนอยู่
      ข้างคอร์ทจริง — drag & drop บนมือถือพลาดง่ายและ accessible ยาก
      ผลลัพธ์เท่ากันคือแอดมิน override ได้เสมอ ⇒ ถ้าอยากได้ drag จริงค่อยเพิ่มทีหลัง
- [x] ~~**ยังไม่มีปุ่มแก้จำนวนลูกย้อนหลัง**~~ — ✅ **WO-2.5-A** `update_game_shuttles()`
      แก้ได้เฉพาะตอนนัดยังไม่ปิดรอบ · หลัง `billing` raise `INVALID_TRANSITION` ·
      บันทึกค่าเดิม/ค่าใหม่ลง `event_logs`
- [x] ~~**`markNoShow` เขียน `session_registrations` ตรงผ่าน admin client**~~ — ✅ **WO-2.5-A**
      เป็น `mark_no_show()` แล้ว มี event log + state guard ระดับ DB
- [ ] **คอนโซลยังใช้ได้ทุกสถานะของนัด** — ไม่ได้บังคับว่าต้อง `in_play`
      ตั้งใจให้ยืดหยุ่นตอนทดสอบ แต่ควรพิจารณาจำกัดเมื่อ flow นิ่งแล้ว

---

## จาก WO-2.8 (SessionBilling)

### 🔴 ผลข้างเคียงของ ADR-002 ที่ต้องรู้

- [x] ~~**`flat_rate` ไม่มีการหาร ⇒ นโยบายปัดเศษยังไม่ถูกใช้จริงใน MVP-0**~~ — ✅ **WO-2.5-B**
      `court_plus_shuttle` ใช้ `splitEvenly()` จริงแล้ว · เทสต์ที่ 3/7/13 คน × 3 โหมด
      assert ว่า **surplus ≠ 0** ⇒ invariant มีเคสจริงพิสูจน์แล้ว (ADR-005)
- [x] ~~**สัดส่วนเก็บเงินตอนยกเลิกกลางคันไม่มีที่เก็บใน policy**~~ — ✅ **ADR-004**
      เพิ่ม `midway_cancel_ratio` เข้า schema · ก๊วนตั้งค่าตั้งต้นเองได้ในหน้าตั้งค่า ·
      แอดมินแก้ได้อีกทีตอนกดยกเลิกจริง · ค่าที่ใช้จริงบันทึกลง `breakdown`
- [ ] **`isMonthlyMember` อ่านตอนปิดรอบ ไม่ได้อยู่ใน snapshot**
      เป็นคุณสมบัติของคน ไม่ใช่ของราคา (คนสมัครรายเดือนกลางเดือนได้)
      ⇒ ถ้าเปลี่ยนสถานะรายเดือนหลังเล่นแต่ก่อนปิดรอบ ยอดจะเปลี่ยนตาม — ตั้งใจ
      แต่ต้องระวังเมื่อทำ MembershipBilling ใน Phase 2.5

### ยังไม่ได้ทำ

- [x] ~~**`confirmed` ที่ไม่เคยเช็คอินถูกคิดเหมือน no-show**~~ — ✅ **WO-2.5-A**
      ปุ่ม "เช็คอินทุกคน" (`check_in_all()`) + ด่าน `CONFIRMATION_REQUIRED` ตอนปิดรอบ
      ทั้งที่ไม่มีใครเช็คอินเลย (⚠️ พฤติกรรมการ**คิดเงิน**ยังเหมือนเดิม — เปลี่ยนแค่ว่า
      ต้องมีคนยืนยันก่อน ไม่ใช่เกิดขึ้นเงียบๆ)
- [x] ~~**ยังไม่มีหน้าสรุปยอดก่อนกดปิดรอบ**~~ — ✅ **WO-2.5-A**
      `/gangs/[gangId]/sessions/[sessionId]/close` + `previewSessionCharges()`
      (ใช้ `calculateSessionCharges()` ตัวเดียวกับตอนปิดจริง ⇒ ตัวเลขไม่มีทางเบี่ยง)

---

## จาก WO-2.9 (Payments)

- [ ] **payment ยังไม่ผูกกับ charge เป็นรายรายการ** — `create_payment_for_charges()`
      รวมยอดเป็นก้อนเดียว ยังไม่เขียน `payment_allocations`
      ⇒ จ่ายแทนเพื่อน (1 สลิป 2 คน) ยังทำไม่ได้ — เป็นงาน Phase 2.5 ตาม baseline
      ⚠️ แปลว่าตอนนี้ยัง reconcile ระดับ charge ไม่ได้ รู้แค่ว่า "คนนี้จ่ายมาเท่าไร"
- [ ] **ออกใบจ่ายซ้ำได้** — กด "ขอ QR" หลายครั้งจะได้ payment หลายใบ
      หน้าจอแสดงใบล่าสุดใบเดียว แต่ใบเก่ายังค้างเป็น `pending` ในหน้าแอดมิน
      ⇒ ควรใช้ใบเดิมถ้ายังไม่ verified หรือยกเลิกใบเก่าอัตโนมัติ
- [ ] **ยังไม่มี `payment_adjustments` (refund/correction)** — verify แล้วแก้ไม่ได้เลย
      ตามที่ ADR ตั้งใจ แต่แปลว่าถ้าแอดมินกดยืนยันผิดคนต้องแก้ผ่าน DB
      ⇒ Phase 2.5 ตาม baseline
- [ ] **ไม่ได้ตรวจว่ายอดในสลิปตรงกับยอดที่เรียกเก็บ** — แอดมินดูเอง
      (OCR สลิป/เชื่อม API ธนาคารไม่อยู่ใน baseline)

---

## จาก WO-2.10 (Notifications)

- [ ] **`in_app` ไม่มีปลายทางภายนอกให้ยิง** — แถวใน `notifications` คือตัวข้อความเอง
      worker จึงแค่บันทึกว่าถึงมือแล้ว ที่ยังให้เดินผ่านคิวเพราะ Phase 4 จะมี `line`
      ที่ต้องยิง API จริง ⇒ ให้ทั้งสอง channel เดินเส้นทางเดียวกันตั้งแต่แรก
      **ผลข้างเคียง**: กระดิ่งแสดงตั้งแต่ตอนเข้าคิว (ไม่รอ worker) — ตั้งใจ
- [ ] **ยังไม่มี notification ของ "ประกาศ"** — baseline §โมดูล ข้อ 6 ระบุไว้
      แต่หน้าประกาศเป็นงาน Phase 3 ⇒ เข้าคิวตอนโพสต์ประกาศได้เมื่อทำหน้านั้น
- [ ] **แจ้งเตือนเข้าคิวจาก server action ไม่ใช่จาก DB function**
      เพราะ `transition_session()` / `close_session_with_charges()` apply บน cloud แล้ว
      การ `CREATE OR REPLACE` ต้องคัดลอก body ทั้งก้อน เสี่ยงพิมพ์ตกในฟังก์ชันที่คุมเงิน
      ⇒ **เรียก `transition_session()` ตรงจาก SQL (เช่น seed) จะไม่มีแจ้งเตือน** — ยอมรับได้
      แต่ถ้าวันหนึ่งมี flow อื่นที่เปลี่ยนสถานะโดยไม่ผ่าน server action ต้องเติมเอง
- [ ] **ไม่มี realtime บนกระดิ่ง** — ต้อง refresh หน้าถึงจะเห็นของใหม่
      (`notifications` ไม่ได้อยู่ใน publication — เปิดเพิ่มได้ แต่กิน quota free tier)

---

## จาก baseline ที่ยังไม่มี WO (บันทึกกันลืม)

- [ ] Phase 2 ยังไม่แตก WO — baseline สั่งให้แตกตอนจบ Phase 1 (อย่าแตกล่วงหน้า)
- [ ] `STATE.md` handoff protocol ระหว่าง session — `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง
