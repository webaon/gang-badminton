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

- [ ] **lint rule ตรวจ `domain/` ไม่ import next/react/supabase** — baseline บังคับ (§Verification "Domain layer test")
      ทำด้วย `eslint no-restricted-imports` หรือ `eslint-plugin-boundaries`
- [ ] **vitest setup** — baseline ระบุ vitest เป็น test runner หลัก; ต้องมีก่อน WO-1.3 (concurrency tests) และ Phase 2 (billing unit tests)
- [ ] **Playwright setup** — E2E (Phase 5 แต่ smoke test อยู่ใน CI gates บน main)
- [ ] **GitHub Actions workflow** — PR gate (typecheck → lint → vitest → build → domain lint rule) / main+nightly (RLS + concurrency + Playwright smoke)
- [ ] **Prettier / formatting config** — ยังไม่มี; ตกลงสไตล์ก่อนโค้ดเยอะ

### Config ที่ค้างไว้

- [ ] **`next.config.ts` ยังว่าง** — ต้องเพิ่ม security headers + CSP (Phase 5 Security Checklist)
- [ ] **`.env.example`** — ยังไม่มี; ต้องมีตอน WO-1.2/1.5 (`SUPABASE_*`, `CRON_SECRET`, key สำหรับ AES fallback)
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

- [ ] **`transition_payment()` ยังไม่มี ⇒ payment เปลี่ยน status ไม่ได้เลย**
      baseline สั่งให้ติด GUC trigger บน `payments` ด้วย "pattern เดียวกัน" (§State Machines v3.2)
      แต่ลิสต์ 6 ฟังก์ชันของ Phase 1 ไม่มีตัวที่ set GUC ให้ payments
      ⇒ ตอนนี้ trigger บล็อกทุกทาง ซึ่ง**ถูกต้องตาม baseline** แต่ทำให้ payment flow
      ใช้ไม่ได้จนกว่าจะเขียนฟังก์ชันใน Phase 2 — **ห้ามแก้ด้วยการถอด trigger**
      🔴 **ยังค้างอยู่หลัง WO-1.4** — เป็นข้อเดียวในกลุ่มนี้ที่ยังไม่ปิด
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

- [ ] **`guest_access_token_hash` ยังไม่ถูก generate** — `register_to_session()` ไม่สร้าง
      guest access token ให้ (ไม่อยู่ใน scope WO-1.3) ⇒ หน้า guest ดู/ยกเลิกเองยังทำไม่ได้
      ตอนทำต้องคืน plaintext ครั้งเดียวตอนสร้าง (เก็บแค่ hash) และ **ห้าม log**
- [ ] **สวิตช์ปิด waitlist ต่อนัด** — `SESSION_FULL` ใน `docs/errors.md` ต้องมีสวิตช์นี้ถึงจะ
      raise ได้จริง ตอนนี้คนมาช้าเข้า waitlist เสมอ ⇒ ถ้าก๊วนอยากปิด ต้องเพิ่มคอลัมน์/flag
- [ ] **penalty เป็นตัวเงิน** — [D-9] `cancel_registration()` บันทึกแค่ `is_late_cancel` ลง event
      ⇒ `domain/billing` (TS) ต้องอ่าน `cancelled_at` + snapshot มาคิดเงินเองตอนปิดรอบ
      **ยังไม่มีใครเขียนฝั่ง TS** — ต้องทำพร้อม SessionBilling
- [ ] **`cancellation_policy` schema ยังไม่นิ่ง** — WO-1.3 ใช้แค่ `cutoff_hours` +
      `allow_cancel_after_cutoff` ส่วนคีย์ penalty (`penalty_type` / `penalty_value`)
      ยังไม่ได้ตกลง ⇒ สรุปให้จบตอนทำ SessionBilling แล้วเขียนลง baseline/ADR
- [ ] **`claim_notifications()` ยังไม่มี logic ส่ง/retry/sweep** — [D-11] ทำแค่ "หยิบงาน"
      ให้ DoD ทดสอบ SKIP LOCKED ได้ ส่วน `next_retry_at` backoff + sweep แถวค้าง
      `processing` เป็นงานของ WO-1.5 (pg_cron) + Phase 2 (worker จริง)
- [ ] **`rate_limits` ยังไม่มีใครเรียก** — ตาราง + `check_rate_limit()` พร้อมแล้ว
      แต่ route handler ของ guest/public ยังไม่มี (Phase 2) และต้องมี cron กวาดแถวเก่า (WO-1.5)

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

- [ ] **ตารางใหม่ทุกตารางต้อง `enable row level security` + `grant` + `create policy` ครบสามอย่าง**
      โปรเจกต์นี้ default ACL ของ schema `public` ให้ anon/authenticated/service_role
      แค่ `Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) **ไม่มี SELECT/INSERT/UPDATE/DELETE**
      ⇒ ต่างจาก template ทั่วไปของ Supabase ที่ grant ทุกอย่างแล้วพึ่ง RLS ล้วน
      ผลคือ deny-by-default (ดี) แต่ **ลืม grant = ตารางใช้ไม่ได้เงียบๆ** เจอตอน runtime
      เป็น error 42501 ไม่ใช่ตอน migrate ⇒ ควรมี CI check ว่าทุกตารางใน public มี policy
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

## จาก baseline ที่ยังไม่มี WO (บันทึกกันลืม)

- [ ] Phase 2 ยังไม่แตก WO — baseline สั่งให้แตกตอนจบ Phase 1 (อย่าแตกล่วงหน้า)
- [ ] `STATE.md` handoff protocol ระหว่าง session — `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง
