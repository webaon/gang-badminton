# Agent Execution Protocol — Gang Badminton

> เอกสารคู่กับ `gang-badminton-plan-v3.3-FINAL.md` (Architecture Baseline)
> Baseline = **อะไร** ที่ต้องสร้าง / เอกสารนี้ = **วิธีสั่งงาน agent** ให้สร้างถูกต้องครบถ้วน
> เอกสารนี้แก้ได้อิสระ ไม่ต้องผ่าน ADR (เป็น process ไม่ใช่ architecture)

## หลักการ Goal Mode

Agent ทำงานเป็น **Work Order (WO)** ทีละใบ — ไม่รับงานระดับ "ทำ Phase 1" ทั้งก้อน เพราะใหญ่เกิน context window เดียวและไม่มีจุดหยุดชัด ทุก WO ต้องมี 5 ส่วน:

```markdown
## WO-X.X: <ชื่องาน>
**Goal**: <1 ประโยค — เสร็จแล้วโลกเปลี่ยนยังไง>
**Scope**: ทำเฉพาะ... / ไม่แตะ...
**Definition of Done**: <เกณฑ์ตรวจได้จริง — map กับ Verification ใน baseline>
**Forbidden**: <สิ่งที่ห้ามทำแม้จะ "ช่วยให้งานเสร็จ">
**References**: <section ใน baseline ที่เป็น authoritative สำหรับงานนี้>
```

## กติการะหว่างทำงาน (ใส่ใน CLAUDE.md ของ repo)

1. **Baseline คือ source of truth** — ขัดแย้งกันเมื่อไหร่ section `Database Functions` และ `State Machines` เป็น authoritative เหนือส่วนอื่น
2. **เจอสิ่งที่แผนไม่ครอบหรือทำตามตัวอักษรไม่ได้ → หยุด ถาม ห้ามเดา** — เขียน "แผนบอก X / ของจริงคือ Y / ทางเลือกคือ..." แล้วรอคำตอบ (ตามกติกา Deviation ใน baseline)
3. **ห้ามขยาย scope เกิน WO ปัจจุบัน** — เห็นของที่ควรทำเพิ่ม = จดลง `BACKLOG.md` ไม่ทำเลย
4. **ทุก WO จบด้วย verification ของตัวเอง** — test ที่ระบุใน DoD ต้องรันผ่านจริง ไม่ใช่ "เขียนไว้แล้ว"
5. **Commit ต่อ WO** — หนึ่ง WO = อย่างน้อยหนึ่ง commit ที่ build ผ่าน push ไป `claude/badminton-group-system-4pfs7o`

## Work Orders — Phase 1 (แตกจาก Roadmap)

| WO | Goal | DoD หลัก |
|---|---|---|
| **WO-1.1 Scaffold** | โปรเจกต์ Next.js 15 + Tailwind v4 + Astryx (pin) + โครง folder ตาม baseline + CLAUDE.md ครบกติกา | `npm run build` ผ่าน, `npm run astryx` เรียก CLI ได้, folder ตรง baseline |
| **WO-1.2 Schema migrations** | ตารางทั้งหมด + UUIDv7 default + partial unique + composite indexes + soft delete | `supabase start` + migrate ผ่าน, index ครบตามลิสต์ใน baseline |
| **WO-1.3 DB functions + triggers** | ทั้ง 6 ฟังก์ชัน (register/cancel/promote/check_in/transition_session/close_session_with_charges) + GUC trigger + rate_limits | concurrency tests ทั้ง 4 ข้อใน Verification ผ่าน (ผ่าน pooled port) |
| **WO-1.4 RLS + security definer** | is_gang_member/admin/org_member + policies ทุกตาราง + storage buckets | RLS tests ทั้ง 5 ข้อผ่าน |
| **WO-1.5 Cron setup + seed** | Vercel Cron config + pg_cron jobs + seed script ก๊วนตัวอย่าง | seed รันซ้ำได้ (idempotent), cron route ตรวจ CRON_SECRET |

