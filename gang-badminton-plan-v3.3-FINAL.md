# แผนพัฒนาแพลตฟอร์มจัดการก๊วนแบดมินตัน (Gang Badminton) — v3.3 FINAL (Approved Baseline)

> v3: ปิด blocker เรื่องเงิน/concurrency, ปิดช่อง guest/worker/schema, ลด surface ที่ไม่ load-bearing — เครื่องหมาย **[v3]**
> v3.1: รับข้อเสนอภายนอกบางส่วน (state machines, retry backoff, aggregate columns, UUIDv7, feature flags, domain layer, pg_trgm, daily_metrics) — เครื่องหมาย **[v3.1]**
> v3.2: แก้จุดรั่วจากรีวิวรอบสาม (secret token ≠ UUIDv7, state machine ครบเส้น, GUC trigger, flag enforce ฝั่ง server) + engineering hygiene — เครื่องหมาย **[v3.2]**
> v3.3: ปิดวงจรเงินเคสยกเลิกกลางคัน, เพิ่ม check_in function, rate limit state บน serverless, error catalog, release versioning — เครื่องหมาย **[v3.3]**
>
> **🔒 APPROVED — เอกสารนี้คือ Baseline สุดท้าย เริ่ม Phase 1 ได้ทันที** การเปลี่ยนสถาปัตยกรรมหลังจากนี้ทำผ่าน ADR entry ใหม่ท้ายเอกสารเท่านั้น ห้ามเพิ่ม scope ระหว่างพัฒนา
>
> | สถานะ | รายละเอียด |
> |---|---|
> | **Baseline Version** | 1.0 (จากร่าง v3.3) |
> | **Approved โดย** | Tech Lead / Project Owner |
> | **Approved วันที่** | 13 กรกฎาคม 2026 |
> | **กติกาการเปลี่ยนแปลง** | สถาปัตยกรรม = ADR ใหม่เท่านั้น (ADR-001 เป็นตัวอย่างแรก) / รายละเอียด implement ที่ไม่ขัด baseline = ตัดสินใจใน PR ได้ |
> | **ADR ล่าสุด** | ADR-001 — billing computed in domain, committed via single DB function |

## Context

ผู้ใช้ทำธุรกิจจัดก๊วนแบดมินตัน ต้องการสร้าง **แพลตฟอร์ม multi-tenant SaaS** ให้หัวหน้าก๊วนคนอื่นๆ มาเปิดก๊วนและบริหารเองได้ Repo `webaon/gang-badminton` ยังว่างเปล่า — เริ่มจากศูนย์ พัฒนาบน branch `claude/badminton-group-system-4pfs7o`

### ความต้องการหลัก (คงเดิม)
- Multi-tenant: หลายก๊วน แต่ละก๊วนมีแอดมินของตัวเอง ตั้งค่าเองได้
- ช่องทางหลัก = เว็บแอป ใช้ครบทุกฟีเจอร์โดยไม่พึ่ง LINE / LINE LIFF+OA เป็น optional ต่อก๊วน
- ฟีเจอร์: จองคิว+waitlist, เก็บเงิน, จัดคู่ลงสนาม, นับลูกแบด, สถิติสมาชิก, ค้นหาก๊วน/หาคนเล่น, รายงานรายรับ-รายจ่าย
- โมเดลคิดเงินยืดหยุ่นต่อก๊วน: เหมาจ่าย / ค่าสนาม+ลูกตามจริง / รายเดือน
- จ่ายเงิน: PromptPay QR ต่อคน + อัปสลิป + แอดมินยืนยัน
- ระดับฝีมือ: แต่ละก๊วนกำหนด scale เอง
- Stack: Next.js + Supabase / UI: Astryx + Tailwind

### การตัดสินใจสะสม (v2 คงเดิม + v3 เพิ่ม/แก้)

| ประเด็น | การตัดสินใจ |
|---|---|
| Guest/walk-in ไม่มีบัญชี | **[v3 แก้]** guest ลงชื่อได้ 2 ทางเท่านั้น: (ก) แอดมิน/สมาชิกลงให้ (`registered_by` บันทึกคนลง) หรือ (ข) **ลิงก์เชิญต่อ session** ที่มี token (`session_invite_tokens`) — ไม่มี endpoint เปิดสาธารณะ; guest จัดการตัวเอง (ดูสถานะ/ยกเลิก) ผ่าน **signed URL เฉพาะ registration** ที่ได้รับหลังลงชื่อ (ส่งทาง SMS ไม่มีใน MVP — แสดงบนจอ + ให้คนลงชื่อแทนส่งต่อ); ทุก endpoint guest มี rate limit ต่อ IP ต่อ session; แอดมินเก็บเงิน guest แบบ cash/โอนแล้ว mark จ่ายแทน |
| นัดประจำสัปดาห์ | ใช้ `session_templates` (recurrence rule) + cron generate ล่วงหน้า 2 สัปดาห์; แก้ session ที่ generate แล้ว = แก้เฉพาะนัดนั้น, แก้ template = มีผลกับนัดที่ยังไม่ generate — **[v3]** เลื่อนไป Phase 2.5 (MVP-0 สร้างนัดมือ) |
| กติกายกเลิก/no-show | cancellation policy ต่อก๊วน (cutoff + penalty) snapshot ลง session; no-show บันทึกเป็น event และคิด penalty ได้ |
| **การลงชื่อ/waitlist ต้องกัน race** | **[v3 ใหม่ — blocker]** `register_to_session()`, `cancel_registration()`, `promote_waitlist()` เป็น **Postgres functions** ทำงานใน transaction เดียว โดย `SELECT ... FOR UPDATE` แถว `sessions` ก่อนนับที่ว่าง/insert/เลื่อนคิว — app code ห้าม check-then-act เอง; cron sweep ยังมีไว้กันงานหลุด (ไม่ใช่กันชน) |
| Refund/แก้ยอดหลัง verify | `payment_adjustments` (refund / correction / credit) ไม่แก้ record เดิม — **[v3 แก้]** adjustment อ้าง **`session_charge_id`** (ระดับหนี้ต่อคน) ไม่ใช่ payment ทั้งก้อน → refund บางส่วนของการจ่ายแทนเพื่อนรู้ว่าลดหนี้ใคร; ยอดสุทธิต่อคน = charge − allocations + adjustments ที่ระดับ charge; invariant: `sum(allocations ของ payment) ≤ payment.amount` (CHECK/trigger) |
| **นโยบายปัดเศษ** | **[v3 ใหม่ — blocker]** Billing Engine กำหนด rounding policy ชัด: หารต่อหัวแล้ว**ปัดขึ้นเป็นหน่วยบาทต่อคน** (ค่า default, ก๊วนเปลี่ยนเป็นปัดสตางค์/ก๊วนดูดซับเศษได้ใน pricing plan) — เศษส่วนเกินบันทึกเป็นรายรับก๊วน (`rounding_surplus` ใน breakdown) เพื่อให้รายงาน reconcile ได้; **invariant test บังคับ**: `sum(session_charges) − ต้นทุนจริง = surplus ตาม policy เสมอ` |
| เข้ารหัส LINE credentials | Supabase Vault เป็นหลัก (fallback: AES-256-GCM ฝั่งแอป, key จาก env — ห้ามอยู่ใน DB); `gang_line_configs` เก็บเฉพาะ secret id, ถอดรหัสเฉพาะ server |
| RLS recursion + perf | migration แรกสร้าง security definer functions: `is_gang_member(gang_id)`, `is_gang_admin(gang_id)`, `is_org_member(org_id)` (ทุกฟังก์ชัน `SET search_path`) — **[v3]** policy เรียกแบบ **`(SELECT is_gang_member(gang_id))`** เพื่อให้ Postgres cache เป็น initplan ไม่เรียกซ้ำต่อแถว |
| Storage สลิป | bucket `payment-slips` เป็น private + storage RLS (เจ้าของสลิป + แอดมินก๊วน) |
| Timezone | เก็บ `timestamptz` ทั้งหมด, ก๊วนมี `timezone` (default `Asia/Bangkok`), แสดงผล/ฟอร์ม/generate จาก template แปลงตาม timezone ก๊วนเสมอ + unit test |
| แจ้งเตือนโดยไม่มี LINE | in-app notification center เป็นช่องทางพื้นฐานทุกก๊วน — LINE เป็น channel เสริมผ่าน queue เดียวกัน |
| โควต้า LINE OA | `notification_logs` นับข้อความต่อก๊วนต่อเดือน + usage counter ในหน้าตั้งค่า |
| Realtime ชนเพดาน free tier | opt-in เฉพาะหน้า game day console + waitlist, degrade เป็น polling ทุก 10 วิอัตโนมัติ |
| **Notification worker ห้ามส่งซ้ำ + retry backoff** | **[v3]** worker claim งานด้วย **`FOR UPDATE SKIP LOCKED`** + เปลี่ยน status เป็น `processing` ก่อนส่ง → `sent/failed`; แถวค้าง `processing` เกิน N นาทีถูก sweep กลับเป็น `pending` — **[v3.1]** ส่งไม่สำเร็จ = retry แบบ exponential backoff ผ่าน `next_retry_at` (5 นาที → 15 นาที → 1 ชม.) เก็บ `attempt` + `last_error`; เกิน 3 ครั้ง = `failed` ถาวร (รองรับเคส LINE ล่มโดยไม่ต้องเขียนใหม่ทีหลัง) |
| **State machines (session + payment)** | **[v3.1 ใหม่]** กำหนด transition ที่อนุญาตชัดเจนและ enforce ใน DB function เดียว (`transition_session()` / trigger) — เปลี่ยนสถานะนอก flow = raise exception + เขียน event ดูรายละเอียดในหัวข้อ State Machines |
| **Feature flags ต่อก๊วน** | **[v3.1 ใหม่]** `gangs.features` (jsonb): เปิด/ปิด line, discovery, guests, coupons, statistics ต่อก๊วน — เป็น key ใน settings ไม่ตั้งตารางใหม่; **[v3.2] flag ต้อง enforce ฝั่ง server**: ตรวจใน `domain/permissions/can()` และใน DB function ที่เกี่ยวข้อง (เช่น `register_to_session` ตรวจ `features.guests` ก่อนรับ guest) — UI ซ่อนปุ่มอย่างเดียว = flag ปลอม |
| **การแบ่งงาน cron** | **[v3 แก้]** งานที่เป็น app logic (ส่ง notification, generate sessions, reminder, monthly billing) ใช้ **Vercel Cron → route handler** (auth ด้วย `CRON_SECRET`); **pg_cron ใช้เฉพาะงาน pure SQL** (statistics rollup, cleanup, sweep แถวค้าง) — ตัด pg_net + secret ข้ามชั้นออกจากระบบ |
| Astryx ยัง Beta | pin version ตายตัว, script `"astryx": "node node_modules/@astryxdesign/cli/bin/astryx.mjs"`, CLAUDE.md ระบุ fallback: Astryx primitives ก่อน → custom ใน `components/ui/` (ห้าม import ไลบรารี UI อื่น) |
| Scope | **[v3 แก้]** เพิ่ม **MVP-0** ภายใน Phase 2 — จุดที่ก๊วนของผู้ใช้เองใช้จริงได้เร็วที่สุด (ดู Roadmap) |

