# STATE — สถานะงานล่าสุด

> เอกสาร handoff ระหว่าง session (ที่ `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง)
> **อัปเดตล่าสุด: 11 ส.ค. 2026** · เขียนตอนจบ WO-1.3
>
> 📌 กลับมาทำงานต่อ: อ่านไฟล์นี้ → `CLAUDE.md` → แล้วเริ่มที่ **"ทำอะไรต่อ"** ด้านล่าง

---

## 1. ความคืบหน้า

| WO | งาน | สถานะ |
|---|---|---|
| **1.1** | Scaffold (Next.js 15 + Tailwind v4 + Astryx + CLAUDE.md) | ✅ **เสร็จ** `21ecf3a` |
| **1.2** | Schema migrations (28 ตาราง + index + constraint) | ✅ **เสร็จ** `22a7713` |
| **1.3** | DB functions (6 ตัว) + GUC trigger + rate_limits | ✅ **เสร็จ** — DoD ผ่านครบ 4 ข้อ |
| **1.4** | RLS + security definer + storage buckets | ⬜ **ถัดไป** |
| 1.5 | Cron setup + seed | ⬜ |

Phase 2 ยังไม่แตก WO — baseline สั่งให้แตกตอนจบ Phase 1 เท่านั้น

---

## 2. Git

```
branch: claude/badminton-group-system-4pfs7o   (ทำงานอยู่บนนี้ — WO ทุกใบ commit ที่นี่)
        main                                    (มีแค่ commit เอกสาร baseline)
```

✅ **push ได้แล้ว — ทั้งสอง branch ขึ้น `webaon/gang-badminton` เรียบร้อย (11 ส.ค. 2026)**

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

### Cloud

| | |
|---|---|
| project / ref | **gang-badminton** · `emmzeriekkjryhucvctx` |
| migrations ที่ apply แล้ว | **7 / 9** ← 🔴 `0008` + `0009` **ยังไม่ได้ push ขึ้น cloud** |
| ข้อมูลใน DB | 0 แถวทุกตาราง |

🔴 **ยังไม่มี RLS — อย่าใส่ข้อมูลจริงจนกว่าจะจบ WO-1.4**

push ขึ้น cloud เมื่อพร้อม (ไฟล์ ref หายหลัง clone ใหม่ เพราะ `.temp` ถูก gitignore):
```bash
mkdir -p supabase/.temp && printf 'emmzeriekkjryhucvctx' > supabase/.temp/project-ref
npm run supabase -- db push --linked
```
`supabase link` ยังพังจากบั๊ก CLI 2.112.0 (`inserted_at`) — workaround คือเขียนไฟล์ ref เอง

---

## 4. WO-1.3 — สิ่งที่สร้าง

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

---

## 5. เทสต์ — DoD ผ่านครบ

```bash
npm test          # vitest run — 28 tests, 5 files
```

รันผ่าน **pooled port 54329** ตามที่ baseline §Verification บังคับ

| ไฟล์ | คุมอะไร |
|---|---|
| `tests/concurrency/register-no-overbook.test.ts` | **DoD 1** — 2 request ชน lock จริง + 8 request พร้อมกัน ไม่ overbook · guest/invite token |
| `tests/concurrency/promote-waitlist.test.ts` | **DoD 2** — cancel พร้อมกัน 2 คน ไม่ซ้ำ ไม่ข้ามคิว · reliability tiebreak (D-8) |
| `tests/concurrency/notification-worker.test.ts` | **DoD 3** — SKIP LOCKED, worker 2/4 ตัวไม่หยิบงานซ้ำ |
| `tests/concurrency/close-session-charges.test.ts` | **DoD 4** — `expected_status` ล้าสมัย → `INVALID_TRANSITION` + **ไม่มี charges เลย** |
| `tests/concurrency/status-guard.test.ts` | GUC trigger + `check_rate_limit()` |

⚠️ เทสต์ **ไม่ล้างข้อมูลหลังรัน** — สร้าง fixture ใหม่ทุกครั้งด้วยชื่อสุ่ม ถ้าอยากได้ DB สะอาด
ให้ `npm run supabase -- db reset` ก่อน (ต้องรอ pooler รีสตาร์ตสักครู่ — helper มี retry ให้แล้ว)

---

## 6. 🔴 ช่องโหว่ที่ WO-1.3 เปิดค้างไว้โดยตั้งใจ — WO-1.4 ต้องปิด

รายละเอียดเต็มอยู่ใน `BACKLOG.md` หัวข้อ "จาก WO-1.3" — สรุปตัวที่สำคัญที่สุด:

1. **EXECUTE grant ยังเป็น default** — ฟังก์ชันทั้งหมด `security definer` ⇒ `anon` เรียกได้หมด
2. **GUC guard คุมเฉพาะ UPDATE ไม่คุม INSERT** — `insert sessions(status:'settled')` ยังผ่าน
3. **`transition_payment()` ยังไม่มี** ⇒ payment เปลี่ยน status ไม่ได้เลยทุกทาง
   (trigger ติดตาม baseline แล้ว แต่ไม่มีฟังก์ชันที่ set GUC ให้) — **ห้ามแก้ด้วยการถอด trigger**
4. **`waitlist → confirmed` บังคับได้แค่ตามกติกา** — ไม่มี trigger บน `session_registrations`

---

## 7. ทำอะไรต่อ — WO-1.4

**Goal**: `is_gang_member()` / `is_gang_admin()` / `is_org_member()` + RLS policy ทุกตาราง + storage buckets
**DoD**: RLS tests ทั้ง 5 ข้อใน baseline §Verification ผ่านจริง

- ก๊วน A อ่านก๊วน B ไม่ได้
- member อ่าน `gang_line_configs` ไม่ได้
- non-member อ่านสลิปไม่ได้ (storage)
- guest token ใช้ข้าม session ไม่ได้
- ไม่เกิด recursion

**กติกาที่ห้ามลืม** (CLAUDE.md §2.8):
- security definer function ต้องมี `SET search_path` เสมอ
- policy เรียกแบบ `(SELECT is_gang_member(gang_id))` — วงเล็บทำให้ Postgres cache เป็น initplan
- ทุก policy ต้องกรอง `deleted_at IS NULL`
- ปิด 4 ช่องโหว่ในหัวข้อ 6 ไปพร้อมกัน

✅ `storage` container ขึ้นได้แล้วด้วยคำสั่ง start ในหัวข้อ 3 — ส่วน storage bucket ของ WO-1.4 ทำได้เลย

**Forbidden**: ห้ามเขียน UI/feature · ห้ามเพิ่มตารางนอก baseline · ห้ามแก้ state machine

**⚠️ กติกา migration**: 0001–0007 apply บน cloud แล้ว **ห้ามแก้ไฟล์เดิม** — แก้ = migration ใหม่เสมอ
(0008/0009 ยังไม่ขึ้น cloud จึงยังแก้ได้ แต่ถ้า push แล้วให้ถือกติกาเดียวกัน)

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
