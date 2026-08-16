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

---

# Work Orders — Phase 2.5 (Core ครบ)

> แตกเมื่อ **13 ส.ค. 2026** ตอนจบ MVP-0 (`v0.1.0`) ตามกติกาเดิม — ไม่แตกล่วงหน้า
>
> baseline §Roadmap: "billing strategies ที่เหลือ + MembershipBilling (monthly) →
> `payment_allocations` (จ่ายแทนเพื่อน) + adjustments/refund → session templates +
> auto-generate → QR check-in → reminder jobs" · จบ Phase นี้ = tag **`v0.2.0`**

## เรื่องชื่อ WO

Phase นี้ชื่อ "2.5" และ Phase 2 มีใบชื่อ WO-2.5 อยู่แล้ว (ลงชื่อ+guest+waitlist)
⇒ ใบของ Phase 2.5 ใช้ **ตัวอักษร**: `WO-2.5-A` … `WO-2.5-G` เพื่อไม่ให้สับสน

## 🔴 สิ่งที่ Phase 2 ทิ้งไว้และกลายเป็น "ต้องทำก่อน" ของ Phase นี้

| # | เรื่อง | ทำไมถึงเป็น blocker |
|---|---|---|
| 1 | **แก้จำนวนลูกย้อนหลังไม่ได้** | `court_plus_shuttle` คิดเงินจากจำนวนลูก ⇒ กรอกผิดแล้วแก้ไม่ได้ = คิดเงินผิดถาวร |
| 2 | **`confirmed` ที่ไม่เคยเช็คอินถูกคิดเหมือน no-show** | แอดมินลืมเปิดคอนโซลทั้งวัน = ทุกคนโดนเก็บเงิน |
| 3 | **ไม่มีหน้าสรุปยอดก่อนปิดรอบ** | กดแล้วย้อนไม่ได้ (`CHARGES_ALREADY_COMMITTED`) — ยิ่งอันตรายเมื่อสูตรซับซ้อนขึ้น |
| 4 | **`markNoShow` ไม่มี DB function** | ไม่มี event log และไม่มี state guard ระดับ DB — จะคิด penalty จาก no-show ต้องเชื่อถือได้ก่อน |
| 5 | **`rounding.ts` ยังไม่ถูกใช้จริง** | `flat_rate` ไม่มีการหาร ⇒ invariant ที่ baseline เรียกว่า blocker ยังไม่มีเคสจริง |
| 6 | **guest token อยู่ใน query string** | ติดไปกับ `Referer` และ log ของ proxy — ยิ่งมี QR check-in ยิ่งมีลิงก์วิ่งไปมา |

## ลำดับและการพึ่งพา

```
2.5-A  Game Console แก้ผลได้ + no-show ที่เชื่อถือได้   (ปลดล็อก #1 #2 #3 #4)
 └─ 2.5-B  court_plus_shuttle + rounding มีผลจริง        (ปลดล็อก #5)
     └─ 2.5-C  MembershipBilling (monthly)
         └─ 2.5-D  allocations + adjustments/refund
2.5-E  session templates + auto-generate      (ขนานได้ ไม่พึ่ง billing)
2.5-F  QR check-in + guest token เป็น cookie  (ขนานได้ · ปลดล็อก #6)
2.5-G  reminder jobs                          (พึ่ง 2.5-D สำหรับ "เตือนค้างจ่าย")
        └─ ✅ checkpoint: E2E Phase 2.5 + tag v0.2.0
```

---

## WO-2.5-A: Game Console แก้ผลได้ + no-show ที่เชื่อถือได้ ✅ **เสร็จ (13 ส.ค. 2026)**

**Goal**: ตัวเลขที่ billing จะใช้ในใบถัดไปแก้ได้ก่อนปิดรอบ และสถานะ no-show ตรวจสอบย้อนหลังได้

**Scope**
- ทำเฉพาะ: แก้ `shuttles_used` ของเกมที่จบแล้ว (เฉพาะตอนนัดยัง**ไม่**ปิดรอบ) · `mark_no_show()` เป็น DB function พร้อม event + state guard · ปุ่ม "เช็คอินทุกคนที่ได้ที่" · **หน้าสรุปยอดก่อนกดปิดรอบ**
- ไม่แตะ: สูตรคิดเงิน (ใบถัดไป) · QR check-in (WO-2.5-F)

**Definition of Done**
- แก้จำนวนลูกได้เมื่อนัดอยู่ `in_play` · **แก้ไม่ได้หลัง `billing`** (raise ไม่ใช่เงียบ)
- `mark_no_show()` เขียน `event_logs` และปฏิเสธ transition ที่ไม่อนุญาต — เทสต์ระดับ DB
- ปิดรอบตอนที่**ไม่มีใครเช็คอินเลย** ต้องเตือนก่อน ไม่ใช่เก็บเงินทุกคนเงียบๆ
- หน้าสรุปยอดแสดงยอดต่อคน + เหตุผล (`attended`/`late_cancel`/`no_show`) ก่อนยืนยัน

**Forbidden**
- ห้ามให้แก้จำนวนลูกหลัง commit charges · ห้ามเขียน `session_registrations` ตรงโดยไม่ผ่าน DB function

**References**: BACKLOG §WO-2.7, §WO-2.8 · baseline §Verification (เช็คอินแต่ไม่ลงเกม)

**ผลลัพธ์** — migration `0024_console_corrections.sql` (3 ฟังก์ชัน) · 11 เทสต์ DB ใหม่
(`tests/sessions/console-corrections.test.ts`) + 4 เทสต์ domain · หน้า
`/gangs/[gangId]/sessions/[sessionId]/close` · error code ใหม่ `CONFIRMATION_REQUIRED`

DoD ทั้ง 4 ข้อผ่านจริง:
- แก้จำนวนลูกได้ตอน `in_play` · หลัง `billing` raise `INVALID_TRANSITION` และค่าเดิมไม่ถูกแตะ
- `mark_no_show()` เขียน event พร้อม `from_status` · ปฏิเสธ `waitlist`/`cancelled` → `no_show`
- ไม่มีใครเช็คอินเลย → `CONFIRMATION_REQUIRED` ต้องติ๊กยืนยันก่อนถึงปิดได้
- หน้าสรุปยอดแสดง **ทุกคน** พร้อมเหตุผลต่อคน ก่อนกดยืนยัน

⚠️ **Deviation**: ปุ่ม "ปิดรอบ เก็บเงิน" ในหน้ารายการนัด **ไม่ปิดรอบทันทีอีกต่อไป** —
พาไปหน้าสรุปยอดก่อน (เจตนาของ DoD ข้อสุดท้าย: ต้องเห็นยอดต่อคนก่อนยืนยัน)

---

## WO-2.5-B: `court_plus_shuttle` + นโยบายปัดเศษมีผลจริง ✅ **เสร็จ (13 ส.ค. 2026)**

**Goal**: ก๊วนที่คิดค่าคอร์ท+ค่าลูกตามจริงใช้ระบบได้ และ invariant ปัดเศษถูกพิสูจน์ด้วยเคสจริง

**Scope**
- ทำเฉพาะ: strategy `court_plus_shuttle` ใน `domain/billing` · เปิดใน `IMPLEMENTED_PRICING_TYPES` · UI ตั้งราคาแบบใหม่ · ใช้ `splitEvenly()` ที่เขียนไว้แล้วใน WO-2.8
- ไม่แตะ: `monthly` (WO-2.5-C)

**Definition of Done**
- **money invariant มีเคสจริง**: `sum(charges) − ต้นทุนจริง = surplus` ที่ 3 / 7 / 13 คน โดย `surplus ≠ 0`
- `rounding_surplus` ใน `breakdown` เป็นค่าจริง ไม่ใช่ `0.00` อีกต่อไป
- 🔴 **นัดเก่าที่ snapshot เป็น `flat_rate` ยังคิดเงินเหมือนเดิมทุกบาท** — มีเทสต์
- ค่าลูกของสมาชิกรายเดือนคิดตาม `monthly_member_pays_shuttle` (ค่าสนาม = 0 เสมอ)
- `rounding_policy` ทั้งสามโหมดใช้ได้จริงจาก UI

**Forbidden**
- ห้ามแก้ snapshot ที่แช่แข็งแล้ว · ห้ามใช้ float กับเงิน (ใช้ `money.ts`)
- ห้ามลบ guard `isImplemented()` — เปิดเฉพาะตัวที่ทำเสร็จจริง

**References**: **ADR-002** · baseline §การตัดสินใจสะสม (นโยบายปัดเศษ — blocker) · `domain/billing/rounding.ts`

**ผลลัพธ์** — **ADR-005** (หารค่าสนาม/ค่าลูกแยกก้อน + เศษรายคนแบบ largest remainder) ·
ไม่มี migration ใหม่ (คอลัมน์ `court_fee_total`/`shuttle_price`/`monthly_member_pays_shuttle`
มีมาตั้งแต่ 0003) · เทสต์ใหม่ 30 ตัว (`tests/domain/court-plus-shuttle.test.ts` 22 +
`tests/sessions/court-billing.test.ts` 6 + policies 2)

DoD ทั้ง 5 ข้อผ่านจริง:
- money invariant ที่ 3/7/13 คน × 3 โหมดปัดเศษ — **surplus ≠ 0 จริง** (เทสต์ assert ข้อนี้ตรงๆ
  ไม่งั้นเทสต์จะผ่านแบบไม่ได้พิสูจน์อะไร)
- `rounding_surplus` ต่อ charge เป็นค่าจริง และ**บวกกันได้ surplus ของนัดเป๊ะ**
- นัดเก่าที่ snapshot เป็น `flat_rate` คิดได้ยอดเดิมทุกบาท — มีเทสต์ที่ใช้ snapshot
  รูปแบบก่อน WO นี้ (ไม่มี `courtPlusShuttle`/`roundingPolicy`) โดยตรง
- ค่าลูกของสมาชิกรายเดือนตาม `monthly_member_pays_shuttle` · ค่าสนาม = 0 เสมอ
- เลือกโมเดล + โหมดปัดเศษได้จากหน้าตั้งค่าก๊วน

---

## WO-2.5-C: MembershipBilling (รายเดือน) ✅ **เสร็จ (13 ส.ค. 2026)**

**Goal**: ก๊วนที่เก็บรายเดือนออกบิลได้อัตโนมัติและไม่ซ้ำ

**Scope**
- ทำเฉพาะ: `monthly_fee` charges ต่อสมาชิก+เดือน · cron job รายเดือน · หน้าดูรอบบิล
- ไม่แตะ: การจ่ายเงิน (มีอยู่แล้วจาก WO-2.9)

**Definition of Done**
- **idempotent ต่อสมาชิก+เดือน** — รันซ้ำได้ ไม่สร้างซ้ำ (มี partial unique index อยู่แล้วใน 0004)
- ครบทุกสมาชิก `is_monthly_member` ที่ active ในเดือนนั้น · คนที่เข้ากลางเดือนคิดตามกติกาที่ตกลง
- 🔴 **commit ผ่านฟังก์ชันของ MembershipBilling เอง ไม่ใช่ `close_session_with_charges()`** (ADR-001 — `monthly_fee` ไม่มี session ให้ transition)
- เป็น Vercel Cron ไม่ใช่ pg_cron (baseline §การแบ่งงาน cron — เป็น app logic)

**Forbidden**
- ห้าม insert `session_charges` ประเภท `monthly_fee` ที่อื่น

**References**: **ADR-001** · baseline §Verification (MembershipBilling idempotent)

**ผลลัพธ์** — **ADR-006** (`monthly` เป็นแผนแยกแถว + กติกาเข้ากลางเดือน) ·
migration `0026`… ไม่มี — ใช้ `0025_membership_billing.sql` (`commit_monthly_fees()`) ·
เทสต์ใหม่ 29 ตัว (domain 14 + DB 9 + cron path 6) · หน้า `/gangs/[gangId]/membership`

DoD ทั้ง 4 ข้อผ่านจริง:
- idempotent ต่อสมาชิก+เดือน — เทสต์รันซ้ำได้ `created = 0` และ INSERT ตรงยังชน
  `session_charges_monthly_member_month_key` (กันที่ระดับ DB ไม่ใช่แค่ในโค้ด)
- ครบทุกสมาชิก `is_monthly_member` · **เข้ากลางเดือนเก็บเต็มเดือน** (กติกาที่ตกลง)
- commit ผ่าน `commit_monthly_fees()` เท่านั้น · charge ไม่ผูก session
- เป็น Vercel Cron (`/api/cron/monthly-fees`) ไม่ใช่ pg_cron

⚠️ **Deviation**: ตั้ง cron เป็น **รายวัน** ไม่ใช่รายเดือน — เพราะกติกา "เก็บเต็มเดือน"
แปลว่าคนที่สมัครวันที่ 20 ต้องได้บิลของเดือนนั้น ถ้ารันเดือนละครั้งเขาจะได้เดือนหน้าแทน
ปลอดภัยเพราะ idempotent ต่อสมาชิก+เดือน (บันทึกใน ADR-006)

---

## WO-2.5-D: `payment_allocations` + adjustments/refund ✅ **เสร็จ (13 ส.ค. 2026)**

**Goal**: จ่ายแทนเพื่อนได้ และแก้ยอดหลัง verify ได้โดยไม่แตะ record เดิม

**Scope**
- ทำเฉพาะ: จ่าย 1 สลิปครอบหลาย charge (ข้ามคน) · `payment_adjustments` (refund/correction/credit) ระดับ **charge** · dashboard ยอดสุทธิคำนวณจาก ledger
- ไม่แตะ: coupon (Phase หลัง)

**Definition of Done**
- **invariant**: `sum(allocations ของ payment) ≤ payment.amount` — trigger มีอยู่แล้ว ต้องมีเทสต์ยิงชน
- ยอดสุทธิต่อคน = `charge − allocations + adjustments` ถูกต้องทุกเคส
- refund 1 รายการระดับ charge แล้ว dashboard สะท้อนทันที
- **แก้ปัญหาออกใบจ่ายซ้ำ** — กด "ขอ QR" ซ้ำต้องใช้ใบเดิมถ้ายังไม่ `verified`
- E2E: 1 สลิป 2 คน (baseline ระบุเคสนี้ตรงๆ)

**Forbidden**
- ห้ามแก้ `payments` / `session_charges` ที่ verify แล้ว — ต้องผ่าน ledger เท่านั้น
- ห้ามอ่านยอดสุทธิจาก `status` (baseline §การตัดสินใจสะสม — Allocated/Adjusted ไม่ใช่ state)

**References**: baseline §การตัดสินใจสะสม (Refund/แก้ยอดหลัง verify) · §Verification (Money invariants)

**ผลลัพธ์** — migration `0026_payment_ledger.sql` · `domain/billing/ledger.ts` ·
เทสต์ใหม่ 27 ตัว (DB 15 + domain 12) · dashboard เขียนใหม่ให้คิดจาก ledger

DoD ทั้ง 5 ข้อผ่านจริง:
- invariant `sum(allocations) ≤ payment.amount` — ยิงชนแล้วได้ `ALLOCATION_EXCEEDS_PAYMENT`
  และเคส "เท่ากันพอดี" ต้องผ่าน (`≤` ไม่ใช่ `<`)
- ยอดสุทธิ = `charge − allocations + adjustments` — ทั้งใน `charge_outstanding()` (SQL)
  และ `domain/billing/ledger.ts` (หน้าจอ)
- refund ระดับ charge แล้ว dashboard สะท้อนทันที (ยอดติดลบ = ก๊วนต้องคืน)
- กด "ขอ QR" ซ้ำได้ใบเดิมถ้ายังไม่ `verified`
- E2E 1 สลิป 2 คน: verify ครั้งเดียว หนี้ทั้งสองคนเป็น 0

**การตัดสินใจที่บันทึกไว้** (ไม่ถึงขั้น ADR เพราะตามกติกาที่ baseline วางไว้แล้ว):
- 🔴 นับ allocation **เฉพาะสลิปที่ `verified`** — ถ้านับสลิปที่ยังไม่ยืนยันด้วย
  คนอัปสลิปปลอมจะทำให้หนี้หายทันที
- 🔴 "ค้างเก็บ" กับ "ต้องคืน" **ไม่หักกลบกัน** ในสรุป — ก๊วนที่มีคนค้าง 500
  และอีกคนจ่ายเกิน 500 ต้องไม่เห็นเป็น "เก็บครบแล้ว"
- `event_logs.aggregate_type` เพิ่มค่า `'charge'` (expand — additive)
  เพราะการปรับยอดเกิดกับหนี้ก้อนหนึ่ง ไม่ใช่กับ payment (สลิปใบเดียวครอบหลายคน)

---

## WO-2.5-E: Session templates + auto-generate ✅ **เสร็จ (13 ส.ค. 2026)**

**Goal**: ก๊วนที่เล่นประจำไม่ต้องสร้างนัดมือทุกสัปดาห์

**Scope**
- ทำเฉพาะ: CRUD template (recurrence, คอร์ท, max_players, pricing plan) · cron generate ล่วงหน้า **2 สัปดาห์**
- ไม่แตะ: การลงชื่อ/คิดเงิน (ใช้ของเดิม)

**Definition of Done**
- **idempotent** — รันซ้ำไม่ generate นัดซ้ำ (baseline §Verification "Job tests")
- แก้ template **มีผลเฉพาะนัดที่ยังไม่ generate** · แก้นัดที่ generate แล้ว = แก้เฉพาะนัดนั้น
- 🔴 **นัดที่ generate ต้องมี snapshot ครบเหมือนสร้างมือ** — ไม่งั้นปิดรอบไม่ได้
- เวลาที่ generate แปลงตาม `gangs.timezone` (ใช้ `domain/time`) — มีเทสต์ข้าม timezone
- นัดที่ generate เป็น `draft` เสมอ [D-14]

**Forbidden**
- ห้าม generate นัดที่ `status` ไม่ใช่ `draft` · ห้ามอ่านราคาปัจจุบันตอนคิดเงิน (snapshot ตอน generate)

**References**: baseline §การตัดสินใจสะสม (นัดประจำสัปดาห์) · §Verification (Job tests)

**ผลลัพธ์** — migration `0027` (unique index `sessions_template_slot_key`) ·
`domain/sessions/recurrence.ts` · `server/templates/generate.ts` ·
cron `/api/cron/session-generate` (รายวัน) · หน้า `/gangs/[gangId]/templates` ·
เทสต์ใหม่ 23 ตัว (domain 10 + integration 13)

DoD ทั้ง 5 ข้อผ่านจริง:
- idempotent — รันซ้ำไม่ได้นัดซ้ำ และ INSERT ตรงยังชน unique index (กันที่ระดับ DB)
- แก้ตารางมีผลเฉพาะรอบที่ยังไม่สร้าง — นัดเดิมไม่ขยับเวลา/จำนวนคน
- snapshot ครบเหมือนสร้างมือ — ใช้ `buildSessionSnapshot()` **ตัวเดียวกับ** `createSession()`
- เวลาแปลงตาม `gangs.timezone` — ก๊วนไทยกับก๊วน UTC ได้ instant ต่างกัน 7 ชั่วโมง
- นัดที่ generate เป็น `draft` เสมอ

**การตัดสินใจที่บันทึกไว้**:
- ⚠️ **Deviation จาก CLAUDE.md §2.6** — unique index **จงใจไม่กรอง `deleted_at`**
  เพราะตัวตนของนัดที่ generate คือ "template + เวลา" ⇒ ถ้ากรอง แอดมินที่ลบนัดที่งดเล่น
  จะโดน cron สร้างกลับมาใหม่ (มีเทสต์คุมข้อนี้)
- refactor: ย้ายการประกอบ snapshot ออกจาก `createSession()` มาเป็น
  `server/sessions/snapshot.ts` — ถ้าปล่อยให้สองทางประกอบเอง วันหนึ่งจะเบี่ยงจากกัน
  แล้วนัดที่ generate จะปิดรอบไม่ได้โดยไม่มีใครรู้จนถึงหน้างาน
- cron รายวัน (ไม่ใช่รายสัปดาห์) เพื่อให้ขอบ 2 สัปดาห์เลื่อนตามทุกวัน

---

## WO-2.5-F: QR check-in + guest token ย้ายเข้า cookie ✅ **เสร็จ (14 ส.ค. 2026)**

**Goal**: เช็คอินหน้างานเร็วขึ้น และลิงก์ของ guest ไม่รั่วผ่าน referrer

**Scope**
- ทำเฉพาะ: QR ต่อ registration สำหรับเช็คอิน · หน้าสแกนของแอดมิน · **แลก guest token เป็น cookie httpOnly ครั้งแรกที่เปิดหน้า แล้ว redirect ทิ้ง query string**
- ไม่แตะ: LINE LIFF (Phase 4)

**Definition of Done**
- 🔴 **QR ของนัดหนึ่งใช้เช็คอินอีกนัดไม่ได้** (เทียบเคียง `INVITE_TOKEN_INVALID` ที่มีเทสต์แล้ว)
- QR หมดอายุตามนัด · สแกนซ้ำไม่เปลี่ยนอะไร (idempotent)
- `/guest/<id>?t=` เปิดครั้งแรก → ตั้ง cookie → URL ไม่มี token อีก · เปิดซ้ำใช้ cookie
- token ยังเก็บเป็น hash เท่านั้น · ❌ ห้าม log plaintext

**Forbidden**
- ห้ามใช้ UUID เป็น token · ห้ามให้เช็คอินจาก `waitlist` ตรง

**References**: BACKLOG §WO-2.5 (ข้อจำกัดความปลอดภัย) · CLAUDE.md §2.5

**ผลลัพธ์** — migration `0028` (`checkin_token_hash` + 2 ฟังก์ชัน) ·
`lib/guest/session.ts` + route `/guest/[registrationId]/claim` ·
หน้า `/gangs/[gangId]/sessions/[sessionId]/scan` · error code ใหม่ `CHECKIN_TOKEN_INVALID` ·
เทสต์ใหม่ 17 ตัว (QR 11 + cookie 6)

DoD ทั้ง 4 ข้อผ่านจริง:
- QR ของนัดหนึ่งใช้เช็คอินอีกนัดไม่ได้ — `check_in_by_token()` รับ `session_id` เข้าไปกรองเสมอ
- QR หมดอายุตามนัด (`billing`/`cancelled` → `SESSION_NOT_OPEN`) · สแกนซ้ำได้ `already = true`
  โดยไม่เกิด event ซ้ำ
- `/guest/<id>?t=` เปิดครั้งแรก → ตั้ง cookie httpOnly → redirect ไป URL ที่ไม่มี token
  (เทสต์ assert ทั้ง `location` และ `set-cookie` ของ route handler จริง)
- token เก็บเป็น SHA-256 เท่านั้น · ไม่มี plaintext ใน `event_logs`

**การตัดสินใจที่บันทึกไว้**:
- 🔴 **client ไม่เคยถือ check-in token** — `issueCheckinQr()` คืน **ภาพ QR (data URL)**
  ไม่ใช่ token ⇒ token ไม่ผ่าน JavaScript ฝั่งเบราว์เซอร์เลย
- ขอ QR ใหม่ = ของเดิมใช้ไม่ได้ทันที ⇒ ภาพ QR ที่หลุดในแชทกลุ่มไม่ใช่กุญแจถาวร
- **ไม่ฝังไลบรารีอ่าน QR ในหน้าเว็บ** — QR บรรจุ URL ของหน้าสแกนฝั่งแอดมิน
  แอดมินใช้กล้องเนทีฟของเครื่อง (iOS Safari ยังไม่รองรับ `BarcodeDetector`)
  แล้วหน้าสแกนยิง server action + ล้าง `?c=` ออกจาก URL ทันที
- `CHECKIN_TOKEN_INVALID` ไม่แยกกรณี "ไม่มีจริง / เป็นของนัดอื่น / หมดอายุ"
  เพราะการแยกเท่ากับยืนยันว่า token มีอยู่จริง

---

## WO-2.5-G: Reminder jobs ✅ **เสร็จ (14 ส.ค. 2026)**

**Goal**: คนไม่ลืมนัดและไม่ลืมจ่าย

**Scope**
- ทำเฉพาะ: เตือนก่อนนัด (ตามเวลาที่ก๊วนตั้ง) · เตือนยอดค้างจ่าย · ใช้คิว `notifications` เดิม
- ไม่แตะ: LINE (Phase 4 — ใช้คิวเดียวกันอยู่แล้ว)

**Definition of Done**
- **ไม่ส่งซ้ำ** — เตือนนัดเดิม/ยอดเดิมสองครั้งไม่ได้ (idempotent key)
- เตือนค้างจ่ายส่งเฉพาะคนที่ยังค้างจริง **หลังหักallocations/adjustments แล้ว** (พึ่ง WO-2.5-D)
- เป็น Vercel Cron (app logic) · แถวค้าง `processing` ยังถูก sweep ได้เหมือนเดิม

**Forbidden**
- ห้ามสร้าง worker ตัวใหม่ — ใช้ `claim_notifications()` + `dispatchNotifications()` เดิม

**References**: baseline §Verification (Job tests) · §Notification worker

**ผลลัพธ์** — migration `0029` (`notifications.dedupe_key` + `enqueue_notifications()`) ·
`domain/gangs/settings.ts` · `server/notifications/reminders.ts` ·
cron `/api/cron/reminders` (รายชั่วโมง) · เทสต์ใหม่ 23 ตัว (DB 14 + domain 8 + E2E 1)

DoD ทั้ง 3 ข้อผ่านจริง:
- ไม่ส่งซ้ำ — dedupe key + unique index · INSERT ตรงยังชน (กันที่ระดับ DB)
- เตือนค้างจ่ายเฉพาะคนที่ค้างจริงหลังหัก allocations/adjustments (ผูกกับ ledger ของ WO-2.5-D)
- เป็น Vercel Cron และ **ไม่มี worker ใหม่** — เทสต์ยืนยันว่าแถวที่เข้าคิว
  ถูก `claim_notifications()` + `mark_notification_sent()` เดิมหยิบไปส่งได้

**🔴 บั๊กที่เจอระหว่างทางและแก้ไปด้วย**: PostgREST serialize `numeric` เป็น **JSON number**
ไม่ใช่ string ⇒ `toSatang()` (ที่จงใจรับเฉพาะ string) พังตอน runtime
กระทบหน้า payments dashboard + หน้าจ่ายเงิน + `addChargeAdjustment()` ที่ทำใน WO-2.5-D
เทสต์ระดับ DB ไม่เจอเพราะ `pg` driver คืน `numeric` เป็น string
⇒ เพิ่ม `lib/supabase/money.ts` (`moneyFromDb()`) เป็นตัวแปลงที่ **ขอบระบบ**
โดยไม่ผ่อนกฎของ `domain/billing/money.ts`

---

## ✅ Phase 2.5 checkpoint

ก่อนประกาศจบ ต้องผ่าน **E2E ของ Phase 2.5** ที่ baseline §Verification เพิ่มไว้:

> จ่ายแทนเพื่อน 1 สลิป 2 คน · template generate · QR check-in
> (บวกเส้นเต็มของ MVP-0 ที่ต้องยังผ่านอยู่)

แล้ว tag **`v0.2.0`** ตาม §Release Versioning

✅ **E2E ผ่านแล้ว** (14 ส.ค. 2026) — `tests/e2e/phase25-full-path.test.ts`
เดิน: ตารางประจำ generate (idempotent) → QR check-in (สแกนซ้ำ/ข้ามนัด) →
แก้จำนวนลูกก่อนปิดรอบ → ปิดรอบ `court_plus_shuttle` (เศษ 3 บาทจริง) →
**จ่ายแทนเพื่อน 1 สลิป 2 คน** → คืนเงินบางส่วน → ค่าสมาชิกรายเดือน (idempotent) →
เตือนยอดค้างเฉพาะคนที่ค้างจริง · E2E ของ MVP-0 ยังผ่านครบเหมือนเดิม

**ยังไม่อยู่ใน Phase 2.5** (Phase 3 ขึ้นไป): `member_statistics` rollup · `daily_metrics` ·
รายงาน · ประกาศ · Discovery + join request · Landing page · LINE ทั้งชุด · Playwright เต็มรูป

---

# Phase 3 — Growth (WO-3.A … WO-3.F)

> แตกใบเมื่อ 14 ส.ค. 2026 หลังปิด Phase 2.5 (`v0.2.0`)
> baseline §Roadmap: `member_statistics` rollup + `daily_metrics` → รายงาน → ประกาศ →
> Discovery (pg_trgm) + join request + walk-in → Landing Page (static/ISR)

⇒ ใบของ Phase 3 ใช้ **ตัวอักษร**: `WO-3.A` … `WO-3.F`

## 🔴 ข้อจำกัดจาก Phase ก่อนหน้าที่ทุกใบต้องยึด

| # | ข้อจำกัด | ทำผิดแล้วเกิดอะไร |
|---|---|---|
| 1 | **รายรับนับจาก `session_charges` / ledger เสมอ ไม่อิง `sessions.status`** (baseline v3.3) | นัดที่ยกเลิกกลางคันแต่มี charges จะหายจากรายงาน — เงินเข้าจริงแต่รายงานบอกว่าไม่มี |
| 2 | **ยอดสุทธิ = `charge − allocations(verified) + adjustments`** (WO-2.5-D) | รายงานจะนับเงินที่ยังไม่ได้รับ หรือไม่หักเงินที่คืนไปแล้ว |
| 3 | **PostgREST คืน `numeric` เป็น JSON number** ⇒ ต้องผ่าน `moneyFromDb()` ก่อนเข้า `domain/` | หน้าพังตอน runtime — เทสต์ระดับ DB จับไม่ได้เพราะ `pg` คืน string |
| 4 | **`gangs.features` ต้อง enforce ฝั่ง server** (`can()` + DB function) — `statistics`, `discovery` | ซ่อนปุ่มอย่างเดียว = flag ปลอม ใครยิง action ตรงก็ผ่าน |
| 5 | **UI อ่านสถิติจาก `member_statistics` เท่านั้น** (baseline §ตาราง) | สองแหล่งความจริง แล้วเลขบนจอกับในรายงานไม่ตรงกัน |
| 6 | **งานที่รันซ้ำได้ต้อง idempotent ที่ระดับ DB** ไม่ใช่ check-then-act ใน TS | cron ซ้อนกันแล้วได้แถวซ้ำ (CLAUDE.md §2.1) |
| 7 | **ห้ามสร้าง worker/คิวใหม่** — ใช้ `enqueue_notifications()` + `claim_notifications()` เดิม | มีสองทางส่ง แล้ว retry/backoff คนละแบบ |

## ลำดับที่เลือก (ต่างจากการอ่าน Roadmap แบบผิวๆ)

baseline เรียง "rollup → รายงาน → ประกาศ → discovery → landing" อยู่แล้ว และใบนี้ยึดตามนั้น
เพราะ **รายงานกับหน้าสถิติอ่านจาก rollup** (ข้อ 5) ⇒ ถ้าทำรายงานก่อน จะต้องเขียน query
สดชั่วคราวแล้วรื้อทีหลัง = งานสองรอบและมีช่วงที่เลขสองที่ไม่ตรงกัน

---

## WO-3.A: Rollup job (`member_statistics` + `daily_metrics`) ✅ **เสร็จ (14 ส.ค. 2026)**

**Goal**: มีแหล่งข้อมูลเดียวสำหรับสถิติและรายงาน ที่รันซ้ำได้โดยไม่เพี้ยน

**Scope**
- ทำเฉพาะ: DB function คำนวณ + upsert `member_statistics` (ต่อสมาชิก) และ `daily_metrics` (ต่อวัน) · Vercel Cron รายคืน · ปุ่มสั่ง rollup เองของแอดมิน
- ไม่แตะ: หน้าจอรายงาน (WO-3.B) · หน้าสถิติสมาชิก (WO-3.C)

**Definition of Done**
- 🔴 **idempotent** — รันซ้ำวันเดิมได้ผลเท่าเดิม ไม่ใช่ยอดสะสมทวีคูณ (`daily_metrics.metric_date` unique อยู่แล้ว, `member_statistics` unique ต่อสมาชิก)
- `attended_count` / `games_count` / `shuttles_used` / `total_paid` / `attendance_rate` ตรงกับข้อมูลดิบ — มีเทสต์เทียบกับ query สดในเคสที่รู้คำตอบ
- 🔴 **`total_paid` นับจาก ledger** (จ่ายจริงหลังหัก refund) ไม่ใช่ผลรวม `session_charges`
- `daily_metrics.revenue` นับจาก charges ที่เกิดในวันนั้น **รวมนัดที่ยกเลิกกลางคัน** (ข้อจำกัด 1)
- `attendance_rate` มีนิยามเดียวเขียนไว้ในคอมเมนต์ (นับจากนัดที่ลงชื่อ ไม่ใช่นัดทั้งหมดของก๊วน) และเทสต์ยึดตามนั้น
- ก๊วนที่ปิด `features.statistics` ต้องไม่ถูก rollup (ประหยัดงานและเคารพ flag)

**Forbidden**
- ห้ามใช้ `INSERT ... SELECT` ที่บวกทับของเดิม — ต้อง upsert ค่าที่คำนวณใหม่ทั้งก้อน
- ห้ามคำนวณเงินด้วย float ใน SQL (ใช้ `numeric` ล้วน) · ห้ามอ่านเงินผ่าน `supabase-js` โดยไม่ผ่าน `moneyFromDb()`

**References**: baseline §ตาราง (`member_statistics`, `daily_metrics`) · §Verification (Job tests) · ข้อจำกัด 1, 2, 5, 6

**ผลลัพธ์** — migration `0030` (3 ฟังก์ชัน + pg_cron `gang-badminton-rollup`) ·
cron `/api/cron/rollup` (Vercel Cron คู่ขนาน) · ปุ่ม "คำนวณสถิติใหม่" ในหน้าตั้งค่าก๊วน ·
เทสต์ใหม่ 13 ตัว (`tests/reports/rollup.test.ts`)

DoD ทั้ง 6 ข้อผ่านจริง:
- idempotent — รันซ้ำได้ผลเท่าเดิม และมีแถวเดียวต่อสมาชิกเสมอ
- ตัวเลขตรงกับข้อมูลดิบในเคสที่รู้คำตอบ (มาเล่น/เกม/ลูก/เงิน/อัตราการมา)
- `total_paid` จาก ledger — สลิปที่ยังไม่ `verified` ไม่นับ · refund หักออก
- `daily_metrics.revenue` รวมนัดที่ **ยกเลิกกลางคัน** (เทสต์ยืนยัน +200 จากนัด `cancelled`)
- `attendance_rate` มีนิยามเดียวในคอมเมนต์ของ migration และเทสต์ยึดตามนั้น
- ก๊วนที่ปิด `features.statistics` ไม่ถูก rollup (และปุ่มของแอดมินตอบ `FEATURE_DISABLED`)

**นิยามที่ตรึงไว้ (อยู่ในคอมเมนต์ของ `0030` — หน้าจอห้ามนิยามเอง)**
- `shuttles_used` = **ส่วนแบ่ง** ลูกของเกมที่ลง (`/4`) ⇒ ผลรวมทุกคน = ลูกจริงของก๊วน
- `total_paid` = allocation ของสลิปที่ `verified` **หัก refund** — `credit`/`correction`
  ไม่นับเพราะไม่ใช่การเคลื่อนเงินสด
- `attendance_rate` = มาเล่น ÷ **นัดที่เคยได้ที่** (`checked_in|confirmed|no_show`) × 100
  ไม่ใช่นัดทั้งหมดของก๊วน
- `daily_metrics` ใช้ **นาฬิกาไทย** เพราะเป็นตัวเลขระดับแพลตฟอร์ม ไม่ใช่ของก๊วนใดก๊วนหนึ่ง

---

## WO-3.B: รายงานรายรับ-รายจ่าย-กำไรของก๊วน ✅ **เสร็จ (15 ส.ค. 2026)**

**Goal**: แอดมินตอบได้ว่าเดือนนี้ก๊วนได้เท่าไหร่ จ่ายอะไรไปบ้าง เหลือเท่าไหร่ และตัวเลขตรวจสอบย้อนกลับได้

**Scope**
- ทำเฉพาะ: CRUD `gang_expenses` / `gang_incomes` · หน้ารายงานต่อช่วงเวลา (รายรับจาก charges + incomes, รายจ่ายจาก expenses, กำไร = ส่วนต่าง) · แสดง `rounding_surplus` แยกบรรทัด
- ไม่แตะ: รายงานระดับแพลตฟอร์ม (`daily_metrics` — เป็นของ WO-3.A/landing) · export ไฟล์

**Definition of Done**
- 🔴 **reconcile ได้**: `sum(charges) − ต้นทุนจริง = rounding surplus` แสดงบนหน้าจอและมีเทสต์ยืนยันกับข้อมูลที่รู้คำตอบ
- รายรับนับจาก **ledger** (จ่ายจริง) และแยกให้เห็น "เรียกเก็บแล้ว" กับ "เก็บได้จริง" คนละบรรทัด
- นัดที่ `cancelled` แต่มี charges **เข้ารายงาน** (ข้อจำกัด 1) — มีเทสต์
- ค่าใช้จ่ายผูกนัดได้ (`session_id`) และแบบไม่ผูกก็ได้ · ลบแล้วรายงานเปลี่ยนทันที
- เงินทุกช่องเป็นจำนวนเต็มสตางค์ (`domain/billing/money.ts`) — ❌ ไม่มี `Number()` บวกเงินในหน้าจอ