## สถาปัตยกรรม

- **Next.js 15** (App Router, TypeScript) — เว็บ + API routes, mobile-first
- **UI: Astryx Design System + Tailwind CSS v4** — Astryx = components ทั้งหมด / Tailwind = layout เท่านั้น — กติกาใน CLAUDE.md; docs เว็บถูก proxy บล็อก → ใช้ Astryx CLI (`npm run astryx`) ดู docs/templates ในเครื่อง, `npx astryx init` ตอน scaffold
- **Supabase** — PostgreSQL + Auth + Storage + Realtime + pg_cron (เฉพาะงาน SQL) + Vault; RLS สำหรับ tenant isolation
- **โครงสร้างชั้นข้อมูล**: `Organization → Gang → Session` — auto-create personal org ตอนสร้างก๊วนแรก ผู้ใช้ไม่รับรู้จนมีก๊วนที่ 2
- **[v3] Billing แยกสอง engine** (`lib/billing/`):
  - **SessionBilling** — ทำงานตอนปิดรอบ: `calculate(sessionSnapshot, registrations, games, memberBillingStatus) → Charge[]` มี `FlatRateStrategy`, `CourtSplitStrategy`; **สมาชิกรายเดือนที่มาเล่น**: ค่าสนาม = 0, ค่าลูกคิดตามจริงหรือรวมในรายเดือน (ตั้งค่าใน pricing plan — default: ลูกคิดตามจริง) → charge ของเขาโผล่ในรายงานต่อ session ด้วยยอดที่ถูกต้อง
  - **MembershipBilling** — Vercel Cron รายเดือน: generate `session_charges` ประเภท `monthly_fee` ต่อสมาชิกรายเดือน (scope = สมาชิก+เดือน ไม่ผูก session)
  - ทั้งคู่ pure function + rounding policy อยู่ในชั้นนี้ → unit test ได้เต็ม; เพิ่มโมเดลใหม่ = เพิ่ม strategy เดียวใน engine ที่ scope ตรง
- **Matching Engine** (`lib/matching/`) — pipeline: `Queue → SelectPlayers (เล่นน้อย+รอนานก่อน) → BalanceSkill → AvoidRepeat → CourtAssignment` — pure function ต่อขั้น, แอดมินลากสลับ override ได้เสมอ; **[v3]** reliability score คำนวณสดจาก `session_registrations` + `event_logs` ตอนจัดลำดับ waitlist (ไม่เก็บ counter ซ้ำบน `gang_members`)
- **Notification Queue** — เขียนแถวลง `notifications` (pending) → Vercel Cron worker claim แบบ `SKIP LOCKED` → ส่ง → `notification_logs`; เพิ่ม channel ภายหลังได้
- **[v3] Event Log (รวม audit)** — ตารางเดียว `event_logs`: event ธุรกิจ (Player Joined/Cancelled, Waitlist Promoted, Payment Verified, Game Started/Finished, Session Closed) และ **audit event** (`type = 'audit.*'` เก็บ before/after ใน payload สำหรับการแก้ราคา/ยอดเงิน/role) — append-only, ใช้ทำ timeline, trigger notification, analytics; ตัด `audit_logs` ออก ไม่มีสองที่ให้ลืมเขียน
- **Background Jobs** — Vercel Cron: generate sessions จาก template, reminder, monthly billing, notification worker / pg_cron: statistics rollup รายคืน, cleanup, sweep แถวค้าง
- Deploy: Vercel + Supabase cloud
- ไลบรารี: `promptpay-qr`, `qrcode`, `@line/bot-sdk` + LIFF SDK (optional), `@supabase/ssr`, `vitest`, Playwright

## Database Schema

หลักการทั่วทั้ง schema:
- **Audit fields**: ตารางธุรกรรมสำคัญมี `created_by`, `updated_by` (+ `deleted_by`)
- **Soft delete**: `deleted_at` บน `sessions`, `gang_members`, `payments`, `gangs`, `session_registrations`; ทุก query/policy กรอง `deleted_at IS NULL`
- **[v3] Unique บนตาราง soft delete = partial unique index เสมอ**: เช่น `UNIQUE(gang_id, user_id) WHERE deleted_at IS NULL` บน `gang_members`, `UNIQUE(session_id, user_id) WHERE deleted_at IS NULL AND user_id IS NOT NULL` บน `session_registrations` — สมาชิกออกแล้วกลับเข้าใหม่ต้องไม่ชน
- **[v3] Indexing ระบุใน migration ตั้งแต่แรก**: ทุก FK มี index; composite index นำหน้าด้วย tenant key ตาม query จริง เช่น `(gang_id, status)`, `(session_id, status, ordering)`, `(gang_id, event_type, created_at)` — equality ก่อน range/sort; **[v3.2]** เพิ่ม `notifications(status, next_retry_at)` partial `WHERE status = 'pending'` สำหรับ worker query
- **Snapshot ทุกอย่างที่กระทบเงิน**: `sessions.snapshot` (jsonb) เก็บ pricing plan เต็มก้อน + **rounding policy** + PromptPay ID + ราคาคอร์ท/ลูก + cancellation policy + skill scale ณ ตอนสร้างนัด — **[v3.1]** มี key `snapshot_version` ใน jsonb (กัน schema ของ snapshot เปลี่ยนในอนาคต billing engine อ่านตาม version ได้) — คงเป็นก้อนเดียว: snapshot คือบันทึกแช่แข็งอ่านตอนปิดรอบ ไม่มี query pattern ที่ต้อง index เข้าไปข้างใน
- เงินทุกคอลัมน์เป็น `DECIMAL` — ห้าม float
- **[v3.1] PK ทุกตารางเป็น UUIDv7** (สร้างฟังก์ชัน `uuid_generate_v7()` ใน migration แรก ใช้เป็น default แทน `gen_random_uuid()`) — เรียงตามเวลา ลด index fragmentation เทียบ v4
- **[v3.2] Secret token ห้ามใช้ UUID ใดๆ (โดยเฉพาะ v7 ที่ฝัง timestamp)**: `session_invite_tokens.token` และ `guest_access_token` generate ด้วย `gen_random_bytes(32)` encode base64url และ**เก็บเฉพาะ hash** (SHA-256) ในตาราง — validate โดยเทียบ hash; กติกา: **PK = identifier (UUIDv7) / secret = random เต็มแยกต่างหาก** ห้าม agent ใช้ PK แทน token เพราะสะดวก

### ตาราง

**Tenancy & คน**
- `organizations` — ชื่อ, owner
- `organization_members` — role ระดับ org (owner/admin)
- `profiles` — ต่อจาก auth.users: ชื่อเล่น, เบอร์, avatar
- `gangs` — org_id, ชื่อ, พื้นที่, is_public, promptpay_id, timezone, cancellation policy ปัจจุบัน, การตั้งค่า + **`features` jsonb [v3.1]** (flag เปิด/ปิด line, discovery, guests, coupons, statistics ต่อก๊วน)
- `gang_skill_levels` — label + rank ต่อก๊วน
- `gang_members` — role (owner/admin/member), skill_level_id, สถานะรายเดือน — **[v3]** ไม่เก็บ attendance counter (คำนวณจาก registrations/event_logs; หน้า UI อ่านจาก `member_statistics` rollup)

**นัดเล่น**
- `gang_pricing_plans` — type (flat_rate / court_plus_shuttle / monthly) + พารามิเตอร์ + **[v3]** rounding policy + กติกาสมาชิกรายเดือนใน session (ลูกคิดตามจริง/รวม)
- `session_templates` — recurrence (วัน, เวลา, จำนวนคอร์ท, max_players, pricing plan) — Phase 2.5
- `sessions` — วันเวลา (timestamptz), สนาม, **court_count + court_labels (jsonb)** **[v3: ตัดตาราง `courts` — ยังไม่ load-bearing จนกว่าจะทำ layout หลายสนาม ค่อยงอกเป็นตารางตอนนั้น]**, max_players, allow_guests, snapshot jsonb, template_id (nullable), สถานะ
- `session_invite_tokens` — **[v3 ใหม่]** token ต่อ session สำหรับ guest ลงชื่อ: **token_hash [v3.2]** (เก็บ hash ของ random 32 bytes ไม่เก็บ plaintext), expires_at, max_uses, created_by
- `session_registrations` — user_id nullable + guest_name/guest_phone + **[v3]** `guest_access_token_hash` **[v3.2]** (สำหรับ signed URL ให้ guest ดู/ยกเลิกเอง — เก็บ hash), status (confirmed/waitlist/cancelled/no_show/checked_in), ordering, cancelled_at, registered_by
- `games` — **court_no/label** **[v3]**, ผู้เล่น 4 คน (registration ids — รองรับ guest), ลูกแบดที่ใช้, เวลาเริ่ม-จบ

