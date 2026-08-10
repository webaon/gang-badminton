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

## จาก baseline ที่ยังไม่มี WO (บันทึกกันลืม)

- [ ] Phase 2 ยังไม่แตก WO — baseline สั่งให้แตกตอนจบ Phase 1 (อย่าแตกล่วงหน้า)
- [ ] `STATE.md` handoff protocol ระหว่าง session — `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง
