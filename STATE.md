# STATE — สถานะงานล่าสุด

> เอกสาร handoff ระหว่าง session (ที่ `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง)
> **อัปเดตล่าสุด: 13 ส.ค. 2026** · MVP-0 เสร็จ (tag `v0.1.0`) · กำลังทำ **Phase 2.5** — `WO-2.5-A` … `WO-2.5-E` เสร็จแล้ว
>
> 📌 กลับมาทำงานต่อ: อ่านไฟล์นี้ → `CLAUDE.md` → แล้วเริ่มที่ **"ทำอะไรต่อ"** ด้านล่าง

---

## 1. ความคืบหน้า

| WO | งาน | สถานะ |
|---|---|---|
| **1.1** | Scaffold (Next.js 15 + Tailwind v4 + Astryx + CLAUDE.md) | ✅ **เสร็จ** `21ecf3a` |
| **1.2** | Schema migrations (28 ตาราง + index + constraint) | ✅ **เสร็จ** `22a7713` |
| **1.3** | DB functions (6 ตัว) + GUC trigger + rate_limits | ✅ **เสร็จ** — DoD ผ่านครบ 4 ข้อ |
| **1.4** | RLS + security definer + storage buckets | ✅ **เสร็จ** — DoD ผ่านครบ 5 ข้อ |
| **1.5** | Cron setup + seed | ✅ **เสร็จ** — DoD ผ่านทั้งสองข้อ |

🎉 **Phase 1 เสร็จครบ** — ฐานข้อมูล + ฟังก์ชัน + RLS + storage + cron + seed พร้อมใช้

✅ **แตก WO ของ Phase 2 แล้ว** (12 ส.ค. 2026) — อยู่ใน `AGENT-EXECUTION.md` ท้ายไฟล์
แตก 10 ใบ (WO-2.1 ถึง WO-2.10) พร้อมตารางข้อจำกัดจาก Phase 1 ที่ทุกใบต้องยึด

---

## 2. Git

```
branch: claude/badminton-group-system-4pfs7o   (ทำงานอยู่บนนี้ — WO ทุกใบ commit ที่นี่)
        main                                    (มีแค่ commit เอกสาร baseline)
```

✅ **PR #1 merge เข้า `main` แล้ว + tag `v0.1.0`** (13 ส.ค. 2026)
branch `claude/...` ยังใช้ทำงานต่อได้ — Phase 2.5 ค่อยเปิด PR ใบใหม่

ปัญหา 403 เดิมแก้ด้วยการสลับบัญชี `gh` ที่ active มาเป็น **`webaon`** (เจ้าของ repo)
ไม่ได้แก้ด้วยการเพิ่ม `triple-tgg` เป็น collaborator ⇒ ถ้าวันหนึ่ง push แล้วเจอ 403 อีก
ให้เช็คก่อนว่า active account เป็นตัวไหน:

```bash
gh auth status                 # ดูว่าใคร active
gh auth switch --user webaon   # สลับกลับถ้าไม่ใช่
```

ยังไม่ได้เปิด PR — `claude/...` กับ `main` แยกกันอยู่

---

## 3. Supabase

### ✅ Local ใช้ได้แล้ว (blocker เดิมเคลียร์หมด)

ดิสก์ว่าง ~71 GB · Docker กลับมาปกติ · **pooler (supavisor) healthy บนพอร์ต 54329**

🔴 **ต้องสตาร์ตแบบตัดบริการ — ตัวที่ขึ้นไม่ได้คือ analytics stack (logflare + vector) กับ studio**

```bash
npm run supabase -- start -x studio,logflare,vector,edge-runtime,mailpit
```

ได้ครบทุกตัวที่ Phase 1–2 ต้องใช้: `db` · `pooler` · `kong` · `rest` · `auth` ·
**`storage`** · `realtime` · `pg_meta` — ทั้งหมด healthy ใช้ RAM รวม **~1.2 GB จาก 3.8 GB**

> ⚠️ **แก้ข้อสรุปที่เคยเขียนผิดไว้**: เคยบันทึกว่า "เต็มชุดไม่ขึ้นเพราะ Docker ได้ RAM แค่ 4 GB"
> — **ไม่จริง** วัดแล้วเหลือ headroom เกินครึ่ง storage/realtime ขึ้นได้สบาย
> สาเหตุจริงจำกัดอยู่ที่ logflare/vector/studio เท่านั้น ⇒ **ไม่ต้องไปเพิ่ม RAM ให้ Docker**

| | |
|---|---|
| DB (direct) | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| **DB (pooled)** | `postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres` |
| API | `http://127.0.0.1:54321` |

⚠️ user ของ pooler ต้องเป็น `postgres.<tenant>` — tenant ของ local คือ **`pooler-dev`**
(ดูได้จาก `docker exec supabase_pooler_gang-badminton cat /app/pooler_tenant.exs`)

> **[D-6]** baseline §Verification อ้าง pooled port = **6543** ซึ่งเป็นพอร์ตของ Supabase **cloud**
> — ของ local คือ **54329** (ตั้งไว้ใน `config.toml`) เจตนาของ baseline คือ "ต้องผ่าน
> transaction pooling" ซึ่งทำได้ครบ เปลี่ยนแค่เลขพอร์ตให้ตรงกับสภาพแวดล้อมจริง

### Cloud

| | |
|---|---|
| project / ref | **gang-badminton** · `emmzeriekkjryhucvctx` |
| migrations ที่ apply แล้ว | **23 / 23** ✅ (push ล่าสุด 13 ส.ค. 2026) |
| ข้อมูลใน DB | 0 แถวทุกตาราง (ไม่ได้ push seed ขึ้นไป — `seeds: []`) |
| RLS | ✅ 29/29 ตาราง · 50 policies + 16 บน storage.objects |
| storage | ✅ 4 buckets · cron ✅ 3 jobs active |

✅ **cloud พร้อมใช้แล้ว** — ตรวจยืนยันหลัง push ว่า `anon` เรียก DB function ไม่ได้สักตัว
และอ่านได้แค่ `gangs` ตารางเดียว (ก๊วน public เท่านั้นตาม policy)

push ขึ้น cloud เมื่อพร้อม (ไฟล์ ref หายหลัง clone ใหม่ เพราะ `.temp` ถูก gitignore):
```bash
mkdir -p supabase/.temp && printf 'emmzeriekkjryhucvctx' > supabase/.temp/project-ref
npm run supabase -- db push --linked
```
`supabase link` ยังพังจากบั๊ก CLI 2.112.0 (`inserted_at`) — workaround คือเขียนไฟล์ ref เอง

---

## 4. WO-1.3 / WO-1.4 — สิ่งที่สร้าง

### WO-1.3

**migrations ใหม่ 2 ไฟล์** (0001–0007 apply บน cloud แล้ว **ห้ามแก้**)

| ไฟล์ | เนื้อหา |
|---|---|
| `20260811000008_status_guard_and_rate_limits.sql` | `enforce_status_transition()` + trigger บน `sessions`/`payments` · unlogged `rate_limits` + `check_rate_limit()` |
| `20260811000009_db_functions.sql` | ฟังก์ชันหลัก 6 ตัว + helper 3 ตัว + `claim_notifications()` |

**กลไก GUC**: `app.allow_transition` เก็บ **id ของแถวที่กำลัง transition** (ไม่ใช่ boolean)
และถูกเคลียร์ทันทีหลัง UPDATE ⇒ ใบอนุญาตเป็น one-shot ต่อแถว ไม่ค้างทั้ง transaction

**Deviation ที่บันทึกไว้** (อยู่หัวไฟล์ 0009 — อ่านที่นั่นได้รายละเอียดเต็ม):
- **D-7** `close_session_with_charges` เพิ่มพารามิเตอร์ `p_to_status` (default `billing`)
  เพราะ signature ตามตัวอักษรบอกไม่ได้ว่าจะไป `billing` หรือ `cancelled`
- **D-8** สูตร reliability + ลำดับคิว (ยืนยันกับเจ้าของงาน 11 ส.ค.):
  `ORDER BY ordering ASC, reliability DESC, created_at ASC` ·
  `reliability = checked_in / (checked_in + no_show + late_cancel)` · ไม่มีประวัติ = `1.0`
- **D-9** `cancel_registration` **ไม่ insert charges** (ADR-001) — บันทึกแค่ `is_late_cancel`
  ลง event ให้ `domain/billing` คิดเงินตอนปิดรอบ
- **D-10** ที่นั่งที่ใช้แล้ว = `confirmed + checked_in` (ไม่ใช่แค่ confirmed ไม่งั้น overbook)
- **D-11** เพิ่ม `claim_notifications()` นอกลิสต์ 6 ฟังก์ชัน เพราะ DoD ข้อ 3 ต้องมี worker จริงให้ทดสอบ

### WO-1.5

| ไฟล์ | เนื้อหา |
|---|---|
| `20260812000012_cron_jobs.sql` | pg_cron + `sweep_waitlist` / `sweep_stuck_notifications` / `purge_rate_limits` + ตั้งตาราง 3 job |
| `supabase/seed/seed.sql` | ก๊วนตัวอย่าง: 10 สมาชิก · 2 นัด (เปิดรับ 8+2 waitlist / ปิดรอบแล้วมี charges 6 ใบ) |
| `shared/api.ts` · `shared/errors.ts` | API response contract + `ErrorCode` union ตาม `docs/errors.md` |
| `lib/supabase/admin.ts` | service-role client (`import 'server-only'` กันหลุดไป browser ตั้งแต่ build) |
| `server/cron/{auth,jobs}.ts` · `app/api/cron/[job]/route.ts` | ตรวจ `CRON_SECRET` แบบ timing-safe + dispatcher |
| `vercel.json` · `.env.example` | ตาราง Vercel Cron + ตัวแปรที่ต้องตั้ง |

**[D-16]** เพิ่มฟังก์ชัน sweep 3 ตัวนอกลิสต์ baseline — เป็น "ตัวเรียก" ล้วนๆ ไม่มี logic เอง
ตามกติกา CLAUDE.md §2.1 *"cron sweep มีไว้กันงานหลุด ไม่ใช่กันชน"*

🔴 **seed เดินตามเส้นทางเดียวกับ production ทุกขั้น** — ไม่ยัด status ตรงและไม่ insert
registrations เอง แต่เรียก `transition_session()` / `register_to_session()` /
`close_session_with_charges()` ⇒ ถ้า state machine เปลี่ยนแล้ว seed พัง นั่นคือสัญญาณที่ต้องการ

⚠️ **pg_cron กับ Vercel Cron ตั้งซ้อนกันโดยตั้งใจ** — pg_cron เป็นตัวหลัก (ไม่พึ่งแอป)
Vercel Cron เป็นเส้นสำรอง ปลอดภัยเพราะทั้งสามงาน idempotent
**ถ้าเพิ่มงานที่ไม่ idempotent ต้องเลือกอย่างใดอย่างหนึ่ง ห้ามตั้งทั้งคู่**

⚠️ **`claim_notifications()` จงใจไม่ต่อกับ cron** — Phase 1 ยังไม่มีตัวส่งข้อความจริง
claim แล้วไม่ส่ง = ข้อความหาย (ค้าง processing รอ sweep คืนคิววนไป) ⇒ ต่อพร้อม worker ใน Phase 2

### WO-1.4

| ไฟล์ | เนื้อหา |
|---|---|
| `20260811000010_rls.sql` | helper 7 ตัว + เปิด RLS ครบ 29 ตาราง + policies + **table GRANT** + ล็อก EXECUTE |
| `20260811000011_storage_buckets.sql` | 4 buckets + 16 policies บน `storage.objects` |

🔴 **บทเรียนสำคัญที่สุดของ WO นี้ — RLS อย่างเดียวไม่พอ**
โปรเจกต์นี้ default ACL ของ schema `public` ให้ anon/authenticated/service_role แค่
`Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) **ไม่มี SELECT/INSERT/UPDATE/DELETE**
⇒ ต่างจาก template ทั่วไปของ Supabase ที่ grant ทุกอย่างแล้วพึ่ง RLS ล้วน
ผลคือ deny-by-default (ดี) แต่ **ตารางใหม่ที่ลืม grant จะใช้ไม่ได้เงียบๆ**
พังตอน runtime เป็น error `42501` ไม่ใช่ตอน migrate

➡️ **ตารางใหม่ทุกตารางต้องทำครบสามอย่าง: `enable row level security` + `grant` + `create policy`**

**Deviation ที่บันทึกไว้** (หัวไฟล์ 0010/0011):
- **D-12** `profiles` อ่านได้เฉพาะตัวเอง + คนที่อยู่ก๊วนเดียวกัน (`shares_gang_with()`)
  — baseline ไม่ได้ระบุ ถ้าเปิดหมดจะ enumerate ผู้ใช้ทั้งแพลตฟอร์มได้
- **D-13** ตารางที่เขียนผ่าน DB function เท่านั้น (`session_registrations`, `session_charges`,
  `event_logs`) **ไม่มี policy เขียนและ grant แค่ `select`** — ตั้งใจ ไม่ใช่ลืม
- **D-14** `sessions` INSERT บังคับ `status = 'draft'` ผ่าน WITH CHECK
- **D-15** สิทธิ์ของ storage ตรวจจาก **path** (`storage.objects` ไม่มีคอลัมน์ `gang_id`)
  ⇒ `payment-slips/<gang_id>/<payment_id>/<file>` ฯลฯ — **server ต้องประกอบ path เอง
  ห้ามรับจาก client** ไม่งั้นสิทธิ์ผิดทันที

⚠️ `avatars` / `gang-assets` เป็น bucket **public** — ใครมี URL เปิดดูได้โดยไม่ผ่าน RLS
ห้ามเอาของที่เป็นความลับไปวาง สลิปต้องอยู่ `payment-slips` เท่านั้น

---

## 5. เทสต์ — DoD ผ่านครบ

```bash
npm test          # vitest run — 305 tests, 30 files
```

รันผ่าน **pooled port 54329** ตามที่ baseline §Verification บังคับ

| ไฟล์ | คุมอะไร |
|---|---|
| `tests/concurrency/register-no-overbook.test.ts` | **DoD 1** — 2 request ชน lock จริง + 8 request พร้อมกัน ไม่ overbook · guest/invite token |
| `tests/concurrency/promote-waitlist.test.ts` | **DoD 2** — cancel พร้อมกัน 2 คน ไม่ซ้ำ ไม่ข้ามคิว · reliability tiebreak (D-8) |
| `tests/concurrency/notification-worker.test.ts` | **DoD 3** — SKIP LOCKED, worker 2/4 ตัวไม่หยิบงานซ้ำ |
| `tests/concurrency/close-session-charges.test.ts` | **DoD 4** — `expected_status` ล้าสมัย → `INVALID_TRANSITION` + **ไม่มี charges เลย** |
| `tests/concurrency/status-guard.test.ts` | GUC trigger + `check_rate_limit()` |
| `tests/rls/tenant-isolation.test.ts` | **DoD WO-1.4 ทั้ง 5 ข้อ** — ข้ามก๊วน · line_configs · สลิป · guest token ข้ามนัด · recursion |
| `tests/rls/write-guards.test.ts` | ช่องโหว่ WO-1.3 ที่ปิดแล้ว — EXECUTE grant · INSERT status · เขียน registrations ตรง |
| `tests/cron/cron.test.ts` | **DoD WO-1.5** — CRON_SECRET (รวม fail-closed + timing-safe) · pg_cron schedule · sweep ทั้งสาม |
| `tests/seed/idempotency.test.ts` | **DoD WO-1.5** — รัน seed ไฟล์จริงซ้ำ 3 รอบ สถานะต้องไม่เปลี่ยน |
| `tests/rls/grant-matrix.test.ts` | สิทธิ์ระดับตารางตรงกับที่ประกาศไว้เป๊ะ — กัน default ACL ของ environment แอบให้สิทธิ์เกิน |
| `tests/domain/can.test.ts` | **WO-2.1** — ทุก role × action + feature flag (pure ไม่แตะ DB) |
| `tests/domain/action-helper.test.ts` | **WO-2.1** — `rowCount 0 → FORBIDDEN` · storage path + path traversal |
| `tests/domain/layer-boundary.test.ts` | **WO-2.1** — รัน eslint จริงเพื่อพิสูจน์ว่า rule กัน `domain/` ยังทำงาน |
| `tests/auth/profile.test.ts` | **WO-2.2** — trigger สร้าง profile · แก้ของคนอื่นไม่ได้ · [D-12] |
| `tests/auth/safe-next.test.ts` | **WO-2.2** — กัน open redirect ที่พารามิเตอร์ `next` |
| `tests/domain/policies.test.ts` | **WO-2.3** — schema cancellation/pricing ตาม ADR-002 |
| `tests/gangs/create-gang.test.ts` | **WO-2.3** — create_gang atomic · ไม่ใช่แอดมินแก้ไม่ได้ · เพิ่มสมาชิกด้วยอีเมล |
| `tests/domain/timezone.test.ts` | **WO-2.4** — เวลาข้าม timezone + DST + snapshot builder |
| `tests/sessions/snapshot.test.ts` | **WO-2.4** — ขึ้นราคาแล้วนัดเก่าต้องถือราคาเดิม |
| `tests/sessions/guest-flow.test.ts` | **WO-2.5** — ลิงก์เชิญ · guest token · E2E เต็ม → waitlist → เลื่อนคิว |
| `tests/sessions/guest-rate-limit.test.ts` | **WO-2.5** — rate limit ต่อ IP ต่อนัด (เรียก path เดียวกับ action) |
| `tests/domain/sync-fallback.test.ts` | **WO-2.5** — realtime ต่อไม่ติด → ตกไป polling เอง |
| `tests/domain/matching.test.ts` | **WO-2.6** — DoD 4 ข้อของ Matching Engine + ความคงที่ของผลลัพธ์ |
| `tests/sessions/game-console.test.ts` | **WO-2.7** — เช็คอิน · คิวสด · guest ลงเกม · ลูกทศนิยม · สลับตัว |
| `tests/domain/billing.test.ts` | **WO-2.8** — money invariant property-based (3/7/13 คน) + penalty ทุกเคส |
| `tests/sessions/close-billing.test.ts` | **WO-2.8** — domain ต่อกับ `close_session_with_charges()` จริง |
| `tests/domain/promptpay.test.ts` | **WO-2.9** — payload EMVCo + ยอดถูกฝังจริง |
| `tests/sessions/payments.test.ts` | **WO-2.9** — state machine · verify แล้วแก้ไม่ได้ · สลิปไม่รั่ว |
| `tests/sessions/notifications.test.ts` | **WO-2.10** — worker ส่งจริง · backoff · sweep คืนคิว · เห็นเฉพาะของตัวเอง |
| `tests/e2e/mvp0-full-path.test.ts` | 🎉 **MVP-0 checkpoint** — เส้นเต็ม 14 ขั้นตาม baseline §Verification |

⚠️ **เทสต์ RLS ต้องห่อด้วย `asRole()` / `visibleCount()` เสมอ** — connection ของเทสต์เป็น
`postgres` ซึ่งมี BYPASSRLS ถ้าลืมห่อ เทสต์จะผ่านแบบหลอกๆ ทุกครั้งโดยไม่ได้ตรวจ policy เลย

⚠️ เทสต์ **ไม่ล้างข้อมูลหลังรัน** — สร้าง fixture ใหม่ทุกครั้งด้วยชื่อสุ่ม ถ้าอยากได้ DB สะอาด
ให้ `npm run supabase -- db reset` ก่อน (ต้องรอ pooler รีสตาร์ตสักครู่ — helper มี retry ให้แล้ว)

---

## 6. ช่องโหว่ — ปิดไป 3 จาก 4 แล้ว

| # | ช่องโหว่ | สถานะ |
|---|---|---|
| 1 | EXECUTE grant ของ DB functions เปิดให้ `anon` | ✅ ปิดแล้ว — revoke หมด เหลือ `service_role` |
| 2 | INSERT นัดด้วย status นอก `draft` | ✅ ปิดแล้ว [D-14] |
| 4 | เขียน `session_registrations` ตรงๆ | ✅ ปิดแล้ว [D-13] |
| 3 | **`transition_payment()` ยังไม่มี** | 🔴 **ยังค้าง** |

🔴 **ข้อ 3 ที่ยังค้าง**: baseline สั่งติด GUC trigger บน `payments` แต่ Phase 1 ไม่มีฟังก์ชัน
ที่ปลด GUC ให้ ⇒ ตอนนี้ payment เปลี่ยน status ไม่ได้เลยทุกทาง เป็นงาน Phase 2
**ห้ามแก้ด้วยการถอด trigger** (ผมไม่ได้ทำใน WO-1.4 เพราะอยู่นอก scope ของ WO นี้)

➡️ ผลข้างเคียงที่ต้องรู้: **ทุก DB function เรียกได้เฉพาะ `service_role`**
หมายความว่า guest ลงชื่อต้องผ่าน route handler ฝั่งเรา (ที่ validate + rate limit) เท่านั้น
เรียกจาก browser ตรงไม่ได้อีกแล้ว — ต้องออกแบบ server action ตามนี้ใน Phase 2

---

## 7. ทำอะไรต่อ — Phase 2.5

MVP-0 จบแล้ว (tag `v0.1.0`) — baseline §Roadmap กำหนด Phase ถัดไปไว้ว่า:

**Phase 2.5 — Core ครบ**: billing strategies ที่เหลือ + MembershipBilling (monthly) →
`payment_allocations` (จ่ายแทนเพื่อน) + adjustments/refund → session templates +
auto-generate → QR check-in → reminder jobs

✅ **แตก WO ของ Phase 2.5 แล้ว** — 7 ใบ (`WO-2.5-A` … `WO-2.5-G`) อยู่ท้าย `AGENT-EXECUTION.md`
(ใช้ตัวอักษรเพราะ Phase 2 มีใบชื่อ WO-2.5 อยู่แล้ว)

✅ **`WO-2.5-A` เสร็จแล้ว** (13 ส.ค. 2026) — migration `0024` + 15 เทสต์ใหม่ · push ขึ้น cloud แล้ว
(ตรวจของจริงบน cloud: 3 ฟังก์ชันเป็น security definer และ EXECUTE มีแค่ `postgres`, `service_role`)

สิ่งที่เปลี่ยนไปแล้วและใบถัดๆ ไปต้องรู้:
- `mark_no_show()` · `update_game_shuttles()` · `check_in_all()` เป็น DB function
  ⇒ **ห้ามกลับไป UPDATE `session_registrations` / `games` ตรงจาก server action อีก**
- แก้ `shuttles_used` ได้เฉพาะตอนนัดอยู่ `open`/`in_play` — **หลัง `billing` DB จะ raise**
  (นี่คือเงื่อนไขที่ทำให้ `court_plus_shuttle` ใน WO-2.5-B ปลอดภัยพอจะเปิดได้)
- ปิดรอบต้องผ่านหน้า `/gangs/[gangId]/sessions/[sessionId]/close` — `closeSessionWithBilling()`
  ปฏิเสธด้วย `CONFIRMATION_REQUIRED` ถ้าไม่มีใครเช็คอินและไม่ได้ส่ง `confirmNoCheckIn`

✅ **`WO-2.5-B` เสร็จแล้ว** (13 ส.ค. 2026) — **ไม่มี migration ใหม่** (schema มีคอลัมน์ครบตั้งแต่ 0003)
⇒ cloud ยังตรงกับ local ที่ 24 migrations

สิ่งที่เปลี่ยนไปแล้วและใบถัดๆ ไปต้องรู้:
- `IMPLEMENTED_PRICING_TYPES` = `flat_rate` + `court_plus_shuttle` — `monthly` ยัง**ปิดอยู่**
  จนกว่า WO-2.5-C จะมี MembershipBilling จริง
- **ADR-005** ตรึงวิธีหาร: ค่าสนามหารเฉพาะคนที่ไม่ใช่สมาชิกรายเดือน · ค่าลูกตาม
  `monthly_member_pays_shuttle` · ปัดแยกก้อน · เศษรายคนอยู่ใน `breakdown.rounding_surplus`
  และบวกกันได้ surplus ของนัดเป๊ะ
- snapshot มีคีย์ใหม่ `pricing_plan.monthly_member_pays_shuttle` (additive ไม่ขึ้น version)
- `calculateSessionCharges()` ต้องได้ `shuttlesUsedTotal` เมื่อเป็น `court_plus_shuttle`
  — **throw ถ้าไม่ส่ง** ห้าม default 0

✅ **`WO-2.5-C` เสร็จแล้ว** (13 ส.ค. 2026) — migration `0025` push cloud แล้ว (25/25)
ตรวจของจริงบน cloud: `commit_monthly_fees()` เป็น security definer · EXECUTE = `postgres`, `service_role`

สิ่งที่เปลี่ยนไปแล้วและใบถัดๆ ไปต้องรู้:
- **ADR-006**: `monthly` เป็นแผนราคา**คนละแถว**กับแผนของนัด — ทุก query ที่หา
  "แผนราคาของนัด" ต้องกรอง `SESSION_PRICING_TYPES` ไม่งั้นจะหยิบแผนรายเดือนไปแช่แข็งใน snapshot
- ค่าสมาชิกรายเดือน: **เข้ากลางเดือนเก็บเต็มเดือน** · ออกบิลต้นเดือนสำหรับเดือนนั้น
- `commit_monthly_fees()` เป็นจุด commit เดียวของ `monthly_fee` (ADR-001)
  ⇒ ❌ ห้าม insert `session_charges` ประเภทนี้ที่อื่น
- cron ใหม่ `/api/cron/monthly-fees` (Vercel Cron, **รายวัน** — ดูเหตุผลใน ADR-006)
- โฟลเดอร์ใหม่ `server/membership/` ใช้ร่วมกันระหว่าง cron กับ server action
  (แนวเดียวกับ `server/guest/`)

✅ **`WO-2.5-D` เสร็จแล้ว** (13 ส.ค. 2026) — migration `0026` push cloud แล้ว (26/26)
ตรวจของจริงบน cloud: 3 ฟังก์ชัน + trigger `session_charges_no_edit_after_paid` +
`event_logs_aggregate_type_check` ที่มี `'charge'` แล้ว

สิ่งที่เปลี่ยนไปแล้วและใบถัดๆ ไปต้องรู้:
- **ยอดค้างอ่านจาก ledger เท่านั้น** — `charge_outstanding()` (SQL) หรือ
  `domain/billing/ledger.ts` (หน้าจอ) ❌ ห้ามนับจาก `payments.status`
- allocation นับเฉพาะสลิปที่ **verified** · "ค้างเก็บ" กับ "ต้องคืน" ไม่หักกลบกัน
- `create_payment_for_charges()` **ไม่ออกใบซ้ำ** — คืนใบเดิมถ้ายังไม่ verified
  และเขียน `payment_allocations` ให้อัตโนมัติ
- แก้ยอดหลัง verify ต้องผ่าน `add_payment_adjustment()` — มี trigger กัน UPDATE
  `session_charges.amount` ของหนี้ที่จ่ายแล้ว

✅ **`WO-2.5-E` เสร็จแล้ว** (13 ส.ค. 2026) — migration `0027` push cloud แล้ว (27/27)
ตรวจของจริงบน cloud: unique index `sessions_template_slot_key` ตรงกับ local

สิ่งที่เปลี่ยนไปแล้วและใบถัดๆ ไปต้องรู้:
- **snapshot ของนัดประกอบที่เดียว**: `server/sessions/snapshot.ts`
  ⇒ ❌ ห้ามประกอบ snapshot เองที่อื่นอีก (นัดที่ generate ต้องปิดรอบได้เหมือนนัดที่สร้างมือ)
- `sessions.template_id` + unique `(template_id, starts_at)` = กุญแจ idempotency ของ cron
  **จงใจไม่กรอง `deleted_at`** ⇒ นัดที่ลบแล้วจะไม่ถูกสร้างกลับ
- cron ใหม่ `/api/cron/session-generate` (Vercel Cron, รายวัน, ล่วงหน้า 14 วัน)
- `domain/sessions/recurrence.ts` ใช้เลขวันแบบ JS (0 = อาทิตย์) และรองรับจบข้ามเที่ยงคืน

**ต่อไป: `WO-2.5-F`** — QR check-in + guest token ย้ายเข้า cookie

### สิ่งที่ควรทำก่อนเริ่ม Phase 2.5

- [ ] **Playwright** — E2E ผ่านเบราว์เซอร์จริง (`tests/e2e/mvp0-full-path.test.ts`
      เดินเส้นเดียวกันแล้วแต่ไม่ครอบการ render/กดปุ่ม/อัปโหลดไฟล์)
- [ ] **ให้ก๊วนจริงลองใช้** แล้วเก็บ feedback ก่อนตัดสินว่า Phase 2.5 ต้องทำอะไรก่อน
      — รายการใน BACKLOG ยาวกว่าที่ควรทำทั้งหมด
- [ ] **ปิดช่องที่ยังค้าง** (ดู `BACKLOG.md`) ที่สำคัญที่สุด:
      guest token อยู่ใน query string (WO-2.5-F) · ออกใบจ่ายซ้ำได้ (WO-2.5-D)
- [x] ~~`confirmed` ที่ไม่เคยเช็คอินถูกคิดเหมือน no-show~~ — WO-2.5-A ปิดแล้ว
      (ปุ่ม "เช็คอินทุกคน" + หน้าสรุปยอด + ด่าน `CONFIRMATION_REQUIRED`)

---

## 8. สิ่งที่ค้นพบไปแล้ว อย่าเสียเวลาค้นซ้ำ

- **image `supavisor:2.9.7` เคยพังเงียบ** — container exit 0 ไม่มี log สักบรรทัด (layer เสียตอนดิสก์เต็ม)
  แก้ด้วย `docker rmi -f public.ecr.aws/supabase/supavisor:2.9.7 && docker pull ...`
  ⇒ **อาการ "container ไม่ปล่อย log เลย" = สงสัย image เสียก่อนเสมอ** ทดสอบด้วย
  `docker run --rm --entrypoint /bin/sh <image> -c 'echo OK'`
- **Supabase เต็มชุดไม่ขึ้นเพราะ logflare/vector/studio ไม่ใช่เพราะ RAM** — วัดแล้วใช้แค่
  ~1.2 GB จาก 3.8 GB ตอนเปิด storage/realtime ครบ (เคยสรุปผิดว่าเป็นเรื่อง RAM)
- **Astryx × Tailwind ใช้ร่วมกันได้** ผ่าน bridge `@astryxdesign/core/tailwind-theme.css`
  StyleX เป็น optional ⇒ **ห้ามใช้ `xstyle`/`stylex.create()`**
- **cascade layer order สำคัญมาก** อยู่ใน `app/layers.css` — ผิดแล้วพังเงียบไม่มี error
- **astryx CLI path จริง** = `node_modules/@astryxdesign/cli/**clients/cli/**bin/astryx.mjs`
  → `npm run astryx -- <cmd>`
- **`uuid_generate_v7()` แก้เป็น RFC 9562 Method 3 แล้ว** (sub-millisecond ใน `rand_a`)
- **`npm audit` 3 high** อยู่ใน transitive deps ของ `next@15.5.23` — แก้ต้องขึ้น next@16 = ต้องผ่าน ADR
- **RLS ต้องมี GRANT คู่เสมอ** — ดูหัวข้อ 4 (WO-1.4) เป็นกับดักที่เสียเวลาที่สุดใน WO นี้
- 🔴 **default ACL ของ local กับ cloud ไม่เหมือนกัน** — local ให้ `Dxtm`, cloud ให้ `arwdDxtm`
  ⇒ ห้ามพึ่ง "ไม่ได้ grant = แตะไม่ได้" เด็ดขาด ต้อง `revoke` ให้ชัด
  migration `0013` ล้างแล้ว grant กลับตามรายการที่ประกาศไว้ ⇒ สองที่เหมือนกันแล้ว
  **ตารางใหม่ทุกตารางต้อง revoke/grant เองใน migration ที่สร้างมัน**
  (มีเทสต์ `tests/rls/grant-matrix.test.ts` คุมไว้ — ตารางใหม่ที่ไม่ประกาศสิทธิ์จะทำให้เทสต์แดง)
- **`service_role` มี BYPASSRLS แต่ BYPASSRLS ไม่ข้าม GRANT** — ต้อง grant ให้ด้วย
- **helper ของ policy ต้องเป็น SECURITY DEFINER** ไม่งั้น policy ที่อ้างตารางตัวเองจะ recursion
  และ **ห้ามใช้ `FORCE ROW LEVEL SECURITY`** เพราะจะทำให้ owner ถูก policy ตรวจด้วย = วนกลับมาอีก
- **`auth.users` ต้องการแค่คอลัมน์ `id`** — สร้าง user ในเทสต์ได้ด้วย `insert into auth.users (id) values (gen_random_uuid())`
- รายละเอียดที่เหลือทั้งหมดอยู่ใน **`BACKLOG.md`**

---

## 9. คำสั่งที่ใช้บ่อย

```bash
npm run dev / build / typecheck / lint
npm test                                          # vitest — concurrency tests (ต้องมี local stack ขึ้นก่อน)
npm run astryx -- <cmd>                           # docs/components/tokens ของ Astryx
npm run supabase -- start -x studio,logflare,vector,edge-runtime,mailpit
npm run supabase -- db reset                      # apply migrations ใหม่ทั้งหมดบน local
npm run supabase -- db push --linked --dry-run    # ดูว่าจะ push อะไรขึ้น cloud บ้าง
npm run supabase -- migration list --linked       # เทียบ local vs remote
```