**เงิน**
- `session_charges` — ยอดต่อคน: breakdown (ค่าสนาม, ค่าลูก, penalty, ส่วนลด, rounding_surplus), ประเภท (session / monthly_fee **[v3]**), คำนวณโดย Billing Engine จาก snapshot
- `payments` — ยอด, QR payload, slip URL, status (pending/submitted/verified/rejected), verified_by
- `payment_allocations` — 1 payment → หลาย charges; **[v3]** CHECK/trigger: `sum(allocations) ≤ payment.amount`
- `payment_adjustments` — **[v3]** อ้าง `session_charge_id` (+ payment_id ประกอบ): refund/correction/credit, ยอด, เหตุผล — ไม่แตะ record เดิม
- `coupons` — phase หลัง MVP
- `gang_expenses` / `gang_incomes` — รายงาน

**แพลตฟอร์ม**
- `join_requests` — ขอเข้าก๊วนจาก discovery
- `announcements` — ประกาศ + รูปแนบ
- `notifications` — queue: recipient, channel (in_app/line), payload, status (**pending/processing/sent/failed** **[v3]**), scheduled_at, claimed_at + **[v3.1]** `attempt`, `last_error`, `next_retry_at` (worker หยิบเฉพาะ `pending AND next_retry_at <= now()`)
- `notification_logs` — ผลส่งจริง + counter โควต้า LINE ต่อก๊วนต่อเดือน
- `event_logs` — **[v3 รวม audit]** event_type (รวม `audit.*` ที่มี before/after), gang_id, session_id, **aggregate_type + aggregate_id [v3.1]** (session/game/payment/registration — query timeline ต่อ object ได้ตรง มี index `(aggregate_type, aggregate_id, created_at)`), actor, payload — append-only; **ไม่ใช่ event sourcing**: state จริงอยู่ในตาราง ไม่มี replay จึงไม่มีคอลัมน์ version
- `daily_metrics` — **[v3.2 ย้ายเข้า section ตารางให้สอดคล้อง Roadmap]** rollup รายวันระดับแพลตฟอร์ม: วันที่, สมาชิกใหม่, เกม, session, รายได้ — insert โดย rollup job เดิม (Phase 3)
- `member_statistics` — rollup รายคืน: ครั้งที่มา, เกม, ลูก, ยอดจ่ายสะสม, attendance % (UI อ่านจากตารางนี้ — เป็นแหล่งเดียวสำหรับการแสดงผล)

**LINE (optional ต่อก๊วน)**
- `gang_line_configs` — credentials ผ่าน Vault, webhook `/api/line/webhook/[gangId]` verify signature ด้วย secret ก๊วนนั้น
- `member_line_links` — (gang_id + line_user_id + user_id)

### Database Functions (migration แรกๆ) **[v3 ใหม่]**
- `register_to_session(session_id, ...)` — `FOR UPDATE` แถว session → นับที่ว่าง → insert confirmed/waitlist ใน transaction เดียว
- `cancel_registration(registration_id)` — mark cancelled + ตัดสิน penalty ตาม cutoff จาก snapshot + เรียก promote ในตัว
- `promote_waitlist(session_id)` — `FOR UPDATE` → เลื่อนคิวตาม ordering + reliability → เขียน event + enqueue notification
- `check_in_registration(registration_id)` — **[v3.3]** mark checked_in (เฉพาะจาก confirmed) + เขียน event — ให้ลิสต์นี้ตรงกับ transitions ใน State Machines
- `close_session_with_charges(session_id, charges jsonb, expected_status)` — **[ADR-001]** จุด commit เดียวของเงินตอนจบ session (ปิดรอบปกติ `open/in_play → billing` และยกเลิกกลางคัน `in_play → cancelled` ใช้ตัวเดียวกัน): validate transition + **ตรวจ `expected_status` (optimistic guard — ไม่ตรง = raise `INVALID_TRANSITION` ให้ server action คำนวณใหม่)** + insert `session_charges` + เขียน event ใน transaction เดียว; charges คำนวณจาก domain/billing (TS) ฝั่ง server action ก่อนเรียก
- app code (server action) เป็นแค่ shell เรียกฟังก์ชันเหล่านี้ — ห้ามมี logic นับที่ว่างใน TypeScript

### State Machines **[v3.1 ใหม่, v3.2 แก้ครบเส้น]**

**Session**: `draft → open → in_play → billing → settled → archived`
- **[v3.2]** transition เพิ่มเติมที่อนุญาต: `draft/open → cancelled` (ยกเลิกก่อนเล่น), **`in_play → cancelled`** (ยกเลิกกลางคัน — ไฟดับ/ฝนรั่ว), **`open → billing`** (ก๊วนเหมาจ่ายที่ไม่ใช้ game console ข้าม in_play ได้ — ไม่ต้องมีปุ่มกดผ่านหลอกๆ)
- **[v3.3] ปิดวงจรเงินเคสยกเลิกกลางคัน**: charges บางส่วนตาม policy ถูกสร้างพร้อมกับ transition แบบ atomic — คำนวณใน domain/billing (TS) แล้ว commit ผ่าน DB function เดียว (ดู **ADR-001**: billing computed in domain, committed via single DB function with expected-status guard); session จบที่ cancelled (terminal — ไม่ผ่าน billing → settled); หลักทั่วไป: **รายงานนับรายรับจาก `session_charges`/ledger เสมอ ไม่อิง session status** — session cancelled ที่มี charges ก็เข้ารายงานปกติ
- **"เต็ม" ไม่ใช่ state** — derive จาก `count(confirmed) >= max_players` เสมอ เพราะถ้าเป็น state ต้อง transition กลับทุกครั้งที่มีคนยกเลิก = sync bug
- transition enforce ผ่าน `transition_session(session_id, to_state)` (DB function) — ตรวจ transition ที่อนุญาต, เขียน event, raise exception ถ้านอก flow
- **[v3.2] กลไก "ห้าม UPDATE status ตรง"**: RLS บล็อกระดับคอลัมน์ไม่ได้ → ใช้ **BEFORE UPDATE trigger** ตรวจ `OLD.status IS DISTINCT FROM NEW.status` แล้วเช็ค GUC ที่ `transition_session()` set ไว้เอง (`set_config('app.allow_transition', ..., true)` — local ต่อ transaction) — ไม่มี setting = raise exception; pattern เดียวกันใช้กับ payments

**Payment**: `pending → submitted → verified | rejected` และ `rejected → submitted` (อัปสลิปใหม่ได้)
- Allocated/Adjusted/Refunded **ไม่ใช่ state ของ payment** — เป็น record ใน `payment_allocations` / `payment_adjustments` (ledger append-only ตามที่ออกแบบ) ยอดสุทธิคำนวณจาก ledger เสมอ ไม่อ่านจาก status
- enforce ด้วย trigger + GUC เดียวกัน

**Registration** **[v3.2 แก้ notation ให้ครบ]**:
- `waitlist → confirmed` (ผ่าน `promote_waitlist()` **เท่านั้น**)
- `confirmed → checked_in | cancelled | no_show`
- `waitlist → cancelled`
- **ห้าม** `waitlist → checked_in` ตรง (ต้อง promote ก่อน)
- transition ทั้งหมดอยู่ใน DB functions (register/cancel/promote/check_in) อยู่แล้ว

### RLS
- Security definer functions (`SET search_path`) + policy เรียกแบบ `(SELECT fn(...))` กัน recursion และ per-row overhead
- ข้อมูลก๊วนอ่าน/เขียนเฉพาะสมาชิก, งานแอดมินเฉพาะ owner/admin (gang หรือ org), ก๊วน public เปิดอ่าน metadata
- Guest เขียนผ่าน DB function ที่ validate invite token — ไม่มี service-role endpoint เปิด **[v3]**
- `gang_line_configs` server-only

### Storage Buckets
| Bucket | Access |
|---|---|
| `payment-slips` | private — เจ้าของ + แอดมินก๊วน |
| `avatars` | public read, เจ้าของเขียน |
| `gang-assets` | public read, แอดมินก๊วนเขียน |
| `announcement-images` | สมาชิกอ่าน, แอดมินเขียน |

## โมดูล / หน้าจอ

1. **Auth + โปรไฟล์** — Supabase email/password + magic link
2. **จัดการก๊วน/องค์กร** — สร้างก๊วน (auto-create org), สมาชิก/role, skill levels, pricing plans (+rounding policy), PromptPay ID, cancellation policy, เปิด/ปิด public
3. **นัดเล่น + จองคิว** — สร้างนัด (มือใน MVP-0, template ใน 2.5), ลงชื่อผ่าน DB function, guest ผ่าน invite link/แอดมินลงให้, waitlist เลื่อนอัตโนมัติ (ใน cancel function + cron sweep), realtime/polling fallback, cutoff enforcement
4. **คอนโซลวันเล่น** — เช็คอิน (ปุ่มใน MVP-0, QR ใน 2.5), กระดานคิวสด, จัดคู่ผ่าน Matching Engine + ลากสลับ, นับลูกต่อเกม, mark no-show
5. **เก็บเงิน** — ปิดรอบ → SessionBilling คำนวณจาก snapshot → PromptPay QR ต่อคน → อัปสลิป → verify → dashboard ค้างจ่าย; allocations/adjustments ใน Phase 2.5
6. **Notification Center (in-app)** — กระดิ่ง: เปิดรอบใหม่, คิวถึง, เตือนจ่าย, ประกาศ
7. **รายงาน + สถิติ** — รายรับ-จ่าย-กำไร (จาก snapshot + surplus reconcile ได้), สถิติจาก `member_statistics`, timeline จาก event log
8. **ประกาศ** — โพสต์ + รูป + ยิงเข้า queue
9. **ค้นหาก๊วน/หาคนเล่น** — directory public, join request, walk-in ผ่าน invite link — **[v3.1]** ค้นหาชื่อก๊วน/พื้นที่ด้วย **pg_trgm** index (ไม่ใช้ LIKE เปล่า และไม่ใช้ Postgres FTS เพราะ tsvector ตัดคำไทยไม่ได้)
10. **Landing Page** — ทำท้ายๆ
11. **ตั้งค่า LINE ต่อก๊วน** — Vault → webhook เฉพาะก๊วน → เพิ่ม channel line → usage counter → LIFF