**Forbidden**
- ห้ามอ่านยอดค้าง/ยอดเก็บได้จาก `payments.status` · ห้ามสร้างตารางสรุปใหม่ (ใช้ rollup + query ตรง)

**References**: baseline §โมดูล ข้อ 7 · §Verification (Money invariants) · ADR-005 · ข้อจำกัด 1, 2, 3

**ผลลัพธ์** — **ไม่มี migration ใหม่** (ตาราง + RLS มีตั้งแต่ 0004/0010) ·
`domain/reports/finance.ts` · `server/actions/finance.ts` · หน้า `/gangs/[gangId]/reports` ·
สิทธิ์ใหม่ `gang.finance.manage` · เทสต์ใหม่ 18 ตัว (domain 11 + integration 7)

DoD ทั้ง 5 ข้อผ่านจริง:
- **reconcile ได้** — บรรทัด "เศษจากการปัด" + ต้นทุนจริง (`charged − surplus`) บนหน้าจอ
  และ `assertReportReconciles()` มีเทสต์ทั้งเคสตรงและเคสไม่ตรง
- แยก **"เรียกเก็บแล้ว"** กับ **"เก็บได้จริง"** คนละบรรทัด — สลิปที่ยังไม่ `verified` ไม่นับเป็นเงินสด
- นัดที่ `cancelled` แต่มี charges **เข้ารายงาน** (เทสต์ยืนยันว่า charged = 200 จากนัดที่ยกเลิกกลางคัน)
- ค่าใช้จ่ายผูกนัดได้/ไม่ผูกก็ได้ · ลบแล้วรายงานเปลี่ยนทันที
- เงินทุกช่องผ่าน `domain/billing/money.ts` — ❌ ไม่มี `Number()` บวกเงินในหน้าจอ

**นิยามที่ตรึงไว้**
- `collected` (เก็บได้จริง) = allocation ของสลิปที่ `verified` **หัก refund**
  ⇒ `credit`/`correction` ลดหนี้แต่ไม่ใช่เงินสด จึงกระทบ `charged`/`outstanding` เท่านั้น
  (นิยามเดียวกับ `total_paid` ของ rollup ใน WO-3.A — สองที่ต้องตรงกัน)
- `netCash` = เก็บได้จริง + รายรับอื่น − รายจ่าย ⇒ **เงินที่ยังไม่เข้าไม่ใช่กำไร**

---

## WO-3.C: หน้าสถิติสมาชิก + timeline ✅ **เสร็จ (15 ส.ค. 2026)**

**Goal**: สมาชิกเห็นสถิติตัวเอง แอดมินเห็นภาพรวมก๊วน และตรวจย้อนหลังได้ว่าเกิดอะไรขึ้น

**Scope**
- ทำเฉพาะ: หน้าสถิติของก๊วน (อ่านจาก `member_statistics`) · หน้าสถิติของตัวเอง · timeline ของนัดจาก `event_logs`
- ไม่แตะ: กราฟ/ชาร์ต (ยังไม่มีไลบรารีและไม่อยู่ใน baseline) · ranking/leaderboard

**Definition of Done**
- 🔴 **หน้าจออ่านจาก `member_statistics` เท่านั้น** (ข้อจำกัด 5) — ไม่มี query นับสดในหน้า
- ก๊วนที่ปิด `features.statistics` → หน้านี้เข้าไม่ได้ **ทั้งฝั่ง UI และ action** (ข้อจำกัด 4) — มีเทสต์ยิง action ตรง
- timeline แสดงเฉพาะ event ของนัดที่ผู้ใช้มีสิทธิ์เห็น (RLS ของ `event_logs` เป็นด่านจริง)
- 🔴 timeline **ไม่แสดง payload ดิบ** — map เป็นข้อความไทยที่จุดแสดงผลจุดเดียว (ไม่งั้น token/ยอดเงินหลุดหน้าจอ)
- สถิติที่ยังไม่เคย rollup แสดงว่า "ยังไม่มีข้อมูล" ไม่ใช่ 0 ที่ดูเหมือนข้อมูลจริง

**Forbidden**
- ห้าม fallback ไปนับสดเมื่อ rollup ยังไม่มา (สองแหล่งความจริง) · ห้าม log/แสดง plaintext token จาก event payload

**References**: baseline §โมดูล ข้อ 7 · §ตาราง (`member_statistics`) · ข้อจำกัด 4, 5

**ผลลัพธ์** — migration `0031` (รัด RLS ของ `member_statistics`) ·
`domain/reports/timeline.ts` · หน้า `/gangs/[gangId]/stats` · ไทม์ไลน์ในหน้ารายละเอียดนัด ·
สิทธิ์ใหม่ `statistics.view` (ผูกกับ `features.statistics`) · เทสต์ใหม่ 12 ตัว (domain 7 + RLS 5)

DoD ทั้ง 5 ข้อผ่านจริง:
- หน้าจออ่านจาก `member_statistics` เท่านั้น — ไม่มี query นับสด และไม่มี fallback
- `features.statistics` ปิด = เข้าหน้าไม่ได้ (`can()` gate ด้วย `FEATURE_GATED`)
- timeline อ่านผ่าน client ที่ผูก session ⇒ **RLS เป็นด่านจริง** ไม่ใช่กรองใน TS
- 🔴 timeline ไม่แสดง payload ดิบ — ใช้ **whitelist** ต่อ event type
  ⇒ เพิ่ม event ใหม่แล้วลืมมาแก้ = ขึ้นข้อความกลางๆ ไม่ใช่ payload หลุด (มีเทสต์คุม)
- ยังไม่เคย rollup → แสดง "ยังไม่มีข้อมูล" ไม่ใช่ 0

**🔴 ช่องโหว่ที่เจอระหว่างทางและปิดไปด้วย** — policy เดิมของ `member_statistics` (0010)
ให้ **สมาชิกทุกคนอ่านสถิติทั้งก๊วน** ซึ่งรวม `total_paid` (ยอดเงินที่แต่ละคนจ่ายสะสม)
ขัดกับกติกาที่ตั้งไว้ตั้งแต่ WO-2.9 ว่า "สมาชิกไม่ควรเห็นยอดหนี้ของเพื่อน"
⇒ `0031` รัดเป็น **แถวของตัวเอง หรือเป็นแอดมินของก๊วนนั้น** (ตรงกับ baseline §โมดูล ข้อ 7)

**การตัดสินใจที่บันทึกไว้**: event ที่มี**ยอดเงินรายคน** (`payment.*`, `session.charges_committed`,
`membership.fees_generated`) ทำเครื่องหมาย `adminOnly` ⇒ สมาชิกทั่วไปไม่เห็นในไทม์ไลน์
(กติกาเดียวกับ `payments`) — RLS ของ `event_logs` ยังเป็นระดับก๊วนเหมือนเดิม

---

## WO-3.D: ประกาศของก๊วน ✅ **เสร็จ (15 ส.ค. 2026)**

**Goal**: ก๊วนแจ้งข่าวได้ในที่เดียว และคนที่เกี่ยวข้องได้รับแจ้งเตือน

**Scope**
- ทำเฉพาะ: CRUD `announcements` (draft/published ผ่าน `published_at`) · แนบรูปผ่าน bucket `announcement-images` · เข้าคิวแจ้งเตือนตอน publish
- ไม่แตะ: LINE (Phase 4 — ใช้คิวเดียวกันอยู่แล้ว) · ประกาศระดับแพลตฟอร์ม

**Definition of Done**
- ประกาศที่ยังไม่ publish สมาชิกทั่วไป **มองไม่เห็น** — เทสต์ระดับ RLS ไม่ใช่แค่ซ่อนใน UI
- publish แล้วเข้าคิวแจ้งเตือนสมาชิกก๊วนผ่าน `enqueue_notifications()` พร้อม `dedupe_key`
  ⇒ 🔴 กด publish ซ้ำ/แก้แล้ว publish ใหม่ **ไม่ส่งซ้ำ** (ข้อจำกัด 7)
- path ของรูป **server เป็นคนประกอบ** (`lib/storage/paths.ts`) — client อัปโหลดไป path ที่ได้เท่านั้น [D-15]
- ลบประกาศแล้วรูปที่แนบไม่ค้างเป็นขยะที่เข้าถึงได้

**Forbidden**
- ห้ามให้ client ตั้ง path ของไฟล์เอง · ห้าม insert `notifications` ตรง

**References**: baseline §โมดูล (ประกาศ) · WO-1.4 [D-15] · WO-2.5-G (dedupe key) · ข้อจำกัด 7

**ผลลัพธ์** — migration `0032` (รัด RLS + `publish_announcement()`) ·
`server/actions/announcements.ts` · หน้า `/gangs/[gangId]/announcements` ·
เทสต์ใหม่ 11 ตัว (`tests/reports/announcements.test.ts`)

DoD ทั้ง 4 ข้อผ่านจริง:
- ร่างสมาชิกทั่วไปมองไม่เห็น — **เทสต์ระดับ RLS** ไม่ใช่ซ่อนใน UI
- publish เข้าคิวผ่าน `enqueue_notifications()` + `dedupe_key = announcement:<id>:<user>`
  ⇒ กด publish ซ้ำ **และ** แก้เนื้อหาแล้ว publish ใหม่ ไม่ส่งซ้ำ (เทสต์ทั้งสองเคส)
- path ของรูป server ประกอบให้ [D-15] · ตรวจซ้ำว่า path อยู่ใต้ก๊วนที่ถูกต้อง
- ลบประกาศแล้วลบไฟล์ที่แนบด้วย — **ลบไฟล์ก่อนลบแถว** และถ้าลบไฟล์พลาดต้อง throw
  (ลบแถวก่อนแล้วไฟล์ค้าง = ไม่มีใครรู้ว่ามีขยะเข้าถึงได้อยู่)

**🔴 ช่องโหว่ที่เจอระหว่างทางและปิดไปด้วย** — policy เดิม (0010) ให้สมาชิกอ่าน
**ทุกแถว** รวมร่างที่ยังไม่ประกาศ ⇒ แอดมินร่างเรื่องขึ้นราคาไว้ สมาชิกเห็นทันที
(`published_at` มีในตารางตั้งแต่ 0005 แต่ยังไม่เคยถูกใช้เป็นเงื่อนไข)

**การตัดสินใจ**: publish ซ้ำ **ไม่เลื่อน `published_at`** — เวลาที่ประกาศครั้งแรก
คือความจริงที่ต้องคงไว้ · สมาชิกที่เข้าก๊วนทีหลังได้รับตอน publish รอบถัดไป
(dedupe ผูกกับคู่ ประกาศ+ผู้รับ ไม่ใช่ประกาศอย่างเดียว)

---

## WO-3.E: Discovery (pg_trgm) + join request + walk-in ✅ **เสร็จ (15 ส.ค. 2026)**

**Goal**: คนหาก๊วนใกล้ตัวเจอ ขอเข้าก๊วนได้ และแอดมินอนุมัติได้โดยไม่มีทางลัดที่ทำให้ข้อมูลเพี้ยน

**Scope**
- ทำเฉพาะ: หน้าค้นหาก๊วนสาธารณะ (ชื่อ/พื้นที่ ด้วย index pg_trgm ที่มีอยู่แล้ว) · `join_requests` (ขอ/ยกเลิก/อนุมัติ/ปฏิเสธ) · walk-in ผ่าน invite link ที่มีอยู่แล้ว
- ไม่แตะ: แผนที่/พิกัด · แนะนำก๊วนอัตโนมัติ

**Definition of Done**
- 🔴 **ก๊วนที่ `is_public = false` หรือปิด `features.discovery` ต้องไม่โผล่ในผลค้นหาเลย** — เทสต์ยิง action ตรงด้วย ไม่ใช่แค่ UI
- ค้นหาใช้ **pg_trgm** (index มีแล้วใน 0002) ไม่ใช่ `LIKE '%…%'` เปล่า — เทสต์ยืนยันว่าค้นภาษาไทยบางส่วนเจอ
- อนุมัติคำขอ = **DB function เดียว** ที่สร้าง `gang_members` + ปิดคำขอ + เขียน event แบบ atomic
  ⇒ 🔴 ขอซ้ำ/กดอนุมัติสองครั้ง ต้องไม่ได้สมาชิกซ้ำ (partial unique index ที่มีอยู่เป็นด่านจริง)
