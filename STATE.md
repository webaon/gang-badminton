# STATE — สถานะงานล่าสุด

> เอกสาร handoff ระหว่าง session (ที่ `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง)
> **อัปเดตล่าสุด: 16 ส.ค. 2026** · MVP-0 = `v0.1.0` · Phase 2.5 = `v0.2.0` ·
> Phase 3 = `v0.3.0` (+ `v0.3.1` ADR-007) · Phase 4 (LINE) = `v0.4.0` ·
> 🎉 **Phase 5 (Hardening & Deploy) เสร็จครบ = `v1.0.0` — public release**
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
tag ล่าสุด: v1.0.0 (Phase 5 — merge เข้า main ผ่าน PR #6 `637057f`, CI เขียว)
           v0.4.0 (Phase 4 — LINE)
           v0.3.1 (ADR-007) · v0.3.0 (Phase 3) · v0.2.0 (Phase 2.5) · v0.1.0 (MVP-0)
branch: claude/badminton-group-system-4pfs7o   (ทำงานอยู่บนนี้ — WO ทุกใบ commit ที่นี่)
        main                                    (ตามทันแล้วถึง v0.3.0)
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
| migrations ที่ apply แล้ว | **39 / 39** ✅ (push ล่าสุด 20 ส.ค. 2026 — `0039` ของ WO-5.D) |
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
npm test          # vitest run — 712 tests, 65 files (17 ส.ค. 2026)
npm run test:unit # เทสต์ที่ไม่ต้องมี DB (273) — ใช้เป็น PR gate
npm run test:e2e  # Playwright smoke (ต้อง build ด้วย NEXT_PUBLIC_* ก่อน)
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
| `tests/rls/event-log-privacy.test.ts` | **WO-5.D** — สมาชิกอ่าน event เรื่องเงินจาก API ตรงไม่ได้ · SQL ตรงกับ `adminOnly` ของ domain · เจ้าของหนี้เห็น refund ของตัวเอง |
| `tests/security/rate-limit.test.ts` | **WO-5.C** — เกินเพดาน = RATE_LIMITED · ทุกทางเข้าสาธารณะมีเพดานจริง · grep gate ของ secret/log |
| `tests/security/csp.test.ts` | **WO-5.B** — script-src ไม่มี unsafe-* ใน prod · หน้า static ห้ามมี strict-dynamic · connect-src มาจาก env · HSTS เฉพาะ prod |
| `tests/e2e/phase4-full-path.test.ts` | 🎉 **Phase 4 checkpoint** — ตั้งค่า Vault → ผูกผ่าน webhook → ประกาศ → ส่งจริง → โควต้า → เลิกผูก · ก๊วนที่ไม่ต่อ LINE ต้องเหมือนเดิม |
| `tests/line/liff.test.ts` | **WO-4.E** — ที่ว่างนับแบบ [D-10] · หนี้จากนัดที่ปิดแล้วยังนับ · ไม่มี service-role/LIFF SDK ในเส้นทาง |
| `tests/line/login.test.ts` | **WO-4.D** — state/nonce · ไม่ล็อกอิน/คนละคน = ปฏิเสธ · เลิกผูกแล้วคิวถูกปิด |
| `tests/line/fanout.test.ts` | **WO-4.C** — fan-out `line` (คีย์ `in_app` ไม่เปลี่ยน) · ปิด flag/ไม่ผูก/บล็อก/เกินโควต้า = ไม่มีแถว line · ข้อความ whitelist |
| `tests/line/webhook.test.ts` | **WO-4.B** — ลายเซ็นจาก raw body · ข้ามก๊วนไม่ผ่าน · flag ปิด = 403 · follow/unfollow · รหัสผูกบัญชี stateless |
| `tests/line/credentials.test.ts` | **WO-4.A** — Vault: ไม่มี plaintext ใน DB · status ปิดบัง 4 ตัวท้าย · หมุน/ถอด · เปิด flag ต้องครบก่อน |
| `tests/rls/public-gang-exposure.test.ts` | **WO-3.G / ADR-007** — anon แตะ `gangs` ไม่ได้ · คนนอกอ่านก๊วน public ไม่ได้ · `promptpay_id` ไม่หลุด · discovery ยังทำงาน |
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
| `tests/discovery/search.test.ts` | **WO-3.E** — ก๊วนส่วนตัว/ปิด discovery ไม่โผล่ · pg_trgm ค้นไทยบางส่วน · escape wildcard · explain ยืนยันใช้ index |
| `tests/discovery/join-requests.test.ts` | **WO-3.E** — ขอ/ยกเลิก/อนุมัติ · กดพร้อมกันสองคนได้สมาชิกเดียว · ข้ามก๊วนไม่ได้ · เขียนตารางตรงไม่ได้ |
| `tests/landing/landing.test.ts` | **WO-3.F** — หน้าแรกต้องยัง static/ISR (ไม่มี `force-dynamic`/`cookies()`) · สรุปตัวเลข pure · อ่าน DB ไม่ได้ต้องไม่พัง |
| `tests/e2e/phase3-full-path.test.ts` | 🎉 **Phase 3 checkpoint** — ปิดรอบ → rollup → รายงาน reconcile → ประกาศไม่ส่งซ้ำ → ค้นหา+ขอเข้าก๊วน+อนุมัติ |
| `tests/e2e/mvp0-full-path.test.ts` | 🎉 **MVP-0 checkpoint** — เส้นเต็ม 14 ขั้นตาม baseline §Verification |

⚠️ **เทสต์ RLS ต้องห่อด้วย `asRole()` / `visibleCount()` เสมอ** — connection ของเทสต์เป็น
`postgres` ซึ่งมี BYPASSRLS ถ้าลืมห่อ เทสต์จะผ่านแบบหลอกๆ ทุกครั้งโดยไม่ได้ตรวจ policy เลย

⚠️ เทสต์ **ไม่ล้างข้อมูลหลังรัน** — สร้าง fixture ใหม่ทุกครั้งด้วยชื่อสุ่ม ถ้าอยากได้ DB สะอาด
ให้ `npm run supabase -- db reset` ก่อน (ต้องรอ pooler รีสตาร์ตสักครู่ — helper มี retry ให้แล้ว)

---

## 6. ช่องโหว่ — ปิดครบแล้ว (ของที่ยังค้างอยู่ใน `BACKLOG.md`)

| # | ช่องโหว่ | สถานะ |
|---|---|---|
| 1 | EXECUTE grant ของ DB functions เปิดให้ `anon` | ✅ ปิดแล้ว — revoke หมด เหลือ `service_role` |
| 2 | INSERT นัดด้วย status นอก `draft` | ✅ ปิดแล้ว [D-14] |
| 3 | `transition_payment()` ยังไม่มี (payment เปลี่ยน status ไม่ได้เลย) | ✅ ปิดแล้ว — migration `0022` (WO-2.9) |
| 4 | เขียน `session_registrations` ตรงๆ | ✅ ปิดแล้ว [D-13] |
| 5 | `member_statistics` เปิด `total_paid` ของทุกคนให้สมาชิกทั้งก๊วน | ✅ ปิดแล้ว — `0031` (WO-3.C) |
| 6 | `announcements` เปิด**ร่าง**ให้สมาชิกเห็น | ✅ ปิดแล้ว — `0032` (WO-3.D) |
| 7 | `join_requests` ยิงคำขอเข้าก๊วนส่วนตัวได้ / แอดมินตั้ง `approved` ตรงได้ | ✅ ปิดแล้ว — `0033` (WO-3.E) |
| 8 | `gangs_select_public` ทำให้ `anon` อ่าน `promptpay_id` ของก๊วนสาธารณะได้ | ✅ ปิดแล้ว — `0034` (WO-3.G / ADR-007) |

➡️ ผลข้างเคียงที่ต้องรู้: **ทุก DB function เรียกได้เฉพาะ `service_role`**
หมายความว่า guest ลงชื่อต้องผ่าน route handler ฝั่งเรา (ที่ validate + rate limit) เท่านั้น
เรียกจาก browser ตรงไม่ได้อีกแล้ว — ต้องออกแบบ server action ตามนี้ใน Phase 2

---

## 7. ทำอะไรต่อ — เริ่มพรุ่งนี้ที่นี่

🎉 **Phase 3 (Growth) เสร็จครบ 6 ใบ** — merge เข้า `main` ผ่าน PR #3 (`8bfa947`) · tag **`v0.3.0`** · CI เขียว
571 เทสต์ / 55 ไฟล์ · cloud **33/33 migrations** (MVP-0 = `v0.1.0` · Phase 2.5 = `v0.2.0`)

| WO | งาน | migration |
|---|---|---|
| 3.A | rollup `member_statistics` + `daily_metrics` + cron | `0030` |
| 3.B | รายงานรายรับ-รายจ่าย-กำไร (reconcile ได้) | — |
| 3.C | หน้าสถิติสมาชิก + timeline | `0031` |
| 3.D | ประกาศ + แจ้งเตือนตอน publish | `0032` |
| 3.E | Discovery (pg_trgm) + คำขอเข้าก๊วน | `0033` |
| 3.F | หน้าแรก static/ISR + E2E checkpoint | — |

### ✅ ปิดช่องโหว่ `promptpay_id` แล้ว — `WO-3.G` / **ADR-007** (16 ส.ค. 2026)

`gangs_select_public` (0010) เปิดทั้ง**แถว** ⇒ ใครถือ **anon key** ก็อ่าน `promptpay_id`
ของทุกก๊วนสาธารณะได้ (ยืนยันของจริงแล้ว) · **แก้ด้วยทางเลือก (ข)**: ถอด policy ทิ้ง +
`revoke select on gangs from anon` (migration `0034`) ⇒ คนนอกอ่านก๊วนได้ทางเดียวคือ
`search_public_gangs()` ที่ประกาศคอลัมน์ไว้ชัด · cloud **34/34** (ตรวจของจริง: เหลือ 3 policy
บน `gangs` และ `anon` ไม่มี grant ใดๆ)

➡️ **หน้าโปรไฟล์ก๊วนสาธารณะในอนาคตต้องเพิ่ม DB function** ❌ ห้ามเปิด policy ให้อ่าน `gangs` ตรงกลับมา
➡️ ทางเลือก (ค) ย้าย `promptpay_id` ไปตาราง server-only ยังทำเพิ่มได้เป็น defense in depth (`BACKLOG.md`)

ของที่ยังค้างจากการไล่ policy 0010: `event_logs` ยังเป็นระดับก๊วน · `coupons` เปิดทั้งก๊วน ·
`payment_adjustments` แอดมินเท่านั้น — จดไว้ใน `BACKLOG.md` แล้วทั้งหมด

### 🎉 Phase 4 (LINE) เสร็จครบ 6 ใบ — merge เข้า `main` ผ่าน PR #5 · tag **`v0.4.0`** · CI เขียว

| WO | งาน | migration |
|---|---|---|
| 4.A | Vault + หน้าตั้งค่า LINE ต่อก๊วน | `0035` |
| 4.B | webhook ต่อก๊วน + ผูกบัญชีด้วยรหัสในแชต | `0036` |
| 4.C | fan-out `line` ในคิวเดิม + ส่งจริง + โควต้าต่อเดือน | `0037` |
| 4.D | LINE Login (ผูกด้วยปุ่มเดียว) | `0038` |
| 4.E | LIFF — หน้าจอในแอป LINE | — |
| 4.F | E2E checkpoint + `v0.4.0` | — |

### 🎉 Phase 5 (Hardening & Deploy) เสร็จครบ 6 ใบ — merge เข้า `main` ผ่าน PR #6 · tag **`v1.0.0`**

| WO | งาน | migration |
|---|---|---|
| 5.A | อัป **Next 15 → 16.3.1** ปิด `npm audit` 4 high (**ADR-008**) | — |
| 5.B | Security headers + CSP (nonce ต่อ request) | — |
| 5.C | rate limit ครบทุกทางเข้าสาธารณะ + grep gate ของ secret/log | — |
| 5.D | รัด RLS ที่ค้างจาก Phase 3 (`event_logs` · `payment_adjustments`) | `0039` |
| 5.E | Playwright smoke + แยก CI gate เร็ว/ช้า | — |
| 5.F | README ไทย + runbook + ปิด §Security Checklist | — |

**§Security Checklist ครบ 7 ข้อ** พร้อมหลักฐานต่อข้อ → `docs/security-checklist.md`
(รวมตารางของที่ "รู้อยู่ว่ายังไม่ปิด" พร้อมเงื่อนไขที่ต้องกลับมาทบทวน)

### 🚀 Production ขึ้นแล้ว (20 ส.ค. 2026)

**https://gang-badminton.vercel.app** — Vercel team `triple-t` · project `gang-badminton`
· ชี้ Supabase cloud `emmzeriekkjryhucvctx` (39/39 migrations)

ตรวจของจริงหลัง deploy: ทุกหน้า 200 · CSP มี nonce ต่อ request + `strict-dynamic` ·
`connect-src` ชี้โปรเจกต์ cloud · HSTS + `X-Frame-Options` มาครบ ·
`/api/cron/*` ตอบ **401** ทั้งกรณีไม่มี secret และ secret ผิด

🔴 **Vercel Hobby ให้ cron วันละครั้งต่อ job** ⇒ `vercel.json` เหลือรายวัน (เส้นสำรอง)
และงานที่ต้องถี่จริงขับด้วย **GitHub Actions** (`.github/workflows/cron.yml`):
`notification-dispatch` ทุก 5 นาที · `reminders` รายชั่วโมง — ยิงเข้า route handler ตัวเดิม
ทดสอบ `workflow_dispatch` แล้วได้ 200 ทั้งสองงาน · ตารางเต็มอยู่ใน `docs/cron.md`
⚠️ workflow ที่มี `schedule` เดินได้เฉพาะบน **default branch** ⇒ ต้อง merge เข้า `main` เสมอ

env ที่ตั้งไว้บน Vercel (production): `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY`
· `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `CRON_SECRET` · `LINE_LINK_SECRET` · `APP_BASE_URL`
(secret ของ GitHub repo: `APP_BASE_URL` · `CRON_SECRET`)

### งานถัดไป — ยังไม่มี Phase 6 ใน baseline

baseline จบที่ Phase 5 ⇒ งานหลังจากนี้เป็นเรื่องของ **ใช้งานจริงแล้วเก็บ feedback**
สิ่งที่ค้างอยู่และหยิบทำได้ทันที (รายละเอียดใน `BACKLOG.md`):
- [ ] **ให้ก๊วนจริงลองใช้** แล้วเก็บ feedback ก่อนตัดสินลำดับงานถัดไป
- [ ] smoke ในเบราว์เซอร์ยังไม่ครอบหางของเส้น (ลงชื่อ → ปิดรอบ → เห็นยอด)
- [ ] `lib/supabase/client.ts` ควร degrade เป็น polling แทนพังทั้งหน้าเมื่อ env ขาด
- [x] ~~deploy จริงบน Vercel~~ — ✅ ขึ้นแล้ว (ดูด้านบน)
- [ ] **สร้างก๊วนจริงบน production** แล้วลองใช้ (ตอนนี้ DB cloud ยังว่างเปล่า)
- [ ] ตั้งค่า LINE ของก๊วนจริง (README §6) — ต้องมี LINE OA + Login channel ของจริง
- [ ] domain ของตัวเอง (ตอนนี้ใช้ `*.vercel.app`) + ทบทวนว่าจะอัป Vercel Pro ไหม
      (อัปแล้วย้าย cron กลับมาที่ `vercel.json` ได้เลย ไม่ต้องแก้โค้ด)

### 🔴 กติกาที่เพิ่มมาใน Phase 5 (ห้ามทำผิด)

- ❌ **ห้ามส่ง `as={NextLink}` จาก server component** — ลิงก์ Astryx ได้ router จาก
  `LinkProvider` ใน `app/providers.tsx` (Next 16 ห้ามส่ง component ข้ามขอบ RSC)
- entry point ของ Next คือ **`proxy.ts`** (เดิม `middleware.ts`)
- 🔴 **หน้าที่ prerender ใหม่ต้องเติมใน `STATIC_ROUTES`** (`lib/security/csp.ts`)
  ไม่งั้น CSP บล็อกสคริปต์ทั้งหน้าโดย server ยังตอบ 200 (มีเทสต์อ่าน build manifest มาเทียบ)
- 🔴 **`NEXT_PUBLIC_*` ต้องมีตั้งแต่ตอน `npm run build`** — inline เข้า bundle ไม่ใช่อ่านตอนรัน
- เปิดทางเข้าใหม่ให้คนไม่ล็อกอิน = **ต้องมีเพดาน + เติมใน `docs/rate-limits.md`** (มีเทสต์ตรวจ)
- ❌ ห้าม log ค่า token/secret · ❌ ห้ามฝัง JWT/service key ในโค้ด (grep gate 4 ชั้น)
- event เรื่องเงิน/`audit.*` ปิดที่ RLS แล้ว — กติกาใน SQL ต้องตรงกับ `adminOnly` ของ
  `domain/reports/timeline.ts` (มีเทสต์เทียบสองฝั่ง)

### 🔴 กติกาของ Phase 4 ที่ Phase ถัดไปห้ามทำผิด

- คิวมี **สอง channel ต่อหนึ่งงาน**: `in_app` (คีย์เดิม) + `line` (`<คีย์เดิม>:line`)
  ⇒ ❌ ห้ามเปลี่ยนรูปคีย์ของ `in_app` เด็ดขาด (ของที่เคยกันซ้ำจะพังทั้งระบบ)
- แถว `line` เกิดเฉพาะเมื่อ ก๊วนเปิด LINE **และ** ผู้รับผูกบัญชี **และ** ไม่บล็อก OA
  **และ** ยังไม่เกินโควต้า — ตรวจใน `enqueue_notifications()` และซ้ำอีกรอบตอนส่งจริง
- โควต้าอ่านจาก `notification_logs` (`success` เท่านั้น) — ❌ ห้ามสร้างตัวนับที่อื่น
- ข้อความ LINE ต้องผ่าน `domain/notifications/line-message.ts` (whitelist ต่อ event type)
  ❌ ห้ามยัด payload ดิบหรือยอดเงินรายคนลงข้อความ
- credentials ของก๊วนอยู่ใน **Vault** เท่านั้น (ตารางถือแค่ secret id) ·
  ฟังก์ชันที่คืน plaintext มีสามตัวและ grant ให้ `service_role` ล้วน
- ผูกบัญชีมีสองทาง (รหัสในแชต · LINE Login) แต่ทั้งคู่ลงเอยที่ `server/line/link.ts`
  ⇒ ❌ ห้ามเขียนทางที่สามที่ไม่ผ่านไฟล์นี้
- LIFF ไม่ใช้ SDK และไม่เชื่อ `liff.getProfile()` — ใช้ session ของ Supabase เหมือนหน้าปกติ
- env ที่ต้องมีจริงตอน deploy: **`LINE_LINK_SECRET`** (+ `APP_BASE_URL` ถ้าอยู่หลัง proxy)

### สิ่งที่เปลี่ยนไปใน Phase 3 ที่ Phase ถัดไปต้องรู้

- 🔴 `join_requests` **เขียนตรงไม่ได้** — `authenticated` เหลือ `select` ⇒ ผ่าน
  `request_to_join_gang()` / `cancel_join_request()` / `decide_join_request()` เท่านั้น
  (จุดเดียวที่คำขอกลายเป็น `gang_members`)
- ผลค้นหาก๊วนมาจาก `search_public_gangs()` ที่เดียว (กรอง `is_public` + `features.discovery` ในตัว)
  ⇒ ❌ ห้ามเขียน query ค้นก๊วนเองในหน้าจอ
- 🔴 **หน้าแรกเป็น static/ISR** (`app/page.tsx`, `revalidate = 3600`) — ❌ ห้ามใส่ `force-dynamic`
  หรือเรียก `cookies()` / `supabaseServer()` ที่นั่น (มีเทสต์ `tests/landing/landing.test.ts` คุมไว้)
  ตัวเลขบนหน้าแรกอ่านจาก `daily_metrics` เท่านั้น และ **ไม่โชว์ `revenue`** ของแพลตฟอร์ม
- ประกาศที่ `published_at is null` = ร่าง สมาชิกทั่วไปมองไม่เห็น (RLS 0032) ·
  publish ต้องผ่าน `publish_announcement()` — ❌ ห้าม UPDATE `published_at` ตรง
- 🔴 `member_statistics` สมาชิกเห็นแถวของตัวเองเท่านั้น แอดมินเห็นทั้งก๊วน (0031)
- ไทม์ไลน์ต้องผ่าน `buildTimeline()` เสมอ — ❌ ห้ามเรนเดอร์ `event_logs.payload` ดิบ
  (whitelist ต่อ event type · event ที่มีเงินรายคนเป็น `adminOnly`)
- สิทธิ์ใหม่: `statistics.view` (flag `statistics`) · `gang.finance.manage` ·
  `gang.join_request.manage` (flag `discovery`)

### นิยามการเงิน/สถิติที่ตรึงไว้แล้ว (หน้าจอห้ามนิยามเอง)

- **เก็บได้จริง** = allocation ของสลิปที่ `verified` **หัก refund** (`credit`/`correction` ลดหนี้
  แต่ไม่ใช่เงินสด) — ใช้ทั้ง `total_paid` ของ rollup และ `collected` ของรายงาน ⇒ แก้ต้องแก้ทั้งสองที่
- **กำไร (netCash)** = เก็บได้จริง + รายรับอื่น − รายจ่าย (เงินที่ยังไม่เข้าไม่ใช่กำไร)
- `shuttles_used` = ส่วนแบ่งลูกของเกมที่ลง (`/4`) · `attendance_rate` = มาเล่น ÷ นัดที่เคยได้ที่ × 100
- `daily_metrics` ใช้นาฬิกาไทย · `daily_metrics.revenue` รวมนัดที่ยกเลิกกลางคันที่มี charges

<details><summary>ที่มาของลำดับ Phase 3 (เดิม)</summary>

baseline §Roadmap กำหนด Phase 3 ไว้ว่า:

> `member_statistics` rollup · `daily_metrics` · รายงาน · ประกาศ ·
> Discovery + join request · Landing page

</details>

### 🔴 ข้อตกลงจาก Phase 2.5 ที่ใบถัดๆ ไปห้ามทำผิด (ยังใช้อยู่)

**เงิน**
- ยอดค้างอ่านจาก **ledger** เท่านั้น — `charge_outstanding()` (SQL) หรือ
  `domain/billing/ledger.ts` (หน้าจอ) ❌ ห้ามนับจาก `payments.status`
- allocation นับเฉพาะสลิปที่ **verified** · "ค้างเก็บ" กับ "ต้องคืน" **ไม่หักกลบกัน**
- แก้ยอดหลัง verify ต้องผ่าน `add_payment_adjustment()` — มี trigger กัน UPDATE
  `session_charges.amount` ของหนี้ที่จ่ายแล้ว
- `monthly_fee` commit ผ่าน `commit_monthly_fees()` ที่เดียว (ADR-001)
- **ADR-005**: ค่าสนามหารเฉพาะคนที่ไม่ใช่สมาชิกรายเดือน · ค่าลูกตาม
  `monthly_member_pays_shuttle` · ปัดแยกก้อน · เศษรายคนใน `breakdown.rounding_surplus`
- **ADR-006**: แผน `monthly` เป็น**คนละแถว**กับแผนของนัด ⇒ ทุก query ที่หา
  "แผนราคาของนัด" ต้องกรอง `SESSION_PRICING_TYPES`
- 🔴 **PostgREST คืน `numeric` เป็น JSON number ไม่ใช่ string** ⇒ อ่านเงินผ่าน
  `supabase-js` ต้องผ่าน `moneyFromDb()` (`lib/supabase/money.ts`) ก่อนเข้า `domain/`
  ⚠️ เทสต์ระดับ DB จับไม่ได้ เพราะ `pg` driver คืนเป็น string

**นัด / หน้างาน**
- snapshot ของนัดประกอบที่เดียว: `server/sessions/snapshot.ts`
  ⇒ นัดที่ generate ต้องปิดรอบได้เหมือนนัดที่สร้างมือ
- `mark_no_show()` · `update_game_shuttles()` · `check_in_all()` · `check_in_by_token()`
  เป็น DB function ⇒ ❌ ห้ามกลับไป UPDATE `session_registrations` / `games` ตรงจาก action
- แก้ `shuttles_used` ได้เฉพาะตอน `open`/`in_play` — หลัง `billing` DB จะ raise
- ปิดรอบผ่านหน้า `/gangs/[gangId]/sessions/[sessionId]/close` และจะถูกปฏิเสธด้วย
  `CONFIRMATION_REQUIRED` ถ้าไม่มีใครเช็คอินโดยไม่ยืนยัน
- unique `(template_id, starts_at)` **จงใจไม่กรอง `deleted_at`** ⇒ นัดที่ลบแล้วไม่ถูกสร้างกลับ

**ความปลอดภัย / คิว**
- guest token อยู่ใน cookie httpOnly (path ผูกกับ `/guest/<registrationId>`)
  ⇒ `cancelAsGuest(registrationId)` ไม่รับ token จาก client
- QR เช็คอินผูกกับนัดเสมอ · `issueCheckinQr()` คืน **ภาพ QR** ไม่ใช่ token
- งานเตือนเข้าคิวผ่าน `enqueue_notifications()` พร้อม `dedupe_key`
  ⇒ ❌ ห้าม insert `notifications` ตรงสำหรับงานที่ต้องกันซ้ำ
  ❌ ห้ามสร้าง worker ใหม่ — ใช้ `claim_notifications()` + `dispatchNotifications()` เดิม

### ค้างจากก่อนหน้า (ยังไม่ทำ)

- [ ] **Playwright** — E2E ผ่านเบราว์เซอร์จริง (ตอนนี้ E2E เดินผ่าน DB function + domain)
- [ ] **ให้ก๊วนจริงลองใช้** แล้วเก็บ feedback ก่อนเริ่ม Phase 4
- [ ] ของค้างอื่นดู `BACKLOG.md`

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
- 🔴 **เทสต์ที่พึ่ง "env ต้องว่าง" ต้องลบ env ของตัวเองชั่วคราว ไม่ใช่ assert ว่ามันว่าง**
  `full.yml` ตั้ง `SUPABASE_*` ระดับ job ⇒ assert แบบเดิมเขียวบนเครื่องแต่แดงบน CI
  (เจอตอนปิด Phase 5 — `tests/landing/landing.test.ts`)
- 🔴 **เทสต์ที่เรียก `claim_notifications()` / `dispatchNotifications()` ต้องวนจนเจอของตัวเอง**
  ทั้งคู่หยิบงานของ **ทั้งฐานข้อมูล** ครั้งละไม่กี่แถวและเรียงตามเวลา ⇒ ของค้างจากเทสต์ก่อนหน้า
  กินโควต้าของ batch จนแถวของเทสต์นั้นไม่ถูกหยิบ · **แดงเฉพาะบน CI** ที่ DB เริ่มจากศูนย์
  (เจอตอน WO-4.F — เทสต์เก่าของ WO-2.5-G ล้มเพราะ Phase 4 ทำให้คิวมีแถวเยอะขึ้น)
  ⇒ ก่อนเชื่อว่า "ผ่านแล้ว" ให้ `supabase db reset` แล้วรันทั้งชุดหนึ่งรอบ
- 🔴 **เทสต์ที่ยิง `enqueue_notifications` ต้องใช้ `dedupe_key` ที่ไม่ซ้ำข้ามการรัน**
  (คีย์เป็น unique ทั้งตารางและเทสต์ไม่ล้างข้อมูล) — ถ้าใช้คีย์ตายตัว รอบสองจะ `do nothing`
  ทั้งหมดแล้วเทสต์แดงแบบหาสาเหตุยาก (เจอมาแล้วตอน WO-4.C)
- 🔴 **probe ของ Vault ต้องแยกเป็นคนละ statement** — `with created as (select vault.create_secret(...))
  select ... from vault.decrypted_secrets` จะได้ผลว่า "พัง" เสมอ เพราะ CTE ที่เขียนข้อมูลไม่ถูกมองเห็น
  โดยส่วนอื่นของ statement เดียวกัน (เสียเวลาไปแล้วตอน WO-4.A — Vault ไม่ได้พัง)
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