## Folder Structure (Feature-based)

```
app/                      # routes บางๆ เรียก features
features/
  auth/  gangs/  sessions/  game-day/  billing/  payments/
  reports/  discovery/  notifications/  announcements/  line/
components/
  ui/                     # Astryx wrappers / custom เฉพาะที่ Astryx ไม่มี
  layout/                 # โครงหน้า (Tailwind)
domain/                   # [v3.1] business logic ล้วน — ห้าม import next/react/supabase
  billing/                # SessionBilling + MembershipBilling (pure, rounding policy)
  matching/               # pipeline (pure)
  policies/               # cancellation/penalty, state transition rules (pure)
  permissions/            # can(role, action) — mapping role→สิทธิ์รวมที่เดียว ไม่ hardcode กระจาย
lib/                      # infrastructure adapters
  supabase/  promptpay/  line/  crypto/  events/  notify/
server/                   # server actions (shell เรียก DB functions) / route handlers (cron)
supabase/
  migrations/  seed/
types/
CLAUDE.md                 # กติกา: Astryx=components, Tailwind=layout, fallback rule,
                          # snapshot rule, "ห้ามนับที่ว่างใน TS — เรียก DB function เท่านั้น",
                          # "domain/ ห้าม import framework", สิทธิ์ตรวจผ่าน can() เท่านั้น,
                          # ADR-001: billing คำนวณใน domain — charges ประเภท session
                          # commit ผ่าน close_session_with_charges() เท่านั้น /
                          # ประเภท monthly_fee ผ่านฟังก์ชัน MembershipBilling (idempotent)
                          # ห้ามย้าย billing ลง SQL, ห้าม insert charges ที่อื่น
```

## Roadmap **[v3 แบ่ง Phase 2 ใหม่]**

**Phase 1 — Foundation**: Scaffold (Next.js + Tailwind v4 + Astryx pin + scripts + CLAUDE.md) → migrations ทั้ง schema + DB functions (register/cancel/promote/check_in/transition_session/close_session_with_charges — ตาม section Database Functions ซึ่งเป็น authoritative) + security definer + RLS + partial unique indexes + composite indexes + storage buckets + pg_cron/Vercel Cron setup → seed script

**Phase 2 — MVP-0 (จุดที่ก๊วนผู้ใช้เริ่มใช้จริง)**:
Auth → Gang/Org + สมาชิก + skill + cancellation policy → **pricing plan เฉพาะโมเดลที่ก๊วนผู้ใช้ใช้จริง 1 โมเดล** → สร้างนัดมือ + ลงชื่อ/guest ผ่าน invite link + waitlist (DB functions) + realtime/polling → Game Console (เช็คอินปุ่ม, matching, นับลูก, no-show) → SessionBilling strategy เดียว + rounding + unit/invariant tests → PromptPay QR + สลิป + verify → In-app notifications
> ✅ **MVP-0 checkpoint** — ก๊วนของผู้ใช้ใช้งานจริงได้ที่นี่ เร็วกว่า v2 ราวครึ่งทาง

**Phase 2.5 — Core ครบ**: billing strategies ที่เหลือ + MembershipBilling (monthly) → payment_allocations (จ่ายแทนเพื่อน) + adjustments/refund → session templates + auto-generate → QR check-in → reminder jobs

**Phase 3 — Growth**: member_statistics rollup + **daily_metrics [v3.1]** (platform dashboard: สมาชิกใหม่/เกม/รายได้ต่อวัน — insert เพิ่มใน rollup job เดิม) → รายงาน → ประกาศ → Discovery (pg_trgm) + join request + walk-in → Landing Page (static/ISR)

**Phase 4 — LINE**: Vault + config UI + webhook ต่อก๊วน → worker เพิ่ม channel line + quota counter → LIFF → LINE Login link

**Phase 5 — Hardening & Deploy**: E2E เต็ม flow → RLS tests → README (ไทย): setup Supabase, env vars, Vault, cron, deploy Vercel

Commit + push เป็นช่วงๆ ตามโมดูลไป `claude/badminton-group-system-4pfs7o`

**[v3.3] Release Versioning** — ผูกกับ Phase: `v0.1.0` = MVP-0, `v0.2.0` = Phase 2.5 ครบ, `v0.3.0` = Growth, `v0.4.0` = LINE, `v1.0.0` = public release หลัง Hardening — tag ทุก release + changelog จาก commit ตามโมดูล

## Verification

- **Unit tests (vitest) — บังคับก่อนถือว่าโมดูลเสร็จ**:
  - SessionBilling ทุก strategy + edge cases: เช็คอินแต่ไม่ลงเกม, guest, penalty late cancel/no-show, สมาชิกรายเดือนมาเล่น (ค่าสนาม 0 + ลูกตาม config), session ที่ราคาเปลี่ยนหลังสร้าง (ต้องใช้ snapshot), **[v3.2] session ยกเลิกกลางคัน (in_play → cancelled) คิดเงินบางส่วนตาม policy**
  - **[v3] Money invariants**: `sum(session_charges) − ต้นทุนจริง = rounding surplus ตาม policy` ทุก strategy ทุกจำนวนคน (property-based: หาร 3, 7, 13 คน); `sum(allocations) ≤ payment`; ยอดสุทธิหลัง adjustment ระดับ charge ถูกต้อง
  - MembershipBilling: generate ครบทุกสมาชิก active, ไม่ซ้ำเดือนเดิม (idempotent)
  - Matching Engine: เล่นน้อย+รอนานก่อน, skill ใกล้กัน, ไม่ซ้ำ 4 คนเดิม, คนไม่หาร 4 ลงตัว
  - Timezone: สร้าง/แสดงนัดข้าม timezone ไม่เพี้ยน
- **[v3] Concurrency tests (ต่อ DB จริงผ่าน supabase local)**:
  - **Test setup**: รันผ่าน **client path เดียวกับ production** — RPC ผ่าน supabase-js เป็นหลัก; จุดที่ใช้ direct Postgres connection ให้ต่อผ่าน **pooled port (6543, transaction pooling)** ไม่ใช่ direct (5432) เพื่อยืนยันพฤติกรรม GUC/lock บน path จริง
  - ยิง `register_to_session` พร้อมกัน 2 request ตอนเหลือ 1 ที่ → ได้ confirmed 1 + waitlist 1 เสมอ ไม่ overbook
  - cancel พร้อมกัน 2 คน → promote ไม่ซ้ำคน ไม่ข้ามคิว
  - notification worker 2 ตัวรันทับกัน → ไม่มีข้อความส่งซ้ำ (SKIP LOCKED)
  - **[ADR-001]** เรียก `close_session_with_charges` ด้วย `expected_status` ที่ล้าสมัย → ได้ `INVALID_TRANSITION` และไม่มี charges เกิดขึ้นเลย (atomic ทั้งก้อน)
- **RLS tests**: ก๊วน A อ่านก๊วน B ไม่ได้, member อ่าน line_configs ไม่ได้, non-member อ่านสลิปไม่ได้ (storage), guest token ใช้ข้าม session ไม่ได้, recursion ไม่เกิด
- **E2E (Playwright)**: สมัคร → สร้างก๊วน → ตั้งราคา+policy → สร้างนัด → ลงชื่อจนเต็ม + guest ผ่าน invite link + waitlist → ยกเลิกหลัง cutoff เห็น penalty → เช็คอิน → จัดคู่+นับลูก → ปิดรอบ → ยอด+QR ถูกต้อง (ตรวจ surplus ในรายงาน) → verify → refund ระดับ charge 1 รายการ → รายงาน + timeline + in-app notification / Phase 2.5 เพิ่ม: จ่ายแทนเพื่อน 1 สลิป 2 คน, template generate, QR check-in
- **Job tests**: template generate ล่วงหน้า 2 สัปดาห์ (idempotent — รันซ้ำไม่ generate ซ้ำ), waitlist sweep, reminder เข้า queue, แถว processing ค้างถูกกู้กลับ
- `supabase start` local → migrations + seed → `npm run build` ผ่านก่อนทุก commit ใหญ่
- **[v3.1] Domain layer test**: lint rule/CI ตรวจว่า `domain/` ไม่ import next/react/supabase

## Engineering Practices **[v3.2 ใหม่]**

**Migration Policy**
- ห้ามแก้ migration ที่รันใน production แล้ว — แก้ = migration ใหม่เสมอ
- เปลี่ยน schema แบบ **expand → migrate → contract**: เพิ่มของใหม่ก่อน (additive), dual-write/backfill, สลับ read, ค่อยลบของเก่าใน release ถัดไป — ห้าม rename/drop ในขั้นเดียวบนระบบที่มีข้อมูล
- ทุก migration ระบุแนวทาง rollback; migration ที่ย้อนไม่ได้ (drop/truncate) ต้อง review เพิ่มหนึ่งชั้น