- คำขอที่ถูกปฏิเสธขอใหม่ได้ · คำขอของก๊วนที่ตัวเองเป็นสมาชิกอยู่แล้วถูกปฏิเสธตั้งแต่ต้น
- แจ้งเตือนแอดมินเมื่อมีคำขอใหม่ ผ่านคิวเดิม + `dedupe_key`

**Forbidden**
- ห้าม `insert into gang_members` จาก server action ตรงๆ (ต้องผ่าน DB function) · ห้ามเปิดเผยก๊วนส่วนตัวผ่าน API ใดๆ

**References**: baseline §โมดูล ข้อ 9 · §ตาราง (`join_requests`) · WO-1.4 (RLS) · ข้อจำกัด 4, 6, 7

**ผลลัพธ์** — migration `0033` (4 ฟังก์ชัน + รัด RLS ของ `join_requests`) ·
`server/actions/discovery.ts` · หน้า `/discover` · หน้า `/gangs/[gangId]/join-requests` ·
สิทธิ์ใหม่ `gang.join_request.manage` (ผูกกับ `features.discovery`) ·
เทสต์ใหม่ 36 ตัว (`tests/discovery/search.test.ts` 12 · `tests/discovery/join-requests.test.ts` 24)

DoD ทั้ง 5 ข้อผ่านจริง:
- 🔴 `is_public = false` **หรือ** ปิด `features.discovery` → ไม่โผล่ในผลค้นหาเลย
  (กรองใน `search_public_gangs()` ซึ่งเป็นทางเดียวที่หน้าจอ/action ใช้ — เทสต์ยิงฟังก์ชันตรง)
- ค้นด้วย **pg_trgm** จริง: `%` (similarity) **คู่กับ** `ilike` ซึ่งวิ่งบน gin_trgm_ops index
  ของ 0002 ทั้งคู่ — มีเทสต์ค้นคำไทยบางส่วน (`บางแค` ใน `ก๊วนแบดบางแคยามเย็น`), เทสต์พิมพ์ผิด
  และเทสต์ `explain` ที่ยืนยันว่า planner ใช้ `gangs_name_trgm_idx` ได้
- อนุมัติ = `decide_join_request()` ใบเดียว (สมาชิก + ปิดคำขอ + event แบบ atomic)
  ⇒ กดซ้ำได้ `INVALID_TRANSITION` · **กดพร้อมกันสองคนสำเร็จใบเดียว** สมาชิกไม่ซ้ำ
- ปฏิเสธแล้วขอใหม่ได้ · เป็นสมาชิกอยู่แล้วขอไม่ได้ (`ALREADY_REGISTERED`)
  · ขอซ้ำระหว่างรอ = คืนใบเดิม ไม่มีแถวใหม่
- แจ้งแอดมินผ่าน `enqueue_notifications()` + `dedupe_key = join_request:<id>:<admin>`
  และแจ้งผลกลับคนขอด้วย `join_request:<id>:decision` (ยิงซ้ำไม่ส่งซ้ำ)

**walk-in**: ตาม scope คือ "ผ่านลิงก์เชิญที่มีอยู่แล้ว" ⇒ **ไม่มีโค้ดใหม่** —
เส้นทาง `/join/[token]` + `GuestJoinForm` ของ WO-2.5 ครอบอยู่แล้ว (ยืนยันว่ายังผ่านเทสต์เดิม)
สิ่งที่ยังไม่มีคือปุ่มลัด "รับ walk-in" ที่หน้างาน — จดไว้ใน `BACKLOG.md`

**🔴 ช่องโหว่ที่เจอระหว่างทางและปิดไปด้วย** — policy ของ `join_requests` (0010) เปิดกว้างสองใบ:
`join_requests_insert_self` ให้ยิงคำขอเข้า**ก๊วนส่วนตัว**ได้ (แค่รู้ id) และตั้ง `status` เองได้
· `join_requests_update_admin` ให้แอดมิน `UPDATE status = 'approved'` ตรงโดย**ไม่มีสมาชิกเกิดขึ้นจริง**
⇒ 0033 ถอน INSERT/UPDATE ของ `authenticated` ออกทั้งคู่ เหลือ `select` อย่างเดียว [D-13]

**การตัดสินใจที่บันทึกไว้**:
- `decide_join_request()` รับ `p_gang_id` เป็น guard — ผูกคำขอกับก๊วนที่ตรวจสิทธิ์มาแล้ว
  **ในธุรกรรมเดียวกัน** (เช็คหลังฟังก์ชันทำงานไม่ทัน สมาชิกถูกสร้างไปแล้ว)
- `gangs_select_public` (0010) **ไม่แตะ** — "ก๊วนเปิดเผยตัวตน" กับ "โผล่ในผลค้นหา" เป็นคนละเรื่อง
  ลิงก์ตรงยังต้องเข้าได้ ⇒ `features.discovery` บังคับที่ฟังก์ชันค้นหาที่เดียว
- 🔴 แต่ policy นั้นเปิดทั้ง**แถว** ⇒ `anon` อ่าน `promptpay_id` ของก๊วน public ได้
  (ยืนยันของจริงแล้ว) — **นอก scope ใบนี้ จดไว้ใน `BACKLOG.md` พร้อมสามทางเลือก ต้องตัดสินก่อนเปิดใช้จริง**

---

## WO-3.F: Landing page + Phase 3 checkpoint ✅ **เสร็จ (16 ส.ค. 2026)**

**Goal**: มีหน้าแรกที่คนนอกเข้าใจว่าระบบนี้ทำอะไร และเปิดใช้งานจริงได้

**Scope**
- ทำเฉพาะ: หน้าแรก (static/ISR) · ตัวเลขระดับแพลตฟอร์มจาก `daily_metrics` · ทางเข้า sign-in / ค้นหาก๊วน
- ไม่แตะ: บล็อก/SEO เชิงลึก · หลายภาษา

**Definition of Done**
- หน้าแรกเป็น **static/ISR** ไม่ใช่ `force-dynamic` — ตรวจจากผลลัพธ์ `npm run build`
- 🔴 ตัวเลขบนหน้าแรกอ่านจาก `daily_metrics` (rollup) เท่านั้น — ไม่ query ตารางธุรกรรมสด
- ไม่มีข้อมูลของก๊วนส่วนตัวรั่วออกหน้าแรก
- **E2E ของ Phase 3**: rollup → รายงาน reconcile → ประกาศ publish (ไม่ส่งซ้ำ) → ค้นหา + ขอเข้าก๊วน + อนุมัติ
  (บวกเส้นเต็มของ MVP-0 และ Phase 2.5 ที่ต้องยังผ่าน)
- แล้ว tag **`v0.3.0`** ตาม §Release Versioning

**Forbidden**
- ห้ามทำหน้าแรกเป็น dynamic เพื่อความสะดวก · ห้ามข้าม E2E ของ Phase ก่อนหน้า

**References**: baseline §Roadmap Phase 3 · §Verification · §Release Versioning

**ผลลัพธ์** — **ไม่มี migration ใหม่** (อ่าน `daily_metrics` ที่ 0030 สร้างไว้แล้ว) ·
`domain/reports/platform.ts` (pure) · `server/landing/metrics.ts` · หน้าแรกใหม่ที่ `app/page.tsx` ·
เทสต์ใหม่ 11 ตัว (`tests/landing/landing.test.ts` 10 + `tests/e2e/phase3-full-path.test.ts` 1)

DoD ทั้ง 5 ข้อผ่านจริง:
- หน้าแรกเป็น **static + ISR** — ผลลัพธ์ `npm run build`: `○ /` · Revalidate `1h` · Expire `1y`
  (ไม่ใช่ `ƒ`) · มีเทสต์กันไม่ให้ใครเผลอใส่ `force-dynamic` / `cookies()` / client ที่ผูก session
- 🔴 ตัวเลขอ่านจาก `daily_metrics` เท่านั้น ผ่าน `platformHighlights()` —
  เทสต์ตรวจว่าไฟล์หน้าแรกไม่มี query ตารางธุรกรรมสด และ E2E ตรวจว่าเลขตรงกับ rollup จริง
- ไม่มีข้อมูลก๊วนใดก๊วนหนึ่งบนหน้าแรกเลย (ไม่มีชื่อก๊วน/รายชื่อคน — คนที่อยากเห็นก๊วนไป `/discover`
  ซึ่งกรอง `is_public` + `features.discovery` ให้แล้ว) · **ไม่โชว์ `revenue`** ของแพลตฟอร์มโดยตั้งใจ
- **E2E ของ Phase 3** (`tests/e2e/phase3-full-path.test.ts`): ปิดรอบจริง → rollup →
  รายงาน reconcile (952 − 950 = เศษ 2 บาท · เก็บได้จริง 238 ≠ เรียกเก็บ 952) →
  ประกาศ publish + กดซ้ำไม่ส่งซ้ำ → ค้นหาก๊วน + ขอเข้าก๊วน + อนุมัติ + ปิด discovery แล้วหายจากผลค้นหา
  · เส้นเต็มของ MVP-0 และ Phase 2.5 ยังผ่านครบใน `npm test` ชุดเดียวกัน (571 เทสต์ / 55 ไฟล์)
- tag **`v0.3.0`** ตาม §Release Versioning

**การตัดสินใจที่บันทึกไว้**: `platformHighlights()` คืน `null` แทนที่จะ throw เมื่ออ่าน DB ไม่ได้
— หน้าแรกถูก prerender ตอน build ซึ่งอาจไม่มี env ของ Supabase ⇒ ปล่อย throw = build ทั้งแอปพัง
เพราะตัวเลขประดับหน้าแรก · ไม่ได้กลืนเงียบ (log พร้อมสาเหตุตาม CLAUDE.md §5) และมีเทสต์คุมพฤติกรรมนี้

---

## WO-3.G: ปิดการอ่านแถวก๊วน public ของคนนอก (ADR-007) ✅ **เสร็จ (16 ส.ค. 2026)**

> ใบแทรกหลัง `v0.3.0` — ปิดช่องโหว่ที่ WO-3.E เจอแล้วจดไว้ว่า "ต้องตัดสินก่อนเปิด discovery จริง"

**Goal**: ก๊วนที่เปิดสาธารณะต้องค้นเจอได้ โดยไม่เปิดคอลัมน์ลับของก๊วนให้ใครก็ได้อ่าน

**Scope**
- ทำเฉพาะ: ถอด policy `gangs_select_public` + `revoke select on gangs from anon` + ADR + เทสต์
- ไม่แตะ: การย้าย `promptpay_id` ออกไปตาราง server-only (ทางเลือก ค — จดไว้ใน `BACKLOG.md`)

**Definition of Done**
- 🔴 `anon` แตะตาราง `gangs` ไม่ได้เลย · ผู้ใช้ที่ล็อกอินแต่ไม่ใช่สมาชิกอ่านก๊วน public ไม่ได้
- 🔴 `promptpay_id` ของก๊วนสาธารณะไม่หลุดถึงคนนอกอีก — เทสต์ยิงเส้นทางที่เคยรั่วตรงๆ
- สมาชิก/แอดมินยังใช้งานได้เหมือนเดิม (ไม่ได้ปิดเกินจนแอปพัง)
- discovery ยังทำงาน — `search_public_gangs()` ยังคืนก๊วนนั้น

**ผลลัพธ์** — **ADR-007** ต่อท้าย baseline · migration `0034` ·
เทสต์ใหม่ 6 ตัว (`tests/rls/public-gang-exposure.test.ts`) ·
อัปเดตเทสต์เก่าสองที่ที่ยืนยันพฤติกรรมเดิม (`grant-matrix` → `gangs.anon = []` ·
`write-guards` → anon แตะ `gangs` ไม่ได้แล้ว)

DoD ทั้ง 4 ข้อผ่านจริง · cloud **34/34** (ตรวจของจริง: เหลือ 3 policy บน `gangs`
ไม่มี `gangs_select_public` · `anon` ไม่มี grant ใดๆ บนตารางนั้น)

⚠️ **ผลที่ใบถัดไปต้องรู้**: หน้าโปรไฟล์ก๊วนสาธารณะในอนาคตต้องเพิ่ม DB function
ที่ประกาศคอลัมน์ที่คืนไว้ชัด ❌ ห้ามเปิด policy ให้อ่านตาราง `gangs` ตรงกลับมาอีก


---

