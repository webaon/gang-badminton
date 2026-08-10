# STATE — สถานะงานล่าสุด

> เอกสาร handoff ระหว่าง session (ที่ `AGENT-EXECUTION.md` บอกว่าจะเพิ่มเมื่อเจอปัญหา context จริง)
> **อัปเดตล่าสุด: 10 ส.ค. 2026** · เขียนตอนจบ WO-1.2 ก่อนผู้ใช้ไปเคลียร์ดิสก์ + รีบูตเครื่อง
>
> 📌 กลับมาทำงานต่อ: อ่านไฟล์นี้ → `CLAUDE.md` → แล้วเริ่มที่ **"ทำอะไรต่อ"** ด้านล่าง

---

## 1. ความคืบหน้า

| WO | งาน | สถานะ |
|---|---|---|
| **1.1** | Scaffold (Next.js 15 + Tailwind v4 + Astryx + CLAUDE.md) | ✅ **เสร็จ** `21ecf3a` |
| **1.2** | Schema migrations (28 ตาราง + index + constraint) | ✅ **เสร็จ** `22a7713` |
| **1.3** | DB functions (6 ตัว) + GUC trigger + rate_limits | ⬜ **ถัดไป** |
| 1.4 | RLS + security definer + storage buckets | ⬜ |
| 1.5 | Cron setup + seed | ⬜ |

Phase 2 ยังไม่แตก WO — baseline สั่งให้แตกตอนจบ Phase 1 เท่านั้น

---

## 2. Git

```
branch: claude/badminton-group-system-4pfs7o   (ทำงานอยู่บนนี้)
        main                                    (มีแค่ commit เอกสาร baseline)

22a7713  feat(WO-1.2): schema migrations — 28 tables, UUIDv7, partial unique, indexes
21ecf3a  feat(WO-1.1): scaffold Next.js 15 + Tailwind v4 + Astryx + baseline structure
e6cc3e8  docs: add approved baseline v3.3 + agent execution protocol
```

🔴 **ทั้ง 3 commit ยังอยู่ local — push ไม่ได้**

```
remote: Permission to webaon/gang-badminton.git denied to triple-tgg (403)
```
บัญชี `triple-tgg` (active) และ `moosmall` มีสิทธิ์แค่ `pull` บน `webaon/gang-badminton`

**ต้องทำ:** ขอ `webaon` เพิ่ม `triple-tgg` เป็น collaborator
(GitHub → repo → Settings → Collaborators) แล้วค่อย
`git push -u origin main && git push -u origin claude/badminton-group-system-4pfs7o`

---

## 3. Supabase — ใช้ cloud ไม่ใช่ local

| | |
|---|---|
| project | **gang-badminton** |
| ref | `emmzeriekkjryhucvctx` |
| host | `db.emmzeriekkjryhucvctx.supabase.co` |
| Postgres | 17.6.1.155 |
| region | ap-south-1 |
| migrations ที่ apply แล้ว | **7 / 7** |
| ข้อมูลใน DB | **0 แถวทุกตาราง** (ยังไม่ได้ seed) |

🔴 **ยังไม่มี RLS — ตารางเปิดโล่งทั้งหมด อย่าใส่ข้อมูลจริงจนกว่าจะจบ WO-1.4**

### วิธีเชื่อมต่อ (สำคัญ — มี workaround)

**Access token** อยู่ใน macOS Keychain (ไม่ใช่ไฟล์) อ่านโดยไม่ print ค่า:
```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
```

**`supabase link` พังเพราะบั๊กของ CLI 2.112.0** (API ส่ง `inserted_at` รูปแบบที่ validator ไม่รับ)
แต่ `db push` ทำงานปกติถ้ามีไฟล์ ref — ถ้าไฟล์หาย (เช่นหลัง clone ใหม่ เพราะ `.temp` ถูก gitignore):
```bash
mkdir -p supabase/.temp && printf 'emmzeriekkjryhucvctx' > supabase/.temp/project-ref
npm run supabase -- db push --linked
```

**ไม่มี `psql` ในเครื่อง** — รัน SQL ผ่าน Management API แทน มีสคริปต์ช่วยที่
`/private/tmp/.../scratchpad/q.sh` (ไฟล์ scratchpad หายหลังรีบูต — สร้างใหม่ได้จาก pattern นี้):
```bash
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.stdin.read()}))' <<<"$SQL")"
```

---

## 4. 🔴 Blocker ที่ต้องเคลียร์ก่อนเริ่ม WO-1.3

### ดิสก์เต็ม
ตอนหยุดงาน: ใช้ไป ~197 GB จาก 228 GB — **เหลือว่าง ~4 GB**

`supabase start` (local) ต้องการพื้นที่ว่าง **~20 GB** เพราะ image
`supabase/postgres:17.6.1.158` มี nix store พ่วงมา (ตอน extract กิน 12 GB ที่เคลียร์ไว้จนหมด)

ตัวใหญ่บนเครื่อง: `~/Library/CloudStorage` 30G · `~/Library/Application Support` 28G ·
`~/Desktop` 22G · `~/Library/Containers` 13G · `~/Downloads` 8.5G
(npm cache ล้างไปแล้วรอบหนึ่ง 4G → 815M)

### Docker Desktop ล่ม
containerd `meta.db` เจอ I/O error ตอนดิสก์เต็ม → daemon ไม่ขึ้น
กระทบ container ของ**โปรเจกต์อื่น**ด้วย: `qr-marco-postgres`, `qr-marco-redis`
น่าจะกลับมาเองหลังมีพื้นที่ว่างพอ + รีบูต