**Observability (ขนาดพอดีทีมเล็ก)**
- ทุก request/cron run มี **correlation id** แนบใน log และส่งต่อเข้า `event_logs.payload` เมื่อเขียน event — ตาม bug จาก UI ถึง DB ได้ในเส้นเดียว
- Error logging รวมศูนย์ (Sentry หรือ Vercel log drain) — ห้าม swallow error เงียบ
- Worker metrics อ่านจากของที่มีอยู่แล้ว: `notifications` (ค้าง pending/failed rate) + `notification_logs` + `event_logs` — ไม่ตั้งระบบ metrics แยกจนกว่าจะมีเหตุจากการวัด

**API Response Contract** — route handlers ทั้งหมด (cron, webhook, endpoint ที่ guest เรียก) ตอบรูปแบบเดียว: `{ success: boolean, data?, error?: { code, message } }` — server actions ใช้ typed return เดียวกันผ่าน helper ใน `shared/`; mobile app ในอนาคตใช้ contract นี้ต่อได้เลย
- **[v3.3] Error Catalog**: `error.code` ต้องมาจาก `docs/errors.md` (เช่น `SESSION_FULL`, `INVALID_TRANSITION`, `PAYMENT_ALREADY_VERIFIED`, `INVITE_TOKEN_EXPIRED`, `FEATURE_DISABLED`) — DB functions raise ด้วย code เดียวกัน (`ERRCODE`/message prefix) แล้ว map ผ่าน helper; frontend แปลภาษาจาก code, log ค้นด้วย code, ห้าม hardcode ข้อความ error กระจาย

**[v3.3] Rate limit บน Vercel serverless ต้องมี shared state** — in-memory counter ไม่รอดข้าม invocation; ใช้ **counter ใน Postgres** (unlogged table `rate_limits(key, window_start, count)` + function `check_rate_limit(key, limit, window)`) ซึ่งพอสำหรับ endpoint guest ที่ traffic ต่ำ — **ไม่ลาก Upstash/Redis เข้าโปรเจกต์** จนกว่าจะมีเหตุจากการวัด (สอดคล้อง ADR ข้อ cache)

**Security Checklist (gate ก่อน deploy — อยู่ใน Phase 5)**
- [ ] RLS เปิดทุกตาราง (มี test ยืนยัน ไม่ใช่ตาเปล่า)
- [ ] Storage bucket ทุกตัวมี policy ตามตาราง Access
- [ ] Secret อยู่ใน Vault หรือ env เท่านั้น — grep ยืนยันไม่มีใน code/DB
- [ ] Secret token เก็บเป็น hash, ไม่ log plaintext token
- [ ] Security headers + CSP บน Next.js config
- [ ] Rate limit บน endpoint ที่ guest/public เรียกได้ทุกตัว
- [ ] Cron/webhook routes ตรวจ `CRON_SECRET` / LINE signature ทุก request

**CI Gates**
- ต่อ PR (เร็ว): type check → ESLint → unit tests (vitest) → `npm run build` + lint rule ตรวจ `domain/` ไม่ import framework
- บน main / nightly (ช้า เพราะต้อง `supabase start`): RLS tests → concurrency tests → Playwright smoke
- Merge ได้เมื่อ PR gates เขียวเท่านั้น; main แดง = หยุดงานใหม่จนแก้เสร็จ

## ADR — ข้อเสนอที่พิจารณาแล้ว "ไม่รับ" (v3.1)

บันทึกไว้กันคำถามย้อนหลัง แต่ละข้อทบทวนใหม่ได้เมื่อเงื่อนไขเปลี่ยน:

| ข้อเสนอ | เหตุผลที่ไม่รับ | จะทบทวนเมื่อ |
|---|---|---|
| แยก snapshot เป็นหลายคอลัมน์/ตาราง | snapshot คือบันทึกแช่แข็งอ่านตอนปิดรอบ ไม่มี query pattern ที่ต้อง index เข้าไปข้างใน — แยกคอลัมน์ = surface เพิ่มโดยไม่มี query จริงรองรับ; ใช้ `snapshot_version` ใน jsonb แทน | มี query ที่ต้องค้น/aggregate ข้าม snapshot จริง |
| Billing pipeline 4 ขั้น (Calculator→Validator→Adjustment→Finalizer) | Adjustment เป็น ledger แยกโดยตั้งใจ (ไม่อยู่ใน calculate), coupon ยังไม่มา — ขั้นที่เพิ่มตอนนี้คือกล่องเปล่า; pure function ประกอบเพิ่มทีหลังได้เสมอ | เริ่มทำ coupon/promotion (Phase หลัง MVP) |
| Matching เพิ่ม Constraint stage ตอนนี้ | pipeline เสียบ stage ได้อยู่แล้วโดยออกแบบ — ต้นทุนจริงคือ data model ของ constraint (คู่ห้ามเจอกัน, tag) ไม่ใช่ engine | มีก๊วนต้องการกติกาจับคู่พิเศษจริง |
| `version` ใน event_logs (event sourcing) | ไม่ได้ทำ event sourcing — state จริงอยู่ในตาราง ไม่มี replay; รับเฉพาะ aggregate_type/id ที่ใช้ query จริง | ตัดสินใจย้ายไป event sourcing (ไม่มีแผน) |
| Payment states เพิ่ม (Allocated/Adjusted/Refunded) | ขัดกับการออกแบบ ledger append-only — สิ่งเหล่านี้เป็น record ใน allocations/adjustments ไม่ใช่สถานะ; ยอดสุทธิคำนวณจาก ledger | — (การออกแบบ ledger คือคำตอบระยะยาวอยู่แล้ว) |
| RBAC เต็มรูป (ตาราง permissions/roles/role_permissions) | 3 role คงที่ครอบการใช้งานก๊วน; แก้ปัญหา hardcode ด้วย `domain/permissions/can()` รวมที่เดียวแทน — ย้าย mapping ลง DB ทีหลังแตะโมดูลเดียว | ลูกค้าต้องการ custom role ต่อก๊วน |
| `/api/v1/` ตั้งแต่แรก | แทบไม่มี public API — ส่วนใหญ่คือ server actions + cron/webhook ที่คุมเองทั้งสองฝั่ง | เปิด public API / mobile app (เริ่มที่ v1 ตอนนั้น) |
| DDD เต็มรูป (entities/repositories/aggregates) | ทีมเล็ก + MVP — รับเฉพาะวินัย domain/ แยก framework; ข้อยกเว้นโดยตั้งใจ: logic ลงชื่อ/waitlist อยู่ใน Postgres function เพราะ correctness ภายใต้ concurrency ชนะ portability | แยก backend เป็น service / ย้ายออกจาก Supabase |
| Cache layer สำหรับรายงาน/discovery | รายงานอ่านจาก rollup ซึ่งคือ cache อยู่แล้ว, landing เป็น static/ISR โดยธรรมชาติ, discovery ข้อมูลหลักร้อยแถว | รายงาน/discovery ช้าจริงจากการวัด ไม่ใช่จากการเดา |
| **[v3.3]** Feature lifecycle (Experimental→Beta→Stable→Deprecated) | governance สำหรับหลายทีมปล่อยฟีเจอร์พร้อมกัน — โปรเจกต์นี้มี feature flags ต่อก๊วน + release versioning พอแล้ว | มีทีม/ฟีเจอร์มากพอที่ต้อง track lifecycle แยกจาก release |

**[v3.2] กติกา ADR ต่อเนื่อง**: ทุกการตัดสินใจสถาปัตยกรรมสำคัญหลัง baseline (เปลี่ยน billing strategy, เพิ่ม mobile app, ย้าย infra, แก้ state machine) เขียนเป็น ADR entry ใหม่ต่อท้าย section นี้ — รูปแบบ 10 บรรทัด: context → options → decision → consequences ห้ามแก้เนื้อหาหลักของ baseline โดยตรง

**กติกา Deviation ช่วง implement**: เมื่อพบว่าส่วนใดของแผนทำตามตัวอักษรไม่ได้ (ข้อจำกัดของ Astryx Beta, Vault, pooling ฯลฯ) — **ห้ามแก้เงียบ**: บันทึกเป็น deviation note ใน PR description (ระบุ "แผนบอก X / ของจริงคือ Y / ตัดสินใจ Z เพราะ...") และถ้ากระทบสถาปัตยกรรม = ADR ใหม่; เอกสารนี้มีค่าก็ต่อเมื่อยังตรงกับโค้ดจริง

### ADR-001 — Billing computed in domain, committed via single DB function with expected-status guard

- **Context**: v3.3 เขียนว่า `transition_session(in_play → cancelled)` "เรียก SessionBilling ใน transaction เดียวกัน" แต่ transition_session เป็น Postgres function ส่วน SessionBilling เป็น pure TypeScript ใน `domain/billing` — DB function เรียก TS ไม่ได้ เกิด tension ระหว่างหลัก "domain ห้ามอยู่ใน DB" กับ "atomicity ต้องอยู่ใน DB"
- **Options**: (ก) ย้าย billing logic ลง SQL — เสีย testability และขัดกติกา domain; (ข) insert charges จาก server action นอก transaction ของ transition — เสีย atomicity สถานะกับเงินแยกขาดกันได้; (ค) server action orchestrate: คำนวณใน domain (TS) → commit ผ่าน DB function เดียวที่ validate + insert + event ใน transaction เดียว พร้อม optimistic guard
- **Decision**: เลือก (ค) — `close_session_with_charges(session_id, charges jsonb, expected_status)`: server action อ่าน snapshot + registrations + games → `SessionBilling.calculate()` ใน TS → เรียกฟังก์ชันนี้; ฟังก์ชันตรวจ `expected_status` ก่อน (สถานะเปลี่ยนระหว่างคำนวณ = raise `INVALID_TRANSITION` ให้คำนวณใหม่แล้ว retry) → validate transition → insert charges → event — ทั้งหมด atomic; ใช้ pattern เดียวกันทั้งปิดรอบปกติและยกเลิกกลางคัน
- **Consequences**: billing ยัง unit test ได้เต็มใน TS; เงินกับสถานะ commit พร้อมกันเสมอ; เพิ่มกติกาใน CLAUDE.md: "ห้ามย้าย billing ลง SQL และห้าม insert charges **ประเภท `session`** นอก DB function นี้ — charges ประเภท `monthly_fee` commit ผ่านฟังก์ชันของ MembershipBilling เอง (idempotent ต่อสมาชิก+เดือน ตาม Verification) เพราะไม่มี session ให้ transition"; **implementation note**: ฟังก์ชันนี้เปลี่ยน session status เอง จึงต้อง set GUC `app.allow_transition` ภายใน (หรือเรียก `transition_session()` ข้างใน) ไม่งั้น BEFORE UPDATE trigger ของตัวเองจะ block ตัวเอง; เพิ่ม test: เรียกด้วย expected_status ที่ล้าสมัย → ต้องได้ INVALID_TRANSITION และไม่มี charges เกิด