# Phase 4 — LINE (WO-4.A … WO-4.F)

> แตกใบเมื่อ 16 ส.ค. 2026 หลังปิด Phase 3 (`v0.3.0`) + ใบแทรก `WO-3.G` (`v0.3.1`)
> baseline §Roadmap: **Vault + config UI + webhook ต่อก๊วน → worker เพิ่ม channel `line` +
> quota counter → LIFF → LINE Login link**
>
> ตารางของ Phase นี้ **มีอยู่แล้วตั้งแต่ migration `0006`** (`gang_line_configs`,
> `member_line_links`) และ `notification_logs` (`0005`) ⇒ ❌ **ห้ามเพิ่มตารางใหม่นอก baseline**

⇒ ใบของ Phase 4 ใช้ **ตัวอักษร** ต่อจาก Phase 3: `WO-4.A` … `WO-4.F`

## 🔴 ข้อจำกัดจาก Phase ก่อนหน้าที่ทุกใบต้องยึด

| # | ข้อจำกัด | ทำผิดแล้วเกิดอะไร |
|---|---|---|
| 1 | **ห้ามสร้าง worker/คิวใหม่** — ใช้ `enqueue_notifications()` + `claim_notifications()` + `dispatchNotifications()` เดิม (มี `case 'line'` รออยู่แล้วใน `server/cron/notifications.ts`) | มีสองทางส่ง แล้ว retry/backoff/dedupe คนละแบบ — LINE ล่มทีเดียวเห็นผลสองแบบ |
| 2 | 🔴 **`dedupe_key` เป็น unique ทั้งตาราง** ⇒ fan-out หลาย channel ต้องมี channel อยู่ในคีย์ · **ห้ามเปลี่ยนรูปคีย์ของ `in_app` ที่ส่งไปแล้ว** | เปลี่ยนรูปคีย์เก่า = ของที่เคยกันซ้ำไม่ตรงกันอีก ⇒ ผู้ใช้โดนยิงซ้ำทั้งระบบในรอบเดียว |
| 3 | **`gang_line_configs` เป็น server-only** — `anon`/`authenticated` ไม่มีสิทธิ์อะไรเลย (มี `tests/rls/grant-matrix.test.ts` คุม) | เผลอ grant = credentials ของก๊วนหลุดถึง browser |
| 4 | ❌ **ห้ามเก็บ plaintext token/secret ใน DB** — เก็บ **Vault secret id** เท่านั้น (fallback AES-256-GCM ใช้ key จาก **env** ห้ามอยู่ใน DB) | secret หลุดพร้อม backup ฐานข้อมูล และ rotate ไม่ได้ |
| 5 | **`features.line` ต้อง enforce ฝั่ง server** (`can()` + จุดส่งจริง + webhook) | ปิด flag แล้วยังมีข้อความออก = ก๊วนคุมช่องทางของตัวเองไม่ได้ |
| 6 | **in-app ยังเป็นช่องทางพื้นฐานของทุกก๊วน** — LINE เป็น channel **เสริม** | ก๊วนที่ไม่ได้ต่อ LINE (หรือคนที่บล็อก OA) จะไม่ได้รับอะไรเลย |
| 7 | **โควต้านับจาก `notification_logs`** (`channel = 'line'` ต่อก๊วนต่อเดือน) — ❌ ไม่ตั้งตารางสรุปใหม่ | สองแหล่งความจริงของ "ส่งไปกี่ข้อความ" แล้วเลขบนหน้าตั้งค่ากับของจริงไม่ตรงกัน |
| 8 | **webhook ต้อง verify signature ทุก request** (baseline §Security Checklist) และ **ตอบเร็ว** — งานหนักเข้าคิว | LINE retry/ตัดการเชื่อมต่อ และ endpoint กลายเป็นช่องให้ใครก็ยิงข้อมูลปลอมเข้าระบบ |
| 9 | **[ADR-007]** คนนอกอ่านตาราง `gangs` ตรงไม่ได้แล้ว | เส้นทางที่ทำงานแทนผู้ใช้ที่ยังไม่ล็อกอิน (webhook / LIFF / LINE Login) ต้องผ่าน DB function หรือ admin client เสมอ |
| 10 | **PostgREST คืน `numeric` เป็น JSON number** ⇒ ผ่าน `moneyFromDb()` ก่อนเข้า `domain/` | จอ LIFF ที่โชว์ยอดค้างจะพังตอน runtime — เทสต์ระดับ DB จับไม่ได้ |

## ลำดับที่เลือก (ตาม baseline และมีเหตุผลของมัน)

`config → webhook → worker → login → LIFF → checkpoint`

- **config ต้องมาก่อน webhook** — ไม่มี channel secret ของก๊วนนั้นก็ verify signature ไม่ได้เลย
- **webhook ต้องมาก่อน worker** — ต้องรู้ `line_user_id` ปลายทาง (และรู้ว่าใคร **บล็อก OA** ไปแล้ว)
  ก่อนถึงจะ "ส่งจริง" ได้ · ถ้าทำ worker ก่อน จะได้ `failed` ทุกแถวโดยไม่มีทางแก้
- **LINE Login มาก่อน LIFF** — LIFF ที่ยังผูกบัญชีไม่ได้จะกลายเป็นแค่เว็บในกรอบ LINE
- checkpoint ปิดท้ายพร้อม tag `v0.4.0` ตาม §Release Versioning

## ⚠️ ของจริงที่ตรวจไว้แล้วก่อนแตกใบ (อย่าเสียเวลาค้นซ้ำ)

- **Vault ใช้ได้บน local** — `supabase_vault` ติดตั้งอยู่ พร้อม `vault.create_secret()` /
  `vault.update_secret()` และ view `vault.decrypted_secrets` (อ่านได้เฉพาะฝั่ง service_role)
  ⇒ ทางหลักของ baseline ทำได้จริง **แต่ต้องยืนยันบน cloud ซ้ำใน `WO-4.A` ก่อนเขียนโค้ด**
- **`@line/bot-sdk` ยังไม่ได้ติดตั้ง** — baseline ระบุไว้ในลิสต์ไลบรารีแต่ยังไม่มีใน `package.json`
  · Messaging API เรียกผ่าน `fetch` ได้ตรงๆ และ verify signature = HMAC-SHA256 + base64
  ด้วย `node:crypto` ⇒ **ให้ `WO-4.B` ตัดสินว่าคุ้มจะเพิ่ม dep ไหม แล้วบันทึกเหตุผล** (ไม่ใช่เพิ่มเพราะแผนเขียนไว้)
- **`enqueue_notifications()` (`0029`) ฮาร์ดโค้ด `channel = 'in_app'`** ⇒ การ fan-out ไป `line`
  เป็นงานที่ต้องแก้ฟังก์ชันนี้ (migration ใหม่) ไม่ใช่แก้ที่ผู้เรียกทีละที่
- **`deliver()` ใน `server/cron/notifications.ts` มี `case 'line'` ที่คืน error ชัดเจนอยู่แล้ว**
  ⇒ จุดเสียบของ `WO-4.C` อยู่ตรงนั้นจุดเดียว

---

## WO-4.A: Vault + หน้าตั้งค่า LINE ต่อก๊วน ✅ **เสร็จ (16 ส.ค. 2026)**

**Goal**: แอดมินต่อ LINE OA ของก๊วนตัวเองได้ โดย credentials ไม่เคยถูกเก็บเป็น plaintext และไม่เคยกลับมาถึง browser

**Scope**
- ทำเฉพาะ: เก็บ/หมุน channel access token + channel secret + `liff_id` ผ่าน **Vault** (`gang_line_configs` เก็บแค่ secret id) · หน้าตั้งค่า LINE ในหน้าตั้งค่าก๊วน · เปิด/ปิด `features.line` · ปุ่ม "ทดสอบการเชื่อมต่อ" ที่เรียก LINE API จริงหนึ่งครั้ง
- ไม่แตะ: webhook (`WO-4.B`) · การส่งข้อความจากคิว (`WO-4.C`)

**Definition of Done**
- 🔴 **ไม่มี plaintext token/secret ใน DB** — เทสต์ query ตารางแล้วยืนยันว่าเก็บเฉพาะ secret id
  และ `grep` ยืนยันว่าไม่มี token ในโค้ด (baseline §Security Checklist)
- 🔴 **ค่าที่ตั้งไปแล้วอ่านกลับมาที่ browser ไม่ได้** — หน้าตั้งค่าแสดงได้แค่ "ตั้งค่าแล้ว/ยังไม่ได้ตั้ง"
  + 4 ตัวท้าย (masked) ⇒ server action ห้ามคืนค่าเต็มไม่ว่ากรณีใด
- สมาชิกทั่วไป (และแอดมินก๊วนอื่น) อ่าน `gang_line_configs` ไม่ได้ — **เทสต์ระดับ RLS/GRANT**
- หมุน token ใหม่แล้วของเดิมถูกแทนที่ (`vault.update_secret`) ไม่ใช่ทิ้ง secret ค้างไว้ในโครงสร้าง
- เปิด `features.line` ไม่ได้ถ้ายังตั้ง credentials ไม่ครบ — ตอบ `VALIDATION_ERROR` ไม่ใช่เปิดแล้วไปพังตอนส่ง
- ยืนยัน Vault บน **cloud** ของจริง (ไม่เชื่อผลจาก local อย่างเดียว) — ถ้าใช้ไม่ได้ ให้ใช้ fallback
  AES-256-GCM ตาม baseline **แล้วบันทึกเป็น deviation** (key จาก env เท่านั้น)

**Forbidden**
- ❌ ห้าม log token/secret แม้บางส่วน · ❌ ห้ามส่งค่ากลับ client · ❌ ห้ามเก็บ key ของ fallback ใน DB
- ❌ ห้าม grant `gang_line_configs` ให้ `anon`/`authenticated`

**References**: baseline §ตาราง (LINE) · §การตัดสินใจสำคัญ (เข้ารหัส LINE credentials) · §Security Checklist · ข้อจำกัด 3, 4, 5

**ผลลัพธ์** — migration `0035` (6 ฟังก์ชัน) · `lib/line/client.ts` · `server/actions/line.ts` ·
`features/line/LineSettingsPanel.tsx` (ในหน้าตั้งค่าก๊วน) · สิทธิ์ใหม่ `gang.line.manage` ·
เทสต์ใหม่ 14 ตัว (`tests/line/credentials.test.ts`)

DoD ทั้ง 6 ข้อผ่านจริง:
- 🔴 **ไม่มี plaintext ใน DB** — เทสต์ dump ทั้งแถวเป็น jsonb แล้วยืนยันว่าไม่มีค่า token/secret
  · `channel_access_token_ref` เป็น uuid ของ Vault · event log ก็ไม่มีค่าติดไปด้วย
- 🔴 **อ่านกลับมาที่ browser ไม่ได้** — หน้าจอใช้ `gang_line_status()` ที่คืนแค่ "มี/ไม่มี" + **4 ตัวท้าย**
  (ปิดบังตั้งแต่ใน SQL) · ฟังก์ชันที่คืน plaintext มีตัวเดียวและ grant ให้ `service_role` เท่านั้น
- สมาชิก/แอดมินของก๊วน **แตะตาราง `gang_line_configs` ไม่ได้เลย** (เทสต์ระดับ GRANT) ·
  ผู้ใช้เรียกฟังก์ชัน LINE ทั้งสี่ตัวตรงไม่ได้
- หมุน token → **ใช้ secret id เดิม** (`vault.update_secret`) ไม่ทิ้งใบเก่าค้าง · ถอด LINE ออก = ลบ secret ใน Vault ด้วย
- เปิด `features.line` ไม่ได้ถ้ายังไม่ครบ → `VALIDATION_ERROR` · และถ้า credential ถูกล้างทั้งที่เปิดอยู่
  ระบบ **ปิดสวิตช์ให้เองทันที** (ทั้ง `is_enabled` และ `gangs.features.line` ในธุรกรรมเดียว)
- ✅ **ยืนยัน Vault บน cloud ของจริงแล้ว** (`supabase_vault 0.3.1` + create → decrypt round-trip ผ่าน)
  ⇒ **ไม่ต้องใช้ fallback AES-256-GCM** ไม่มี deviation