### ทำไม WO-1.3 ต้องใช้ local
baseline §Verification บังคับว่า concurrency tests ต้องยิง request พร้อมกันผ่าน
**transaction pooling** เพื่อยืนยันพฤติกรรม GUC/lock บน path เดียวกับ production
- `config.toml` เปิด `[db.pooler]` ไว้ให้แล้ว
- local pooler port = **54329** (baseline อ้าง 6543 ซึ่งเป็นพอร์ตของ cloud) → บันทึกเป็น D-6
- ทางเลือกถ้าเคลียร์ดิสก์ไม่ได้: รันบน cloud (ช้ากว่า + กิน quota) หรือใช้เครื่องอื่น

---

## 5. ทำอะไรต่อ — WO-1.3

**Goal**: DB functions ทั้ง 6 + GUC trigger + `rate_limits`
**DoD**: concurrency tests ทั้ง 4 ข้อใน baseline §Verification ผ่านจริง (ผ่าน pooled port)

| ต้องสร้าง | หมายเหตุ |
|---|---|
| `register_to_session()` | `FOR UPDATE` แถว session → นับที่ว่าง → confirmed/waitlist + ตรวจ `features.guests` + validate invite token |
| `cancel_registration()` | mark cancelled + penalty จาก **snapshot** + เรียก promote ในตัว |
| `promote_waitlist()` | `FOR UPDATE` → เรียงตาม ordering + reliability (คำนวณสดจาก registrations/event_logs) |
| `check_in_registration()` | confirmed → checked_in เท่านั้น |
| `transition_session()` | ตรวจ transition + set GUC `app.allow_transition` + เขียน event |
| `close_session_with_charges()` | ADR-001 — ตรวจ `expected_status` ก่อน แล้ว insert charges + event แบบ atomic; ต้อง set GUC เองไม่งั้น trigger ตัวเองบล็อก |
| BEFORE UPDATE trigger | บน `sessions` + `payments` — ตรวจ `OLD.status IS DISTINCT FROM NEW.status` แล้วเช็ค GUC ถ้าไม่มี = raise `DIRECT_STATUS_UPDATE_FORBIDDEN` |
| `rate_limits` | **unlogged table** `(key, window_start, count)` + `check_rate_limit(key, limit, window)` |

**Concurrency tests 4 ข้อ (DoD):**
1. ยิง `register_to_session` พร้อมกัน 2 request ตอนเหลือ 1 ที่ → confirmed 1 + waitlist 1 เสมอ ไม่ overbook
2. cancel พร้อมกัน 2 คน → promote ไม่ซ้ำคน ไม่ข้ามคิว
3. notification worker 2 ตัวรันทับกัน → ไม่ส่งซ้ำ (`SKIP LOCKED`)
4. เรียก `close_session_with_charges` ด้วย `expected_status` ล้าสมัย → `INVALID_TRANSITION` และ**ไม่มี charges เกิดขึ้นเลย**

**ก่อนเริ่มต้องมี** (อยู่ใน BACKLOG แล้ว): **vitest** — ยังไม่ได้ตั้ง แต่ DoD ต้องใช้รัน concurrency tests

**Forbidden**: ห้ามเขียน UI/feature · ห้ามเพิ่มตารางนอก baseline · ห้ามแก้ state machine

**⚠️ กติกา migration**: migrations 0001-0007 apply บน cloud ไปแล้ว **ห้ามแก้ไฟล์เดิม** — แก้ = migration ใหม่เสมอ

---

## 6. สิ่งที่ค้นพบไปแล้ว อย่าเสียเวลาค้นซ้ำ

- **Astryx × Tailwind ใช้ร่วมกันได้** ผ่าน bridge `@astryxdesign/core/tailwind-theme.css`
  StyleX เป็น optional (ติดตั้งเป็น peer dep แต่ไม่ได้ตั้ง compiler → **ห้ามใช้ `xstyle`/`stylex.create()`**)
- **cascade layer order สำคัญมาก** อยู่ใน `app/layers.css` (ไฟล์แยก เพราะ webpack hoist `@import`)
  ผิดแล้วพังเงียบไม่มี error — ยืนยันจาก CSS ที่ build แล้วว่าถูกต้อง
- **astryx CLI path จริง** = `node_modules/@astryxdesign/cli/**clients/cli/**bin/astryx.mjs`
  (baseline บรรทัด 52 เขียนผิด) → `npm run astryx -- <cmd>`
- **`uuid_generate_v7()` แก้เป็น RFC 9562 Method 3 แล้ว** (sub-millisecond ใน `rand_a`)
  ถ้าเขียน UUIDv7 ที่ไหนอีกอย่าลอกเวอร์ชัน ms อย่างเดียว — มันไม่ monotonic
- **`npm audit` 3 high** อยู่ใน transitive deps ของ `next@15.5.23` (postcss, sharp)
  แก้ต้องขึ้น next@16 = ขัด baseline ⇒ ต้องผ่าน ADR (ดู BACKLOG)
- รายละเอียดที่เหลือทั้งหมดอยู่ใน **`BACKLOG.md`**

---

## 7. คำสั่งที่ใช้บ่อย

```bash
npm run dev / build / typecheck / lint
npm run astryx -- <cmd>        # docs/components/tokens ของ Astryx
npm run supabase -- <cmd>      # CLI (devDependency ไม่ได้ลง global)
npm run supabase -- db push --linked --dry-run    # ดูว่าจะ push อะไรบ้าง
npm run supabase -- migration list --linked       # เทียบ local vs remote
```