### ADR-002 — MVP-0 pricing model = flat_rate + cancellation policy schema

- **Context**: baseline สั่งให้ MVP-0 ทำ "pricing plan เฉพาะโมเดลที่ก๊วนผู้ใช้ใช้จริง 1 โมเดล" แต่ไม่ได้ระบุว่าโมเดลไหน และ `gangs.cancellation_policy` / `sessions.snapshot.cancellation_policy` เป็น jsonb ที่ไม่เคยกำหนดคีย์ไว้ — WO-1.3 ใช้ไปแล้วสองคีย์ (`cutoff_hours`, `allow_cancel_after_cutoff`) แต่ส่วน penalty ยังค้าง ทำให้ `domain/billing` เขียนต่อไม่ได้เพราะไม่รู้ว่าต้องอ่านอะไร
- **Options**: (ก) เดาคีย์ penalty แล้วแก้ทีหลัง — snapshot เป็นบันทึกแช่แข็ง นัดที่สร้างไปแล้วจะอ่านด้วย schema เก่าตลอดไป การเดาผิดจึงมีต้นทุนถาวร; (ข) ทำ pricing ครบสามโมเดลตั้งแต่แรก — ขัด baseline และดันงาน Phase 2.5 มาก่อนกำหนด; (ค) ถามเจ้าของก๊วนว่าใช้จริงแบบไหน แล้วตรึงทั้งสองอย่างเป็น ADR ก่อนเขียน billing
- **Decision**: เลือก (ค) — ยืนยันกับเจ้าของงาน 13 ส.ค. 2026: **pricing = `flat_rate`** (ทุกคนจ่ายเท่ากันต่อหัว, `params: { amount_per_person }`) และ **penalty = `full_share`** (ยกเลิกก่อน cutoff ไม่คิดเงิน · ยกเลิกหลัง cutoff หรือ no-show จ่ายเท่าคนที่มาเล่น) · schema ของ `cancellation_policy` ตรึงเป็น `{ cutoff_hours: number, allow_cancel_after_cutoff: boolean, penalty_type: 'full_share' | 'fixed' | 'percent' | 'none', penalty_value?: string }` โดย `penalty_value` จำเป็นเฉพาะ `fixed` / `percent` และเป็น string เสมอเพื่อกัน float
- **Consequences**: `flat_rate` ไม่ต้องนับลูก ⇒ Game Console (WO-2.7) ยังทำหน้านับลูกไว้ตาม baseline แต่ตัวเลขยังไม่เข้าสูตรคิดเงินใน MVP-0 — จะมีผลเมื่อเปิด `court_plus_shuttle` ใน Phase 2.5; `penalty_type` อีกสามค่าประกาศไว้ใน schema แล้วแต่ **ยังไม่ implement** ⇒ `domain/billing` ต้อง raise ถ้าเจอค่าที่ยังไม่รองรับ ห้ามคิดเป็น 0 เงียบๆ; snapshot ที่สร้างจากนี้ไปมี `snapshot_version: 1` พร้อมคีย์ครบ ⇒ นัดเก่าที่ snapshot ไม่มี penalty_type ให้ตีความเป็น `none` (ยังไม่มีนัดจริงในระบบ จึงไม่ต้อง backfill)

### ADR-003 — ข้อตกลงการแบ่งทีมในคอร์ท: แข็งสุดคู่กับอ่อนสุด

- **Context**: `games` มีคอลัมน์ `player1..player4` เรียงกันโดย**ไม่มีคอลัมน์ทีมและไม่มีกติกากำกับว่าใครคู่กับใคร** ส่วน baseline §Verification เขียนเงื่อนไข Matching Engine ไว้แค่ "skill ใกล้กัน" ซึ่งตีความได้ทั้ง "4 คนบนคอร์ทฝีมือใกล้กัน" และ "คู่สองฝั่งสูสี" — ตอน implement WO-2.6 จึงจัดแค่ความหมายแรก และ engine คืน tuple ที่เรียงจากอ่อนไปแข็ง ⇒ ถ้าผู้อ่านตีความว่า `player1&2 vs player3&4` (ซึ่งเป็นการอ่านที่เป็นธรรมชาติที่สุดของ 4 ช่องเรียงกัน) จะกลายเป็น **มืออ่อนสองคนเจอมือแข็งสองคน = การแบ่งที่แย่ที่สุด**
- **Options**: (ก) ปล่อยให้ engine จัดแค่ "4 คนบนคอร์ท" แล้วเขียน comment ใน schema ว่า 4 ช่องไม่มีความหมายเรื่องทีม — เลี่ยงการตัดสินใจแต่ผลักปัญหาไป UI และเสี่ยงถูกอ่านผิดอยู่ดี; (ข) จับมือใกล้กันคู่กัน (`1&2` = สองคนอ่อน) — คือพฤติกรรมปัจจุบันโดยบังเอิญ ทำให้เกมขาด; (ค) จับ **แข็งสุด + อ่อนสุด** เป็นทีม A และสองคนกลางเป็นทีม B แล้วตรึงความหมายของลำดับใน tuple
- **Decision**: เลือก (ค) — ยืนยันกับเจ้าของงาน 13 ส.ค. 2026 · เพิ่มขั้น **`PairTeams`** เข้า pipeline (baseline ออกแบบให้เสียบขั้นเพิ่มได้อยู่แล้ว) ต่อจาก `AvoidRepeat` และก่อน `CourtAssignment` — ต้องอยู่หลัง `AvoidRepeat` เพราะการสลับคนข้ามคอร์ทเพื่อเลี่ยงคู่ซ้ำจะทำลายสมดุลทีมที่จัดไปแล้ว · ตรึงข้อตกลง: **`players[0] & players[1]` = ทีม A · `players[2] & players[3]` = ทีม B** ตรงกับ `games.player1..player4`
- **Consequences**: ทุกที่ที่ต้องรู้ว่าใครอยู่ฝั่งไหนต้องเรียกผ่าน `teamsOf()` ห้าม index เอง ⇒ เปลี่ยนข้อตกลงทีหลังแก้ที่เดียว; ผลรวมฝีมือสองฝั่งต่างกันน้อยที่สุดเท่าที่กลุ่มนั้นทำได้ และมือใหม่ได้เล่นคู่กับมือเก่าเสมอ; **ยังไม่มีคอลัมน์ทีมใน `games`** — ความหมายอยู่ที่ลำดับคอลัมน์ ซึ่งบันทึกไว้เป็น `comment on column` ใน migration แล้ว ถ้าอนาคตต้องการเก็บผลแพ้ชนะรายทีมค่อยเพิ่มคอลัมน์ (expand → migrate → contract)

### ADR-004 — สัดส่วนเก็บเงินเมื่อยกเลิกกลางคัน: ก๊วนตั้ง default + แอดมินแก้ได้ตอนยกเลิก

- **Context**: baseline [v3.3] เขียนว่ายกเลิกกลางคัน (`in_play → cancelled`) ต้อง "คิดเงินบางส่วนตาม policy" แต่ **ADR-002 ตรึง schema ของ `cancellation_policy` ไว้โดยไม่มีคีย์สำหรับเรื่องนี้** — WO-2.8 จึงเลี่ยงด้วยการให้ค่าเป็น argument ของ server action และตั้ง default ไว้ที่ `0.5` ในโค้ด UI ⇒ ก๊วน**มองไม่เห็นและแก้ไม่ได้** ทั้งที่เป็นตัวเลขที่กระทบเงินโดยตรง และไม่มีที่ให้ตรวจย้อนหลังว่าตอนนั้นใช้สัดส่วนเท่าไร
- **Options**: (ก) คงไว้เป็นค่าคงที่ในโค้ด — เร็วแต่ก๊วนแก้ไม่ได้และขัดเจตนาของ baseline ที่บอกว่า "ตาม policy"; (ข) ให้แอดมินกรอกทุกครั้งโดยไม่มี default — ปลอดภัยแต่ตอนไฟดับ/ฝนรั่วคือช่วงที่วุ่นที่สุด การบังคับให้คิดเลขสดเพิ่มโอกาสกรอกผิด; (ค) เพิ่มคีย์ `midway_cancel_ratio` เข้า policy เป็น **ค่าตั้งต้นระดับก๊วน** แล้วให้แอดมิน**แก้ได้ตอนกดยกเลิก**
- **Decision**: เลือก (ค) — ยืนยันกับเจ้าของงาน 13 ส.ค. 2026 · เพิ่ม `midway_cancel_ratio: number` (0–1) เข้า schema ของ `cancellation_policy` ต่อจาก ADR-002 · ก๊วนตั้งค่าได้ในหน้าตั้งค่า (ค่าเริ่มต้นของก๊วนใหม่ = `0.5`) · ตอนกดยกเลิกกลางคัน UI เติมค่านี้ให้แล้วแอดมินแก้ได้ · ค่าที่ใช้จริงถูกบันทึกลง `breakdown.midway_cancel_ratio` ของทุก charge
- **Consequences**: **ไม่ต้องขึ้น `snapshot_version`** เพราะเป็นการเพิ่มคีย์แบบ additive ที่มีค่า fallback ปลอดภัย — snapshot เก่าที่ไม่มีคีย์นี้อ่านได้เป็น `0.5` เท่าเดิม (`fromJson` เติมให้) ⇒ นัดที่สร้างก่อนหน้านี้ยังคิดเงินเหมือนเดิมทุกประการ; ค่าที่ใช้ยัง**อ่านจาก snapshot ของนัดนั้น** ตามกติกาเดิม ⇒ ก๊วนแก้ default ทีหลังไม่กระทบนัดที่จัดไปแล้ว; ตัวเลขที่ใช้จริงตรวจย้อนหลังได้จาก `breakdown` ไม่ใช่เดาจากโค้ดเวอร์ชันนั้น