**การตัดสินใจที่บันทึกไว้**
- ❌ **ไม่ติดตั้ง `@line/bot-sdk`** ทั้งที่ baseline ระบุไว้ในลิสต์ไลบรารี — สิ่งที่ใช้จริงคือ HTTP
  ไม่กี่เส้น (`/v2/bot/info` ที่นี่ · push ใน WO-4.C) และ verify signature ที่เป็น HMAC-SHA256
  ของ `node:crypto` ⇒ ไม่คุ้มกับ dependency ใหม่ (โปรเจกต์มี `npm audit` ค้างอยู่แล้ว)
  · ทบทวนใหม่ได้ถ้าวันหนึ่งต้องใช้ Flex builder / webhook parser เต็มรูป — บันทึกไว้ใน `lib/line/client.ts`
- `gang.line.manage` **จงใจไม่ผูกกับ `features.line`** — ต้องตั้ง credentials ก่อนถึงจะเปิด flag ได้
  ถ้า gate ด้วย flag ตัวเองจะกลายเป็นวงกลมที่ไม่มีใครเปิดได้เลย (มีเทสต์คุม)
- ปุ่ม "ทดสอบการเชื่อมต่อ" ใช้ **GET `/v2/bot/info`** ที่ไม่ส่งข้อความหาใคร ⇒ กดกี่ครั้งก็ไม่กินโควต้า

---

## WO-4.B: Webhook ต่อก๊วน + ผูกบัญชี LINE เข้ากับสมาชิก ✅ **เสร็จ (16 ส.ค. 2026)**

**Goal**: ก๊วนรับ event จาก LINE OA ของตัวเองได้อย่างปลอดภัย และรู้ว่า LINE user คนไหนคือสมาชิกคนไหน

**Scope**
- ทำเฉพาะ: `/api/line/webhook/[gangId]` (verify signature ด้วย secret ของก๊วนนั้น) · จัดการ event `follow` / `unfollow` / `message` · ผูก/ยกเลิกผูกบัญชี (`member_line_links`) · ตอบกลับข้อความสั้นๆ
- ไม่แตะ: การส่งข้อความจากคิว (`WO-4.C`) · LIFF (`WO-4.E`)

**Definition of Done**
- 🔴 **signature ไม่ถูก = 401 ทุกกรณี** และต้อง verify จาก **raw body** (อ่านด้วย `req.text()`
  ก่อน parse JSON) — เทสต์ทั้งเคสถูก/ผิด/ไม่มี header/body ถูกแก้ระหว่างทาง
- 🔴 **ก๊วนที่ปิด `features.line` หรือยังไม่ตั้ง config → ปฏิเสธ** ไม่ใช่รับไว้เงียบๆ
- webhook ของก๊วน A ใช้ secret ของก๊วน B ไม่ผ่าน — เทสต์ข้ามก๊วน
- ตอบ 200 ให้ LINE **เร็ว** — งานที่ช้าเข้าคิวเดิม (ข้อจำกัด 1, 8) ⇒ ห้ามยิง API ภายนอกใน request นั้น
- `unfollow` (บล็อก OA) ทำให้ **หยุดส่ง LINE ให้คนนั้น** — worker ต้องไม่พยายามส่งซ้ำจนกลายเป็น `failed` รัวๆ
- ผูกบัญชีซ้ำ / ผูกข้ามก๊วน ไม่ทำให้ได้แถวซ้ำ (partial unique ของ `0006` เป็นด่านจริง)
- ❗ **ห้ามเพิ่มตารางเก็บรหัสผูกบัญชี** — ใช้ nonce แบบ **stateless** (เซ็นด้วย key จาก env + หมดอายุสั้น)
  หรือกลไก Account Link ของ LINE เอง

**Forbidden**
- ❌ ห้าม parse JSON ก่อน verify · ❌ ห้ามเชื่อ `userId` ใน payload โดยไม่ผ่าน signature
- ❌ ห้าม log `line_user_id` คู่กับข้อมูลส่วนตัวอื่นเกินจำเป็น · ❌ ห้ามเพิ่มตารางนอก baseline

**References**: baseline §ตาราง (`member_line_links`) · §Security Checklist · WO-1.5 (`CRON_SECRET` timing-safe เป็นแบบอย่างของการ verify) · ข้อจำกัด 5, 8, 9

**ผลลัพธ์** — migration `0036` (คอลัมน์ `blocked_at` + 3 ฟังก์ชัน) · `lib/line/signature.ts` ·
`lib/line/link-code.ts` · `server/line/webhook.ts` · `app/api/line/webhook/[gangId]/route.ts` ·
หน้า `/gangs/[gangId]/line` (ฝั่งสมาชิก) · สิทธิ์ใหม่ `line.link.self` (ผูกกับ `features.line`) ·
env ใหม่ `LINE_LINK_SECRET` · เทสต์ใหม่ 26 ตัว (`tests/line/webhook.test.ts`)

DoD ทั้ง 7 ข้อผ่านจริง:
- 🔴 ลายเซ็นผิด/ไม่มี/body ถูกแก้ → **401 ทุกกรณี** · verify จาก **raw body** (route อ่านด้วย `.text()`
  ❌ ไม่มี `request.json()` ในเส้นทางนี้เลย) · มีเทสต์พิสูจน์ว่า **parse แล้ว stringify ใหม่ลายเซ็นไม่ผ่าน**
- 🔴 ปิด `features.line` → 403 แม้ลายเซ็นถูก · ยังไม่ตั้งค่า → 404 (ไม่มี secret ให้ verify)
- secret ของก๊วน B ใช้กับ webhook ก๊วน A ไม่ผ่าน (เทสต์ข้ามก๊วน)
- ตอบ 200 เร็ว — ในเส้นทางนี้ **ไม่มีการยิง API ภายนอกเลย** (มีแต่ verify + เขียน DB)
- `unfollow` → ตั้ง `blocked_at` (ไม่ลบความสัมพันธ์ทิ้ง) · `follow` → ปลดให้เอง
  ⇒ WO-4.C ต้องกรอง `blocked_at is null` ตอน fan-out
- LINE ใบเดียวผูกสองคนในก๊วนเดียวกันไม่ได้ (`ALREADY_REGISTERED`) · สมาชิกเปลี่ยนบัญชี LINE ได้
  โดยแถวเดิมถูกย้าย ไม่ใช่เพิ่มแถวใหม่ · คนที่ไม่ใช่สมาชิกผูกไม่ได้
- ❗ **ไม่มีตารางรหัสผูกบัญชี** — รหัสเป็น HMAC แบบ stateless ที่พก `userId` + วันหมดอายุมาเอง
  และ **ผูก `gangId` ไว้ในลายเซ็น** ⇒ รหัสของก๊วนหนึ่งใช้กับอีกก๊วนไม่ได้ (มีเทสต์)

**⚠️ Deviation ที่บันทึกไว้ — ใบนี้ยังไม่ตอบกลับข้อความในแชต**
scope เดิมเขียนว่า "ตอบกลับข้อความสั้นๆ" แต่การตอบต้องเรียก **reply API ของ LINE**
ซึ่งขัด DoD ข้อ "ตอบ 200 เร็ว — ห้ามยิง API ภายนอกใน request นั้น" ของใบเดียวกัน
⇒ **เลื่อนการตอบกลับไป `WO-4.C`** ที่มีทางส่งผ่านคิวเดิมแล้ว (ห้ามยิงตรงจาก webhook)
· ระหว่างนี้ผู้ใช้ดูผลที่หน้า `/gangs/[gangId]/line` (ปุ่ม "ตรวจสถานะ") — เขียนไว้ในหน้าจอแล้ว
· `WO-4.D` (LINE Login) จะทำให้ไม่ต้องคัดลอกรหัสเลย

**การตัดสินใจที่บันทึกไว้**
- เพิ่มคอลัมน์ `blocked_at` แทนการ **ลบแถว** ตอน `unfollow` — ถ้าลบทิ้ง ผู้ใช้ที่กด follow กลับ
  ต้องผูกบัญชีใหม่ทั้งที่ไม่ได้ตั้งใจเลิกผูก (เป็นการเพิ่ม **คอลัมน์** ไม่ใช่ตาราง จึงไม่ขัดกติกา Phase 4)
- verify ลายเซ็น **ก่อน** ตรวจ flag เสมอ — ไม่งั้น endpoint จะกลายเป็นเครื่องมือบอกสถานะ
  `features.line` ของก๊วนให้ใครก็ได้ที่ยิงมั่ว

---

## WO-4.C: worker ส่ง LINE จริง + fan-out + โควต้า ✅ **เสร็จ (16 ส.ค. 2026)**

**Goal**: ข้อความที่ระบบมีอยู่แล้ว (เปิดรอบ · คิวถึง · เตือนจ่าย · ประกาศ) ไปถึง LINE ของสมาชิกที่ผูกบัญชีไว้ โดยไม่ส่งซ้ำและไม่ทะลุโควต้า

**Scope**
- ทำเฉพาะ: fan-out ใน `enqueue_notifications()` (migration ใหม่) ให้สร้างแถว `line` เพิ่มสำหรับก๊วนที่เปิด flag + ผู้รับที่ผูกบัญชีแล้ว · `deliver()` case `line` ยิง Messaging API จริง · นับ/บังคับโควต้าต่อก๊วนต่อเดือน · usage counter ในหน้าตั้งค่า
- ไม่แตะ: ข้อความรูปแบบ Flex/rich menu (ยังไม่อยู่ใน baseline) · LIFF

**Definition of Done**
- 🔴 **ไม่ส่งซ้ำ**: `dedupe_key` ของ `line` แยกจาก `in_app` (ข้อจำกัด 2) และคีย์เดิมของ `in_app`
  **ไม่เปลี่ยนรูป** — เทสต์ยืนยันว่าของที่เคยส่งแล้วไม่ถูกยิงใหม่หลัง migration
- 🔴 ก๊วนที่ปิด `features.line` **ไม่มีแถว `line` เกิดขึ้นเลย** · คนที่ยังไม่ผูกบัญชี/บล็อก OA ก็ไม่มี
- in-app ยังได้เหมือนเดิมทุกกรณี (ข้อจำกัด 6) — เทสต์เทียบจำนวนแถวสองช่องทาง
- LINE ตอบ error → เข้า backoff เดิม (`5 นาที → 15 นาที → 1 ชม.` แล้ว `failed`) ไม่ใช่ mark sent หลอกๆ
  · error ของก๊วนหนึ่ง **ไม่ทำให้ทั้งรอบล้ม**
- 🔴 **เกินโควต้าเดือนนั้น = ไม่ยิงเพิ่ม** และบันทึกเหตุผลให้เห็นในหน้าตั้งค่า (นับจาก `notification_logs` เท่านั้น)
- ปุ่ม "ส่งข้อความทดสอบ" ของแอดมินนับรวมโควต้าด้วย (ไม่งั้นตัวเลขโกหก)

**Forbidden**
- ❌ ห้ามสร้าง worker/คิว/ตารางสรุปใหม่ · ❌ ห้าม insert `notifications` ตรงสำหรับงานที่ต้องกันซ้ำ
- ❌ ห้ามใส่ยอดเงินรายคนลงข้อความกลุ่ม (ข้อความ LINE ส่งเข้าแชตส่วนตัวเท่านั้น)

**References**: baseline §Roadmap Phase 4 · §การตัดสินใจสำคัญ (โควต้า LINE OA · worker ห้ามส่งซ้ำ) · WO-2.5-G (dedupe) · WO-2.10 (worker) · ข้อจำกัด 1, 2, 6, 7

**ผลลัพธ์** — migration `0037` (`monthly_quota` + 3 ฟังก์ชัน + `enqueue_notifications` เวอร์ชัน fan-out) ·
`domain/notifications/line-message.ts` (pure) · `pushTextMessage()` ใน `lib/line/client.ts` ·
`deliverLine()` ใน `server/cron/notifications.ts` · โควต้า + ปุ่มทดสอบในหน้าตั้งค่า ·
เทสต์ใหม่ 20 ตัว (`tests/line/fanout.test.ts`)

DoD ทั้ง 6 ข้อผ่านจริง:
- 🔴 **ไม่ส่งซ้ำ** — `in_app` ใช้คีย์เดิมเป๊ะ · `line` = `<คีย์เดิม>:line`
  ⇒ มีเทสต์ที่ enqueue งานเดิมซ้ำหลังเปิด LINE แล้วได้ **เฉพาะแถว `line` ใบใหม่**
  (`in_app` ที่เคยส่งแล้วไม่ถูกยิงใหม่แม้แต่ใบเดียว)