- **Forbidden ร่วมทุก WO ของ Phase 1**: ห้ามเริ่มเขียน UI/feature, ห้ามเพิ่มตารางนอก baseline, ห้ามแก้ state machine
- Phase 2 แตก WO ตอนจบ Phase 1 — อย่าแตกล่วงหน้า เพราะจะเจอ deviation จาก Phase 1 ที่เปลี่ยนรายละเอียด

## ลำดับการสั่งงานต่อ session (สรุป)

1. เปิด session → "อ่าน CLAUDE.md แล้วทำ WO-X.X" (ระบุ WO ชัดในคำสั่ง)
2. Agent ทำงานใน scope WO → เจอทางตัน = หยุดถาม
3. จบงาน → รัน DoD tests → commit + push (สถานะงานอ่านได้จาก git log + WO table)

> หมายเหตุ: Handoff protocol ระหว่าง session (STATE.md) ยังไม่รวมในเวอร์ชันนี้ — จะเพิ่มทีหลังเมื่อเริ่มเจอปัญหา context จริง; ระหว่างนี้ WO ที่ scope เล็กพอจบใน session เดียวคือตัวกันปัญหาหลักอยู่แล้ว

---

# Work Orders — Phase 2 (MVP-0)

> แตกเมื่อ **12 ส.ค. 2026** ตอนจบ Phase 1 ตามที่เอกสารนี้กำหนด ("Phase 2 แตก WO ตอนจบ Phase 1
> — อย่าแตกล่วงหน้า เพราะจะเจอ deviation จาก Phase 1 ที่เปลี่ยนรายละเอียด")
>
> เป้าหมายของ Phase 2 = **MVP-0**: จุดที่ก๊วนของผู้ใช้เองใช้งานจริงได้
> ลำดับตาม baseline §Roadmap — ห้ามสลับลำดับโดยไม่มีเหตุ เพราะแต่ละใบพึ่งใบก่อนหน้า

## 🔴 ข้อจำกัดจาก Phase 1 ที่ทุก WO ต้องยึด

Phase 1 เปลี่ยนกติกาการเข้าถึงข้อมูลไปจากที่ baseline เขียนไว้ตอนแรก — อ่านให้ครบก่อนเริ่มใบไหนก็ตาม

| # | ข้อจำกัด | ผลต่อการออกแบบ |
|---|---|---|
| 1 | **client เรียก DB function ตรงไม่ได้** — ทุกตัว grant ให้ `service_role` เท่านั้น | ทุก flow ต้องผ่าน server action / route handler ที่ตรวจสิทธิ์เองก่อนเรียก |
| 2 | **RLS ไม่ raise error — คืน 0 แถวเงียบๆ** | server action ต้องเช็ค `rowCount` ทุกครั้ง ไม่งั้นตอบ "บันทึกแล้ว" ทั้งที่ไม่มีอะไรเปลี่ยน |
| 3 | **`session_registrations` เขียนตรงไม่ได้เลย** [D-13] | ลงชื่อ/ยกเลิก/เลื่อนคิว/เช็คอิน ต้องผ่าน DB function เท่านั้น |
| 4 | **`sessions` INSERT ได้เฉพาะ `status = 'draft'`** [D-14] | สร้างนัดแล้วต้องเรียก `transition_session()` เพื่อเปิดรับสมัคร |
| 5 | **`transition_payment()` ยังไม่มี** ⇒ payment เปลี่ยน status ไม่ได้เลย | ต้องเขียนก่อนแตะ flow เก็บเงิน (อยู่ใน WO-2.9) |
| 6 | **storage ตรวจสิทธิ์จาก path** [D-15] | ต้องมี helper กลางใน `lib/` ที่ประกอบ path ห้ามให้แต่ละที่ต่อ string เอง |
| 7 | **ตารางใหม่ต้อง `enable RLS` + `revoke` + `grant` + `create policy` ครบ** | default ACL ของ local กับ cloud ไม่เหมือนกัน — ห้ามพึ่ง "ไม่ได้ grant = แตะไม่ได้" |
| 8 | **penalty ยังไม่เป็นตัวเงิน** [D-9] | `cancel_registration()` บันทึกแค่ `is_late_cancel` ลง event — ฝั่ง TS ต้องคิดเงินเองตอนปิดรอบ |

## ลำดับและการพึ่งพา

```
2.1 App foundation
 └─ 2.2 Auth + โปรไฟล์
     └─ 2.3 ก๊วน/องค์กร + สมาชิก + skill + policy + pricing plan
         └─ 2.4 สร้างนัด + snapshot
             ├─ 2.5 ลงชื่อ + guest + waitlist + realtime
             │   └─ 2.7 Game Console ──┐
             ├─ 2.6 Matching Engine ───┘   (pure domain — ทำคู่ขนานกับ 2.5 ได้)
             └─ 2.8 SessionBilling ────┐
                                        ├─ 2.9 Payments (PromptPay + สลิป + verify)
                                        └─ 2.10 In-app notifications
```

**ทำคู่ขนานได้**: 2.6 (pure domain ไม่พึ่ง UI) แยกจาก 2.5 · 2.8 (pure domain) เริ่มได้ทันทีที่ 2.4 จบ

---

## WO-2.1: App foundation

**Goal**: มีโครงพื้นฐานฝั่งแอปที่ทุก WO ต่อไปใช้ร่วมกัน — เรียก Supabase ได้ถูกบทบาท ตรวจสิทธิ์ที่เดียว และ CI จับของที่ผิดกติกาได้เอง

**Scope**
- ทำเฉพาะ: `lib/supabase/` (browser client / server client ที่ผูกกับ session ผู้ใช้ / middleware refresh token ด้วย `@supabase/ssr`) · `domain/permissions/can(role, action)` + feature-flag check · helper ครอบ server action ให้ตอบตาม contract และ**บังคับเช็ค `rowCount`** · `lib/storage/` helper ประกอบ path ตาม [D-15] · eslint rule ห้าม `domain/` import `next`/`react`/`@supabase/*` · GitHub Actions workflow
- ไม่แตะ: หน้าจอใดๆ · ตาราง/migration ใดๆ

**Definition of Done**
- `can()` มี unit test ครบทุก role × action ที่ใช้จริงใน MVP-0 และครอบ feature flag (`features.guests` เป็นอย่างน้อย)
- lint rule ทำงานจริง: จงใจเพิ่ม `import { createClient } from '@supabase/supabase-js'` ใน `domain/` แล้ว `npm run lint` ต้องแดง
- helper server action มี test ที่พิสูจน์ว่า **`rowCount = 0` แปลงเป็น `FORBIDDEN` ไม่ใช่ success** (ข้อจำกัด #2)
- GitHub Actions รันผ่านบน PR จริง: typecheck → lint → vitest (มี Postgres service) → build
- `npm test` เดิม 59 ข้อยังผ่านครบ

**Forbidden**
- ห้ามเขียนหน้าจอหรือ feature ใดๆ · ห้าม hardcode `if (role === 'admin')` นอก `can()` · ห้ามให้ `domain/` แตะ framework

**References**: baseline §สถาปัตยกรรม · §Folder Structure · §Verification "Domain layer test" · CLAUDE.md §3, §4

---

## WO-2.2: Auth + โปรไฟล์

**Goal**: ผู้ใช้สมัคร เข้าสู่ระบบ และมีโปรไฟล์ของตัวเองได้จริง

**Scope**
- ทำเฉพาะ: Supabase Auth (email/password + magic link) · หน้า sign up / sign in / sign out · สร้างแถว `profiles` ให้ผู้ใช้ใหม่ · แก้ชื่อ/เบอร์/avatar ของตัวเอง · middleware กันหน้าที่ต้องล็อกอิน
- ไม่แตะ: ก๊วน/องค์กร (WO-2.3) · avatar upload ไปที่ bucket ยังไม่ต้องทำถ้ายังไม่มี helper พร้อม

**Definition of Done**
- สมัคร → ได้แถว `profiles` อัตโนมัติ (ตัดสินใจว่าใช้ DB trigger บน `auth.users` หรือ server action แล้ว**บันทึกเหตุผล**)
- เข้าหน้าที่ต้องล็อกอินโดยไม่ล็อกอิน → redirect ไม่ใช่ 500
- ผู้ใช้ A แก้โปรไฟล์ผู้ใช้ B ไม่ได้ (มีเทสต์ — policy `profiles_update_self` มีอยู่แล้ว)
- ผู้ใช้ที่ไม่ได้อยู่ก๊วนเดียวกันมองไม่เห็นโปรไฟล์กัน [D-12]

**Forbidden**
- ห้ามใช้ service-role client ในเส้นทางที่ผู้ใช้ทั่วไปเรียก (ต้องใช้ client ที่ผูก session)
- ห้ามเก็บรหัสผ่าน/── token ใน `event_logs` หรือ log

**References**: baseline §โมดูล ข้อ 1 · migration 0010 policy `profiles_*`

---

## WO-2.3: ก๊วน/องค์กร + สมาชิก + skill + policy + pricing plan

**Goal**: แอดมินตั้งก๊วนของตัวเองได้ครบจนพร้อมสร้างนัด

**Scope**
- ทำเฉพาะ: สร้างก๊วน (auto-create org + ใส่ผู้สร้างเป็น owner ทั้งสองชั้น) · จัดการสมาชิก + role · skill levels ต่อก๊วน · cancellation policy · PromptPay ID · เปิด/ปิด public · **pricing plan แค่โมเดลเดียวที่ก๊วนผู้ใช้ใช้จริง**
- ไม่แตะ: pricing โมเดลที่เหลือ (Phase 2.5) · join request/discovery (Phase 3) · LINE (Phase 4)

**Definition of Done**
- สร้างก๊วนแล้วผู้สร้างเป็น owner ของทั้ง `organizations` และ `gang_members` (ทำใน transaction เดียว)
- สมาชิกธรรมดาแก้ตั้งค่าก๊วนไม่ได้ · แอดมินก๊วนอื่นก็ไม่ได้ (มีเทสต์ — ต่อยอดจาก `write-guards.test.ts`)
- **สรุป schema ของ `cancellation_policy` ให้จบ** แล้วเขียนลง baseline/ADR — Phase 1 ใช้แค่ `cutoff_hours` + `allow_cancel_after_cutoff` ส่วนคีย์ penalty ยังไม่ตกลง (ข้อจำกัด #8)
- เลือกโมเดล pricing ที่จะทำ **แล้วบันทึกว่าทำไมเลือกตัวนั้น**

**Forbidden**
- ห้ามทำ pricing เกินหนึ่งโมเดล (baseline สั่งชัด) · ห้ามเพิ่มตารางนอก baseline

**References**: baseline §โมดูล ข้อ 2 · §การตัดสินใจสะสม (นโยบายปัดเศษ, กติกายกเลิก)

---

## WO-2.4: สร้างนัด + snapshot

**Goal**: แอดมินสร้างนัดด้วยมือแล้วเปิดรับสมัครได้

**Scope**
- ทำเฉพาะ: ฟอร์มสร้าง/แก้นัด · **เขียน `snapshot` ให้ครบ** ตอนสร้าง · เปิดรับสมัครผ่าน `transition_session()` · ยกเลิกนัด · แสดงรายการนัดของก๊วนตาม timezone ก๊วน
- ไม่แตะ: `session_templates` + auto-generate (Phase 2.5) · การลงชื่อ (WO-2.5)

**Definition of Done**
- `snapshot` มีครบตาม baseline §Snapshot rule: pricing plan เต็มก้อน + rounding policy + PromptPay ID + ราคาคอร์ท/ลูก + cancellation policy + skill scale + `snapshot_version`
- **เทสต์: เปลี่ยนราคาในก๊วนหลังสร้างนัด แล้วนัดเก่าต้องยังคิดจากราคาเดิม**
- สร้างนัดแล้วได้ `status = 'draft'` เสมอ แล้วเปิดรับสมัครผ่าน `transition_session()` (ข้อจำกัด #4)
- เวลาที่แสดง/รับเข้าถูกต้องตาม `gangs.timezone` — มี unit test ข้าม timezone (baseline §Verification)

**Forbidden**
- ห้าม `UPDATE sessions SET status` ตรง · ห้ามอ่านราคาปัจจุบันจาก `gangs`/`gang_pricing_plans` ตอนคิดเงิน · ห้ามแตก snapshot เป็นคอลัมน์

**References**: baseline §Snapshot rule · §State Machines · CLAUDE.md §2.4

---

## WO-2.5: ลงชื่อ + guest + waitlist + realtime

**Goal**: สมาชิกและ guest ลงชื่อเข้านัดได้ คิวเลื่อนอัตโนมัติ และหน้าจออัปเดตสด

**Scope**
- ทำเฉพาะ: ลงชื่อ/ยกเลิกของตัวเอง · แอดมินลงชื่อแทน (`registered_by`) · สร้างลิงก์เชิญ (`session_invite_tokens`) + หน้าลงชื่อของ guest · **guest access token** สำหรับให้ guest ดู/ยกเลิกเอง · waitlist + cutoff enforcement · realtime opt-in + **degrade เป็น polling ทุก 10 วินาที**
- ไม่แตะ: เช็คอิน/จัดคู่ (WO-2.7) · การคิดเงิน penalty เป็นตัวเลข (WO-2.8)

**Definition of Done**
- ทุก flow เรียกผ่าน server action → DB function เท่านั้น (ข้อจำกัด #1, #3)
- route handler ของ guest มี `check_rate_limit()` จริง (baseline: "ทุก endpoint guest มี rate limit ต่อ IP ต่อ session")
- **`guest_access_token_hash` ถูก generate**: คืน plaintext ครั้งเดียวตอนลงชื่อ เก็บเฉพาะ hash · **ห้าม log plaintext**
- guest ใช้ token ข้าม session ไม่ได้ (มีเทสต์อยู่แล้วใน `tenant-isolation.test.ts` — ต่อยอดฝั่ง HTTP)
- ตัด realtime ออกแล้วหน้าจอยัง sync ได้ด้วย polling (พิสูจน์ว่า fallback ทำงานจริง ไม่ใช่เขียนไว้เฉยๆ)
- E2E: ลงชื่อจนเต็ม → คนถัดไปเข้า waitlist → คนใน confirmed ยกเลิก → คนหัวคิวถูกเลื่อนอัตโนมัติ

**Forbidden**
- 🔴 ห้าม check-then-act ใน TypeScript · ห้าม `INSERT`/`UPDATE` `session_registrations` ตรง
- ห้ามเปิด endpoint สาธารณะให้ guest โดยไม่มี token · ห้าม log plaintext token

**References**: baseline §โมดูล ข้อ 3 · §การตัดสินใจสะสม (Guest/walk-in, Realtime) · CLAUDE.md §2.1, §2.5

---

## WO-2.6: Matching Engine (pure domain)

**Goal**: มี engine จัดคู่ที่ unit test ได้เต็มโดยไม่ต้องมี UI

**Scope**
- ทำเฉพาะ: `domain/matching/` — pipeline `Queue → SelectPlayers → BalanceSkill → AvoidRepeat → CourtAssignment` เป็น pure function ต่อขั้น
- ไม่แตะ: หน้าจอ/ลากสลับ (WO-2.7) · การเก็บผลลง `games` (WO-2.7)

> ⚠️ baseline บรรทัด 65 เขียนว่า `lib/matching/` แต่ §Folder Structure ของเอกสารเดียวกันเขียน
> `domain/matching/` และ repo สร้างโฟลเดอร์หลังไว้แล้ว — **ใช้ `domain/matching/`** เพราะเป็น
> pure logic ที่ต้อง unit test ได้โดยไม่ mock framework (ถ้าตีความนี้ผิด ให้แก้ผ่าน ADR)

**Definition of Done** — unit test ครบ 4 ข้อตาม baseline §Verification
- เล่นน้อย + รอนานได้ลงก่อน
- skill ใกล้กันถูกจับคู่กัน
- ไม่ซ้ำ 4 คนเดิมติดกัน
- คนไม่หาร 4 ลงตัว จัดได้โดยไม่ทิ้งใครค้างถาวร

**Forbidden**
- ห้าม import `next`/`react`/`@supabase/*` เข้า `domain/` · ห้ามอ่าน DB ตรงจากใน engine (รับ input เป็น data ล้วน)
- ห้ามเพิ่ม Constraint stage (baseline §ADR "ไม่รับ" — รอจนมีก๊วนต้องการจริง)

**References**: baseline §สถาปัตยกรรม (Matching Engine) · §Verification

---

## WO-2.7: Game Console

**Goal**: วันเล่นจริงใช้หน้าจอเดียวจบ — เช็คอิน ดูคิว จัดคู่ นับลูก

**Scope**
- ทำเฉพาะ: เช็คอินด้วยปุ่ม · กระดานคิวสด · จัดคู่ผ่าน Matching Engine + **ลากสลับ override ได้เสมอ** · นับลูกต่อเกม · mark no-show
- ไม่แตะ: QR check-in (Phase 2.5) · การคิดเงิน (WO-2.8)

**Definition of Done**
- เช็คอินได้เฉพาะจาก `confirmed` (DB function บังคับอยู่แล้ว — UI ต้องไม่โชว์ทางที่พังแล้วค่อยให้ error)
- `games` บันทึกผู้เล่นเป็น `registration_id` ⇒ guest ลงเกมได้
- `shuttles_used` เป็นทศนิยมได้ (แบ่งลูกกัน)
- แอดมินลากสลับแล้วผลถูกเก็บ ไม่ถูก engine เขียนทับตอน refresh
- realtime/polling ทำงานบนหน้านี้ (ตาม baseline ที่ opt-in เฉพาะหน้านี้กับ waitlist)

**Forbidden**
- ห้ามให้ `waitlist → checked_in` ตรง · ห้ามใส่ business logic การจับคู่ลงในคอมโพเนนต์ (ต้องอยู่ใน `domain/matching/`)

**References**: baseline §โมดูล ข้อ 4 · §State Machines (Registration)

---

## WO-2.8: SessionBilling + rounding + money invariants

**Goal**: ปิดรอบแล้วได้ยอดต่อคนที่ถูกต้องและ reconcile ได้

**Scope**
- ทำเฉพาะ: `domain/billing/SessionBilling` (pure) strategy เดียวตามที่เลือกใน WO-2.3 · rounding policy · คิด penalty จาก `cancelled_at` + snapshot (ข้อจำกัด #8) · server action ที่อ่าน snapshot + registrations + games → คำนวณ → เรียก `close_session_with_charges()`
- ไม่แตะ: strategy อื่น + MembershipBilling (Phase 2.5) · allocations/adjustments (Phase 2.5)

**Definition of Done** — ตาม baseline §Verification
- unit test ครบ edge cases: เช็คอินแต่ไม่ลงเกม · guest · penalty late cancel/no-show · สมาชิกรายเดือนมาเล่น · **ราคาเปลี่ยนหลังสร้างนัด (ต้องใช้ snapshot)** · ยกเลิกกลางคัน `in_play → cancelled` คิดเงินบางส่วน
- 🔴 **money invariant (property-based)**: `sum(session_charges) − ต้นทุนจริง = rounding surplus ตาม policy` ทุกจำนวนคน — บังคับทดสอบที่ **3, 7, 13 คน**
- `rounding_surplus` โผล่ใน `breakdown` ของ charge จริง
- เรียก `close_session_with_charges()` ด้วย `expected_status` ที่ถูกต้อง และจัดการ `INVALID_TRANSITION` ด้วยการคำนวณใหม่ (ไม่ใช่ retry ดิบๆ)

**Forbidden**
- 🔴 ห้ามย้าย billing logic ลง SQL · ห้าม insert `session_charges` ประเภท `session` ที่อื่น
- ห้ามอ่านราคาปัจจุบันจาก `gangs`/`gang_pricing_plans` · ห้ามใช้ float กับเงิน

**References**: baseline **ADR-001** · §Verification (Money invariants) · CLAUDE.md §2.3, §2.4

---

## WO-2.9: Payments — PromptPay + สลิป + verify

**Goal**: เก็บเงินได้ครบวง ตั้งแต่ QR จนแอดมินยืนยัน

**Scope**
- ทำเฉพาะ: **`transition_payment()` + GUC (ข้อจำกัด #5 — ทำก่อนอย่างอื่นในใบนี้)** · PromptPay QR ต่อคน · อัปสลิปเข้า `payment-slips` · แอดมิน verify/reject · dashboard ค้างจ่าย
- ไม่แตะ: `payment_allocations` (จ่ายแทนเพื่อน) + `payment_adjustments`/refund → Phase 2.5

**Definition of Done**
- `transition_payment()` บังคับ state machine `pending → submitted → verified | rejected` และ `rejected → submitted` · เปลี่ยน status ตรงยัง raise `DIRECT_STATUS_UPDATE_FORBIDDEN` (มีเทสต์)
- สลิปอัปเข้า path ตาม [D-15] ผ่าน helper กลาง — **non-member เปิดดูไม่ได้** (ต่อยอดเทสต์ RLS 3)
- QR ที่ออกมาสแกนจ่ายได้จริงกับยอดที่ตรงกับ `session_charges`
- verify แล้วแก้ไม่ได้อีก (`PAYMENT_ALREADY_VERIFIED`) — ต้องใช้ adjustment ซึ่งยังไม่มีใน MVP-0

**Forbidden**
- ห้ามถอด trigger ของ `payments` เพื่อให้ผ่าน · ห้ามเก็บสลิปใน bucket public · ห้ามแก้ยอดที่ verify แล้ว

**References**: baseline §โมดูล ข้อ 5 · §State Machines (Payment) · `docs/errors.md` §Payment/Billing

---

## WO-2.10: In-app notifications + worker

**Goal**: ผู้ใช้รู้ว่าเกิดอะไรขึ้นกับนัดของตัวเอง โดยไม่ต้องพึ่ง LINE

**Scope**
- ทำเฉพาะ: กระดิ่ง in-app (เปิดรอบใหม่, คิวถึง, เตือนจ่าย, ประกาศ) · mark read · **worker ส่งจริงผ่าน Vercel Cron route** ที่ใช้ `claim_notifications()` แล้วส่ง → `sent`/`failed`
- ไม่แตะ: LINE channel (Phase 4)

**Definition of Done**
- worker ส่งจริงแล้วเปลี่ยนสถานะเป็น `sent` · ส่งไม่สำเร็จ → `failed` + `last_error` + backoff ตาม `next_retry_at`
- worker สองตัวรันทับกันไม่ส่งซ้ำ (SKIP LOCKED — มีเทสต์ระดับ DB แล้ว ต่อยอดระดับ route)
- แถวค้าง `processing` ถูก `sweep_stuck_notifications()` คืนคิวได้จริงในสภาพจริง
- ผู้ใช้เห็นเฉพาะ notification ของตัวเอง (policy มีแล้ว — ต้องมีเทสต์ฝั่งแอป)

> ⚠️ **worker ต้องเป็น Vercel Cron ไม่ใช่ pg_cron** — baseline §การแบ่งงาน cron:
> "งานที่เป็น app logic (ส่ง notification, …) ใช้ Vercel Cron → route handler;
> pg_cron ใช้เฉพาะงาน pure SQL" · WO-1.5 จงใจไม่ต่อ `claim_notifications()` เข้ากับ cron
> เพราะ claim แล้วไม่ส่ง = ข้อความหาย

**Forbidden**
- ห้ามส่งข้อความโดยไม่ผ่าน `claim_notifications()` · ห้าม swallow error ตอนส่ง (ต้องลง `last_error`)

**References**: baseline §โมดูล ข้อ 6 · §การตัดสินใจสะสม (Notification worker) · migration 0005, 0012

---

## ✅ MVP-0 checkpoint

จบ WO-2.10 = **ก๊วนของผู้ใช้ใช้งานจริงได้** ก่อนประกาศว่าจบ ต้องผ่าน E2E เส้นเต็มตาม baseline §Verification:

> สมัคร → สร้างก๊วน → ตั้งราคา+policy → สร้างนัด → ลงชื่อจนเต็ม + guest ผ่าน invite link +
> waitlist → ยกเลิกหลัง cutoff เห็น penalty → เช็คอิน → จัดคู่+นับลูก → ปิดรอบ →
> ยอด+QR ถูกต้อง (ตรวจ surplus ในรายงาน) → verify → in-app notification

แล้ว tag `v0.1.0` ตาม baseline §Release Versioning

**ยังไม่อยู่ใน MVP-0** (Phase 2.5): billing strategies ที่เหลือ · MembershipBilling ·
allocations/adjustments/refund · session templates + auto-generate · QR check-in · reminder jobs