### ADR-005 — `court_plus_shuttle`: หารค่าสนามกับค่าลูกแยกก้อน + เศษรายคนแบบ largest remainder

- **Context**: baseline ระบุแค่ว่ามี strategy `CourtSplitStrategy` และ "สมาชิกรายเดือนที่มาเล่น: ค่าสนาม = 0, ค่าลูกคิดตามจริงหรือรวมในรายเดือน (ตั้งค่าใน pricing plan)" แต่ไม่ได้บอกว่า **หารยังไง** เมื่อกลุ่มคนที่จ่ายค่าสนามกับกลุ่มที่จ่ายค่าลูก**ไม่ใช่กลุ่มเดียวกัน** และไม่ได้บอกว่า `rounding_surplus` ต่อ charge (คอลัมน์ที่มีอยู่ใน `breakdown` ตั้งแต่ MVP-0) ต้องเก็บอะไรเมื่อเศษเกิดขึ้นจริง — ตัวเลขนี้กระทบเงินโดยตรงและตรวจย้อนหลังไม่ได้ถ้าเดาผิด
- **Options**: (ก) รวมค่าสนาม+ค่าลูกเป็นก้อนเดียวแล้วหารทีเดียว — ง่ายที่สุด แต่สมาชิกรายเดือนจะได้ส่วนลด**ค่าลูก**ไปด้วยโดยไม่มีใครตั้งใจ (เพราะยอดรวมถูกลดจากการที่เขาไม่จ่ายค่าสนาม) ⇒ ขัดกติกาของ baseline; (ข) หารแยกสองก้อนแต่เก็บ surplus แค่ระดับนัด — reconcile รายคนไม่ได้ คนทักว่า "ทำไมผมจ่าย 115 ทั้งที่ 800 หาร 7 ได้ 114.29" แล้วตอบไม่ได้จากข้อมูล; (ค) หารแยกสองก้อน + บันทึกเศษของ**แต่ละคน**ลง `breakdown.rounding_surplus`
- **Decision**: เลือก (ค) — **ค่าสนาม** หารเฉพาะผู้จ่ายที่ไม่ใช่สมาชิกรายเดือน · **ค่าลูก** หารตาม `monthly_member_pays_shuttle` ของแผนราคา · ปัดแต่ละก้อนตาม `rounding_policy` แยกกัน · "ส่วนที่ควรจ่ายจริง" ของแต่ละคนคำนวณด้วย largest remainder (`distributeExactShares()`) ⇒ `rounding_surplus` ต่อ charge = จ่ายจริง − ส่วนที่ควรจ่าย และ **บวกกันทุกคนได้ surplus ของนัดเป๊ะ** · `pricing_plan.monthly_member_pays_shuttle` ถูกเพิ่มเข้า snapshot แบบ additive (ไม่ขึ้น `snapshot_version` — แนวเดียวกับ ADR-004, ค่าที่ขาดอ่านเป็น `true` = default ของ schema)
- **Consequences**: จำนวนลูก**ไม่ได้อยู่ใน snapshot** — snapshot แช่แข็ง "ราคา" ส่วน "ปริมาณ" อ่านจาก `games` ตอนปิดรอบ ⇒ WO-2.5-A (แก้ `shuttles_used` ได้ก่อนปิดรอบเท่านั้น) เป็นเงื่อนไขที่ทำให้โมเดลนี้ปลอดภัยพอจะเปิด; นัดที่ทุกคนเป็นสมาชิกรายเดือนจะได้ `rounding_surplus` **ติดลบเท่าค่าสนามทั้งก้อน** — ตั้งใจ เพราะต้นทุนไม่ได้หายไปไหน ก๊วนรับเองจากค่ารายเดือน และต้องเห็นในรายงาน; โหมด `absorb` ปัดลงเป็น**สตางค์** ไม่ใช่บาท (ตาม `splitEvenly()` เดิม) ⇒ ส่วนที่ก๊วนรับมักเป็นหลักสตางค์; `flat_rate` ยังไม่มีการหาร ⇒ `rounding_surplus` เป็น `0.00` เหมือนเดิมทุกประการ มีเทสต์คุมไม่ให้เปลี่ยน

### ADR-006 — `monthly` เป็นแผน**แยกแถว** ไม่ใช่โมเดลราคาของนัด + กติกาเข้ากลางเดือน

- **Context**: `gang_pricing_plans.type` มีค่า `monthly` อยู่ใน CHECK constraint ตั้งแต่ migration 0003 ราวกับเป็น "โมเดลคิดเงินของนัด" แบบเดียวกับ `flat_rate` / `court_plus_shuttle` แต่ `session_charges` แยก `type = 'monthly_fee'` ที่ **`session_id` ต้องเป็น null** ⇒ สองที่นี้อธิบายคนละเรื่องกัน และโค้ดเดิม (`createSession()`, หน้าตั้งค่า) หยิบ "แผน active ล่าสุด" มาใช้โดยไม่ดู type ⇒ ถ้าก๊วนตั้งค่าสมาชิกรายเดือน นัดถัดไปจะแช่แข็ง snapshot ที่คิดเงินไม่ได้ นอกจากนี้ baseline เขียนแค่ "generate `session_charges` ประเภท `monthly_fee` ต่อสมาชิกรายเดือน" โดย**ไม่ได้ระบุว่าคนที่สมัครกลางเดือนคิดยังไง**
- **Options**: (ก) ให้ `monthly` เป็นโมเดลของนัด แล้วคิดทุกคนเป็น 0 ตอนปิดรอบ — ก๊วนที่มีทั้งสมาชิกรายเดือนและขาจรจะเก็บเงินขาจรไม่ได้เลย; (ข) ย้ายค่าสมาชิกรายเดือนไปเป็นคอลัมน์ใน `gangs` — ขัด schema ที่มีอยู่ และเสียประวัติการเปลี่ยนราคา; (ค) ให้ `monthly` เป็นแผน**คนละแถว**ที่อยู่คู่กับแผนต่อนัดได้ แล้วกันไม่ให้ path ของนัดหยิบไปใช้
- **Decision**: เลือก (ค) — เพิ่ม `SESSION_PRICING_TYPES = [flat_rate, court_plus_shuttle]` ใน `domain/policies/pricing` และทุก query ที่หา "แผนราคาของนัด" ต้องกรองด้วยลิสต์นี้ · `monthly` จะไม่มีวันอยู่ใน `IMPLEMENTED_PRICING_TYPES` (ลิสต์นั้นแปลว่า "ปิดรอบแล้วคิดเงินได้") · **กติกาเข้ากลางเดือน = เก็บเต็มเดือน ไม่มี pro-rate** และ **ออกบิลต้นเดือนสำหรับเดือนนั้น (จ่ายล่วงหน้า)** — ยืนยันกับเจ้าของงาน 13 ส.ค. 2026
- **Consequences**: ก๊วนหนึ่งมีได้ทั้งสองแผนพร้อมกัน — ขาจรจ่ายต่อนัด สมาชิกรายเดือนจ่ายเป็นเดือนแล้วค่าสนามเป็น 0 ตอนปิดรอบ (ADR-005) ⇒ สองใบนี้ต่อกันพอดี; ผลของ "เก็บเต็มเดือน" คือคนที่สมัครหลัง cron รันไปแล้วต้องได้บิลของเดือนนั้นด้วย ⇒ cron ตั้งเป็น **รายวัน** (ไม่ใช่รายเดือน) โดยออกบิลของเดือนปัจจุบันเสมอ ซึ่งปลอดภัยเพราะ `commit_monthly_fees()` idempotent ต่อสมาชิก+เดือน และมีปุ่มให้แอดมินสั่งเองได้; เดือนที่ออกบิลอ่านจาก **timezone ของก๊วน** ไม่ใช่ UTC ไม่งั้นก๊วนไทยจะออกบิลเดือนที่แล้วซ้ำทุกวันที่ 1; ยกเลิกสถานะรายเดือนกลางเดือนยัง**ไม่คืนเงิน** — บันทึก `monthly_member_until` แล้วเดือนถัดไปไม่ออกบิล (refund เป็นงาน WO-2.5-D)

### ADR-007 — "ก๊วน public เปิดอ่าน metadata" = อ่านผ่าน `search_public_gangs()` ไม่ใช่เปิดแถวในตาราง `gangs`