- 🔴 ปิด `features.line` / ยังไม่ผูกบัญชี / บล็อก OA / เกินโควต้า → **ไม่มีแถว `line` เกิดเลย**
- in-app ยังได้เหมือนเดิมทุกกรณี (เทสต์เทียบจำนวนแถวสองช่องทางในทุกเคส)
- LINE ตอบ error → `pushTextMessage()` โยน ⇒ เข้า backoff เดิม (5น/15น/1ชม → `failed`)
  · `deliver()` ห่อ try/catch ต่อแถวอยู่แล้ว ⇒ ก๊วนหนึ่งพังไม่ทำให้ทั้งรอบล้ม
  · worker ตรวจสถานะปลายทาง **ซ้ำอีกรอบตอนจะส่งจริง** (ผู้ใช้อาจบล็อกหลังเข้าคิวไปแล้ว)
- 🔴 โควต้านับจาก `notification_logs` **ที่เดียว** และนับเฉพาะ `success = true`
  ⇒ ส่งไม่สำเร็จไม่กินโควต้า · หน้าตั้งค่าโชว์ "ใช้ไป X จาก Y" + เตือนเมื่อเต็ม + ตั้งเพดานเองได้
  (default 200/เดือน ตาม free tier · `null` = ไม่จำกัด)
- ปุ่ม "ส่งข้อความทดสอบ" เดินผ่าน **คิวและ worker ตัวเดิมทุกขั้น** (enqueue → `dispatchNotifications()`)
  ⇒ นับรวมโควต้าจริง · ❌ ไม่มีเส้นส่งที่สอง (ถ้าเขียนเส้นแยก ตัวเลขบนหน้าจอจะโกหกทันที)

**✅ ปิดของที่ค้างจาก WO-4.B** — ข้อความ "ผูกบัญชีเรียบร้อยแล้ว" ถูกส่งแล้ว โดย webhook
**เข้าคิว** ผ่าน `enqueue_notifications()` (dedupe ผูกกับ ก๊วน+ผู้ใช้+บัญชี LINE)
❌ ไม่เรียก reply API ตรงจาก webhook ⇒ ยังตอบ 200 ให้ LINE ได้เร็วเหมือนเดิม

**การตัดสินใจที่บันทึกไว้**
- โควต้าเป็น **คอลัมน์ `monthly_quota` ต่อก๊วน** (additive) ไม่ใช่ค่าคงที่ในโค้ด —
  ก๊วนที่อัปเกรดแพ็กเกจ LINE ตั้งเองได้ · `null` = ไม่จำกัด
- ตัดแถว `line` ตั้งแต่ตอน **fan-out** เมื่อเกินโควต้า แทนที่จะเข้าคิวแล้วปล่อยให้ fail
  ⇒ ไม่มีแถว `failed` ปลอมๆ ให้ไล่ดู และ in-app ยังถึงผู้ใช้ตามปกติ
- ข้อความ LINE ใช้ **whitelist ต่อ event type** (เหมือน timeline ของ WO-3.C) ⇒ event ใหม่ที่ลืม
  มาเพิ่มจะได้ข้อความกลางๆ **ไม่ใช่ payload หลุดเข้าแชต** · และ ❌ ไม่มีตัวเลขเงินในข้อความเลย

---

## WO-4.D: LINE Login — ผูกบัญชีโดยไม่ต้องพิมพ์รหัส ✅ **เสร็จ (16 ส.ค. 2026)**

**Goal**: สมาชิกกดลิงก์เดียวแล้วบัญชี LINE ผูกกับบัญชีในระบบได้เอง

**Scope**
- ทำเฉพาะ: LINE Login (OAuth) + callback ที่ผูก `line_user_id` เข้ากับผู้ใช้ที่ล็อกอินอยู่ · ปุ่ม "ผูกบัญชี LINE" ในหน้าโปรไฟล์/ตั้งค่าก๊วน · ยกเลิกการผูก
- ไม่แตะ: ใช้ LINE เป็นวิธี **เข้าสู่ระบบ** ของแอป (baseline ไม่ได้สั่ง และจะกลายเป็น auth ชั้นที่สอง)

**Definition of Done**
- 🔴 **มี `state` กัน CSRF และตรวจ `nonce`** — callback ที่ไม่มี/ผิด ต้องปฏิเสธ (เทสต์)
- ผูกได้เฉพาะกับ **ผู้ใช้ที่ล็อกอินอยู่** — ยิง callback ตรงโดยไม่มี session ต้องไม่ผูกให้ใคร
- `line_user_id` เดียวผูกได้กับบัญชีเดียวต่อก๊วน — ชนแล้วตอบ `ALREADY_REGISTERED` ไม่ใช่แย่งของเดิม
- ยกเลิกผูกแล้วต้อง **หยุดได้รับ LINE ทันที** (แถวที่ยังค้างในคิวต้องไม่ถูกส่ง)
- ❗ ห้ามเพิ่มตาราง — `state`/`nonce` เป็น cookie httpOnly หรือค่าที่เซ็นด้วย key จาก env

**Forbidden**
- ❌ ห้ามผูกจาก `line_user_id` ที่ client ส่งมาเอง · ❌ ห้าม log id token
- ❌ ห้ามให้ LINE Login ข้ามขั้นตอน auth ของ Supabase

**References**: baseline §Roadmap Phase 4 (LINE Login link) · §ตาราง (`member_line_links`) · WO-2.2 (open redirect guard — `lib/url/safe-next.ts`) · ข้อจำกัด 5, 9

**ผลลัพธ์** — migration `0038` (2 คอลัมน์ + 3 ฟังก์ชัน + `unlink_line_account` เวอร์ชันใหม่) ·
`lib/line/login-state.ts` · `exchangeLoginCode()`/`loginAuthorizeUrl()` ใน `lib/line/client.ts` ·
`server/line/login.ts` · `server/line/link.ts` (เส้นทางผูกบัญชีร่วมของ 4.B/4.D) ·
`app/api/line/login/callback/route.ts` · ปุ่ม "ผูกบัญชีด้วย LINE" + ช่องตั้งค่า Login channel ·
เทสต์ใหม่ 20 ตัว (`tests/line/login.test.ts`)

DoD ทั้ง 5 ข้อผ่านจริง:
- 🔴 `state` เซ็นด้วย HMAC (พก gangId/userId/nonce/วันหมดอายุมาเอง) **และ** `nonce` ต้องตรงกับ
  **cookie httpOnly** ของเบราว์เซอร์นั้น ⇒ state ที่ถูกแก้/หมดอายุ/ไม่มี cookie = ปฏิเสธ (เทสต์ครบ)
- 🔴 ผูกได้เฉพาะผู้ใช้ที่ล็อกอินอยู่ **และต้องเป็นคนเดียวกับใน state** ⇒ state หลุดไปถึงคนอื่น
  ก็ผูกข้ามคนไม่ได้ (`wrong_user`) · ยิง callback โดยไม่มี session = ไม่ผูกให้ใครเลย
- LINE ใบเดียวผูกสองคนในก๊วนเดียวกันไม่ได้ (`ALREADY_REGISTERED` → `link_failed`)
- 🔴 **เลิกผูกแล้วหยุดส่งทันที** — `unlink_line_account()` ปิดแถว `line` ที่ยัง `pending`/`processing`
  เป็น `failed` พร้อมเหตุผล ไม่ปล่อยให้ worker ไปลองส่งแล้วค่อยล้มเอง (เทสต์ยืนยัน)
- ❗ **ไม่มีตารางเก็บ state/nonce** — `state` เป็น HMAC stateless · `nonce` อยู่ใน cookie httpOnly
  ที่ถูกลบทิ้งหลังใช้หนึ่งครั้ง

**การตัดสินใจที่บันทึกไว้**
- อ่าน `userId` จาก **`GET /v2/profile`** หลังแลก code แทนการถอด `id_token` (JWT) เอง —
  ได้ค่าเดียวกันโดยไม่ต้อง verify ลายเซ็น JWT เอง ซึ่งพลาดแล้วกลายเป็นช่องโหว่ทันที
  · ❌ ไม่ log token/id_token ที่ไหนเลย
- **Login channel เป็นคนละใบกับ Messaging API** ⇒ เก็บ `login_channel_id` (ไม่ลับ เพราะอยู่ใน URL
  ที่ผู้ใช้เห็นอยู่แล้ว) + secret ลง Vault แยกอีกใบ · หน้าตั้งค่าเตือนว่า**ต้องอยู่ provider เดียวกัน**
  ไม่งั้น LINE จะให้ `userId` คนละใบ = ผูกได้แต่ส่งข้อความไม่ถึง
- รวมเส้นทางผูกบัญชีของ 4.B (รหัสในแชต) กับ 4.D (Login) ไว้ที่ `linkAndNotify()` ตัวเดียว
  ⇒ ทั้งสองทางได้ข้อความยืนยันเหมือนกันเสมอ ไม่มีทางที่ทางหนึ่งจะลืม
- **ยังคงทางผูกด้วยรหัสในแชตไว้** เป็นทางสำรอง (ก๊วนที่ยังไม่ได้ตั้ง Login channel ใช้ได้ทันที)

---

## WO-4.E: LIFF — หน้าจอในแอป LINE

**Goal**: สมาชิกทำสิ่งที่ทำบ่อยที่สุดได้จบในแอป LINE โดยไม่ต้องเปิดเบราว์เซอร์

**Scope**
- ทำเฉพาะ: หน้า LIFF (นัดที่กำลังเปิด → ลงชื่อ/ยกเลิก · ยอดที่ต้องจ่ายของตัวเอง) · `liff_id` ต่อก๊วนจาก `WO-4.A` · เข้าสู่ระบบใน LIFF ผ่านบัญชีที่ผูกไว้แล้ว
- ไม่แตะ: rich menu · Flex message · การจ่ายเงินในแอป LINE

**Definition of Done**
- 🔴 **สิทธิ์เดิมทั้งหมดยังบังคับ** — LIFF เป็นแค่หน้าจออีกใบ ⇒ ลงชื่อยังผ่าน `register_to_session()`
  และ RLS เหมือนเดิม (❌ ห้ามมี endpoint ที่เชื่อ LIFF context แล้วข้ามการตรวจสิทธิ์)
- เปิด LIFF โดยยังไม่ผูกบัญชี → พาไปผูกก่อน (ไม่ใช่ 500 หรือหน้าว่าง)
- ก๊วนที่ปิด `features.line` เข้าไม่ได้ทั้ง UI และ action
- 🔴 ยอดเงินที่แสดงอ่านจาก **ledger** (`domain/billing/ledger.ts`) และผ่าน `moneyFromDb()` (ข้อจำกัด 10)
- หน้าใช้งานได้จริงบนจอมือถือแคบ (LIFF เปิดเต็มจอในแอป LINE)

**Forbidden**
- ❌ ห้ามเชื่อ `liff.getProfile()` เป็นการยืนยันตัวตนฝั่ง server · ❌ ห้ามทำ endpoint พิเศษที่ข้าม `can()`/RLS

**References**: baseline §โมดูล ข้อ 11 · §Roadmap Phase 4 · ข้อจำกัด 5, 9, 10

---

## WO-4.F: Phase 4 checkpoint + `v0.4.0`

**Goal**: พิสูจน์ว่า LINE ทั้งชุดทำงานร่วมกับของเดิมได้จริง แล้วปิด Phase

**Scope**
- ทำเฉพาะ: E2E ของ Phase 4 · README/`.env.example` ส่วน LINE + Vault · tag
- ไม่แตะ: งานของ Phase 5 (Hardening/Deploy)

**Definition of Done**
- **E2E ของ Phase 4**: ตั้งค่า LINE (Vault) → ผูกบัญชี → ประกาศหนึ่งใบ → ได้ทั้งแถว `in_app`
  และ `line` **อย่างละหนึ่ง** ต่อผู้รับ → worker ส่ง → `notification_logs` นับโควต้าถูก →
  ยกเลิกผูกแล้วรอบถัดไปไม่มีแถว `line`
  (บวกเส้นเต็มของ MVP-0 / Phase 2.5 / Phase 3 ที่ต้องยังผ่าน)
- ก๊วนที่ **ไม่ได้ต่อ LINE เลย** ต้องทำงานได้เหมือนเดิมทุกประการ — เทสต์ยืนยัน (ข้อจำกัด 6)
- `.env.example` มีตัวแปรใหม่ครบ พร้อมคำอธิบายว่าเอามาจากไหนใน LINE Developers Console
- แล้ว tag **`v0.4.0`** ตาม §Release Versioning

**Forbidden**
- ❌ ห้ามข้าม E2E ของ Phase ก่อนหน้า · ❌ ห้าม commit ค่า credential จริงลง `.env.example`

**References**: baseline §Roadmap Phase 4 · §Verification · §Release Versioning