- **Context**: baseline §RLS เขียนว่า "ก๊วน public เปิดอ่าน metadata" ซึ่ง WO-1.4 implement เป็น policy ระดับแถว `gangs_select_public` (`is_public = true` เปิดให้ `anon` + `authenticated`) — แต่ **RLS กรองได้แค่แถว ไม่ใช่คอลัมน์** ⇒ ใครก็ได้ที่ถือ anon key ยิง `GET /rest/v1/gangs?select=promptpay_id&is_public=eq.true` แล้วได้ **PromptPay ID (เบอร์โทร) ของทุกก๊วนสาธารณะ** พร้อม `settings` / `cancellation_policy` / `features` (ยืนยันของจริงบน local 15 ส.ค. 2026) · WO-3.E (Discovery) ทำให้ก๊วนเปิด `is_public` กันมากขึ้น ⇒ ความเสี่ยงโตตามฟีเจอร์
- **Options**: (ก) column-level grant ให้ `anon` เห็นเฉพาะคอลัมน์ปลอดภัย — ปิดได้แค่ครึ่งเดียวเพราะ grant เป็น**ราย role ไม่ใช่รายแถว** ⇒ ผู้ใช้ที่ล็อกอินแล้วแต่ไม่ใช่สมาชิกยังอ่านได้ทั้งหมด (และสมาชิกจริงต้องใช้คอลัมน์เหล่านั้น จึงลด `authenticated` ไม่ได้); (ข) ถอด `gangs_select_public` ทิ้ง แล้วให้ทุกการอ่านของ "คนนอก" ผ่าน `search_public_gangs()` (security definer ที่เลือกคอลัมน์เอง); (ค) ย้าย `promptpay_id` ไปตาราง server-only แบบ `gang_line_configs`
- **Decision**: เลือก **(ข)** — 16 ส.ค. 2026 · ถอด `gangs_select_public` + `revoke select on public.gangs from anon` (migration `0034`) · คนนอกอ่านก๊วนได้ทางเดียวคือฟังก์ชันที่ประกาศคอลัมน์ไว้ชัด ⇒ เจตนาของ baseline ("ก๊วน public ค้นเจอ") ยังอยู่ครบ เปลี่ยนแค่ **ช่องทาง** · เลือก (ข) ก่อน (ค) เพราะ (ค) ปิดเฉพาะ `promptpay_id` แต่ `settings` / `cancellation_policy` ยังหลุดอยู่ดี — (ค) ยังทำเพิ่มได้ทีหลังเป็น defense in depth (จดไว้ใน `BACKLOG.md`)
- **Consequences**: `anon` ไม่มีสิทธิ์ใดๆ บนตาราง `gangs` อีกต่อไป ⇒ **grant matrix เปลี่ยน** (`gangs` → `anon: []`) และเทสต์ `tests/rls/grant-matrix.test.ts` ถูกอัปเดตให้ตรง; สมาชิก/แอดมินไม่กระทบเลย (`gangs_select_member` ยังทำงานเหมือนเดิม — ทุกหน้าในแอปอ่านก๊วนในฐานะสมาชิกอยู่แล้ว ตรวจครบทุกจุดเรียกก่อนถอด); **หน้าโปรไฟล์ก๊วนสาธารณะในอนาคตต้องเพิ่ม DB function ที่คืนคอลัมน์ที่เลือกไว้** ห้าม query ตาราง `gangs` ตรงจากฝั่งคนนอก; `/join/[token]` และหน้า guest ไม่กระทบเพราะใช้ RPC ที่ grant ให้ `service_role` อยู่แล้ว

### ADR-008 — อัป Next.js 15 → 16 ตอนเริ่ม Phase 5 (แทนที่จะแบก `overrides` ไว้)

- **Context**: baseline §Stack ระบุ "Next.js 15" และ `CLAUDE.md §7` pin ไว้ที่ `15.5.23` · แต่ `npm audit` มี **4 high** ที่ค้างมาตั้งแต่ WO-1.1: `nanoid <3.3.18` และ `postcss <=8.5.22` + `sharp <0.35.0` ซึ่งเป็น **transitive ของ `next@15.5.23`** ⇒ `npm audit fix --force` จะดัน next@16 เอง · Phase 5 มี §Security Checklist เป็น gate ก่อน deploy ⇒ ต้องตัดสินให้จบก่อนทำ CSP (`WO-5.B`) และ Playwright (`WO-5.E`) ไม่งั้นอัปทีหลังต้องรันสองใบนั้นซ้ำ
- **Options**: (ก) **อยู่กับ 15 + `overrides`** (`nanoid`/`postcss`/`sharp`) — วัดแล้วได้ `audit = 0` ทันทีโดยไม่แตะโค้ดเลย แต่ต้องแบก override สามตัวตลอดไป และ **เลื่อนต้นทุนการอัปไปโดยไม่ได้ลดมัน**; (ข) **ขึ้น 16 ตอนนี้** — จ่ายค่าแก้วันนี้ แล้ว 5.B/5.E ทำบน config สุดท้าย; (ค) เลื่อนไปหลัง `v1.0.0` — regression จะไปตกกับก๊วนที่ใช้จริง
- **Decision**: เลือก **(ข)** — 16 ส.ค. 2026 · **วัดของจริงก่อนตัดสิน** โดยอัปใน git worktree แยก: `tsc --noEmit` **0 error** · `eslint` สะอาด · `npm test` **673/673 ผ่าน** · `build` พัง **จุดเดียว** คือ `<Link as={NextLink}>` ของ Astryx บนหน้าแรก (Next 16 ห้ามส่ง component ข้ามขอบ RSC ไปให้ client component) ⇒ ต้นทุนจริงเล็กกว่าที่กลัวมาก · แก้ด้วย **`LinkProvider`** ของ Astryx ที่ `app/providers.tsx` (ฝั่ง client อยู่แล้ว) แทนการส่ง `as` ข้ามขอบ · ย้าย `middleware.ts` → `proxy.ts` ตามชื่อใหม่ของ Next 16 ไปพร้อมกัน · `CLAUDE.md §7` อัปเป็น `next@16.3.1` (React ยัง `19.2.8` · Astryx ยัง pin `0.3.0` ทั้งชุด)
- **Consequences**: `npm audit` = **0 vulnerabilities** โดย**ไม่ต้องมี `overrides`** เลย ⇒ ไม่มีของแปลกปลอมใน `package.json` ให้คนรุ่นหลังงง · 🔴 **ห้ามส่ง `as={NextLink}` จาก server component อีก** — ลิงก์ Astryx ทุกที่ได้ `next/link` จาก `LinkProvider` อัตโนมัติแล้ว (ถ้าเผลอส่ง จะพังตอน build ไม่ใช่ตอน runtime ซึ่งดี) · `tsconfig.json` ถูก Next แก้ให้เอง (`jsx: react-jsx` + include `.next/dev/types`) และ commit ตามไปแล้ว · หน้าแรกยังเป็น **static + ISR (`○ /` Revalidate 1h)** ตาม WO-3.F · `lib/supabase/middleware.ts` ยังใช้ชื่อเดิมโดยตั้งใจ (เป็น helper ของ Supabase ไม่ใช่ entry point ของ Next) · ความเสี่ยงที่เหลือ: Astryx 0.3.0 เป็น Beta ที่ทดสอบกับ Next 16 ไว้เท่าที่เทสต์ของเราครอบ ⇒ `WO-5.E` (Playwright) จะเป็นตัวจับของที่เทสต์ระดับ unit/DB มองไม่เห็น

### ADR-009 — ไม่ย้าย `promptpay_id` ออกจาก `gangs` (ปิดทางเลือก (ค) ของ ADR-007)

- **Context**: ADR-007 ปิดช่องที่ **คนนอกก๊วน** อ่าน `promptpay_id` ได้ไปแล้ว และเปิดทางเลือก (ค) ไว้ว่า "ย้าย `promptpay_id` ไปตาราง server-only" เป็น defense in depth · `WO-5.D` มาถึงจุดที่ต้องทำจริงจึงตรวจของจริงก่อน แล้วพบว่า **`sessions.snapshot.promptpay_id` เก็บค่าเดียวกันไว้อยู่แล้ว** (ของจริงบน local: **723 นัด**) และ `sessions_select_member` ให้สมาชิกอ่าน snapshot ได้ทั้งก้อน
- **Options**: (ก) **ปล่อยไว้** — ยอมรับว่าสมาชิกของก๊วนเห็น PromptPay ของก๊วนตัวเอง (ซึ่งเขาต้องใช้จ่ายเงินอยู่แล้ว); (ข) ย้ายคอลัมน์อย่างเดียว — ได้ผลเชิงสัญลักษณ์ เพราะค่ายังอยู่ใน snapshot; (ค) ย้ายคอลัมน์ **และ** เลิกเก็บลง snapshot ใหม่ แล้วให้หน้าจ่ายเงินอ่านผ่าน DB function — ต้องแตะ snapshot ที่ **แช่แข็งราคาไว้ห้ามแก้ย้อนหลัง** (CLAUDE.md §2.4)
- **Decision**: เลือก **(ก)** — 17 ส.ค. 2026 (เจ้าของงานตัดสิน) · เหตุผล: ผู้รับข้อมูลคือ **สมาชิกในก๊วนที่ต้องโอนเงินให้ก๊วนนั้นอยู่แล้ว** ⇒ ไม่ใช่การรั่วไปยังคนที่ไม่ควรเห็น · ส่วนคนนอกถูกปิดไปแล้วโดย ADR-007 ⇒ งานที่เหลือคือรื้อ snapshot เพื่อผลลัพธ์ที่เล็กมาก ซึ่งเสี่ยงกว่าประโยชน์
- **Consequences**: `gangs.promptpay_id` อยู่ที่เดิม และ `sessions.snapshot` ยังเก็บค่าตอนสร้างนัดเหมือนเดิม (ไม่มีอะไรต้อง migrate) · 🔴 **เงื่อนไขที่ทำให้ต้องกลับมาทบทวน**: ถ้าวันหนึ่งเปิดให้ "คนนอกก๊วน" อ่าน `sessions` หรือ `snapshot` ได้ (เช่นหน้าโปรไฟล์ก๊วนสาธารณะที่โชว์ตารางนัด) ต้องกลับมาปิดเรื่องนี้ก่อนเสมอ · รายการใน `BACKLOG.md` ถูกปิดพร้อมบันทึกเหตุผลนี้
