# CLAUDE.md — Gang Badminton

> กติกาบังคับสำหรับ agent ทุกตัวที่ทำงานใน repo นี้
> **Source of truth ทางสถาปัตยกรรม = `gang-badminton-plan-v3.3-FINAL.md`** (Baseline v1.0, approved)
> วิธีสั่งงาน/แบ่ง Work Order = `AGENT-EXECUTION.md`

---

## 0. กติกาสูงสุด (อ่านก่อนแตะโค้ด)

1. **Baseline คือ source of truth** — ขัดแย้งกันเมื่อไหร่ section `Database Functions` และ `State Machines` เป็น **authoritative เหนือส่วนอื่น**
2. **เจอสิ่งที่แผนไม่ครอบ หรือทำตามตัวอักษรไม่ได้ → หยุด ถาม ห้ามเดา**
   เขียนในรูป `แผนบอก X / ของจริงคือ Y / ทางเลือกคือ Z` แล้วรอคำตอบ
3. **ห้ามขยาย scope เกิน WO ปัจจุบัน** — เห็นของที่ควรทำเพิ่ม = จดลง `BACKLOG.md` **ไม่ทำเลย**
4. **ทุก WO จบด้วย verification ของตัวเอง** — test ใน DoD ต้อง**รันผ่านจริง** ไม่ใช่ "เขียนไว้แล้ว"
5. **หนึ่ง WO = อย่างน้อยหนึ่ง commit ที่ build ผ่าน** push ไป `claude/badminton-group-system-4pfs7o`
6. **ห้ามแก้ baseline โดยตรง** — เปลี่ยนสถาปัตยกรรม = เขียน **ADR entry ใหม่ต่อท้าย** baseline (context → options → decision → consequences ~10 บรรทัด)
7. **Deviation ห้ามแก้เงียบ** — บันทึกใน PR description และถ้ากระทบสถาปัตยกรรม = ADR ใหม่

---

## 1. UI — Astryx = components / Tailwind = layout

**กติกาแยกหน้าที่ (ห้ามข้าม):**

| ใช้ | สำหรับ |
|---|---|
| **Astryx** (`@astryxdesign/core/*`) | component ทุกตัว — Button, Card, Table, Input, Dialog, ... **รวมถึงโครง layout** (AppShell, Layout, VStack, HStack, Stack) |
| **Tailwind** (`className`) | **เก็บรายละเอียด layout ที่ไม่มี prop รองรับ** — max-width, position, grid เฉพาะทาง |

> **⚠️ Deviation note (WO-1.1)** — baseline เขียนว่า "Tailwind = layout เท่านั้น" แต่ Astryx agent rules
> (ท้ายไฟล์นี้) บอก **"No `<div>` — components do all layout/spacing"** สองข้อนี้ตึงกัน
> **ทางออกที่ใช้:** layout หลักใช้ Astryx layout components ก่อนเสมอ → Tailwind เป็นตัวเสริมเฉพาะที่
> Astryx ไม่มี prop ให้ (เช่น `max-w-2xl`, `mx-auto`) ซึ่งยังตรงเจตนา baseline คือ
> **"ห้าม import ไลบรารี UI อื่น"** — ถ้าตีความนี้ผิด ให้แก้ผ่าน ADR ไม่ใช่แก้เงียบ

**Fallback rule เมื่อ Astryx ไม่มี component ที่ต้องการ:**

```
1. หาใน Astryx ก่อนเสมอ  →  npm run astryx -- search <คำค้น>
2. ไม่มีจริง → เขียน custom ใน components/ui/ โดยใช้ Astryx token (CSS vars)
3. ❌ ห้าม import ไลบรารี UI อื่นเด็ดขาด (shadcn, Radix, MUI, Chakra, ...)
```

### 1.1 ⚠️ Cascade layer order — พังเงียบถ้าผิด

ลำดับ layer ถูกประกาศใน **`app/layers.css`** (ไฟล์แยก import แรกสุดใน `globals.css`)

```
reset → theme → base → astryx-base → astryx-theme → components → utilities
```

- **ห้ามเพิ่ม `@import` ที่ไม่ระบุ `layer()`** — unlayered CSS ชนะทุก layer โดยไม่สนใจ specificity
- **ห้ามสลับลำดับ `@import` ใน `globals.css`** — Tailwind preflight ต้องอยู่ `layer(base)` เหนือ `reset`
- ลำดับผิด = Astryx component เสีย style **โดยไม่มี error ใดๆ**
- ตรวจได้ด้วย: `npm run astryx -- docs migration` หัวข้อ *Cascade Layer Safety*

> หมายเหตุ: Lightning CSS จะ optimize `@layer` declaration ที่ซ้ำซ้อนออกจาก CSS ที่ build แล้ว
> (เพราะลำดับ emission ถูกต้องอยู่แล้ว) — **ไม่ใช่บั๊ก** อย่าไปแก้ `layers.css` เพราะไม่เห็นใน output

### 1.2 ⚠️ ห้ามใช้ `xstyle` prop / `stylex.create()` ในโค้ดแอป

`@stylexjs/stylex` ถูกติดตั้งเพราะเป็น peer dependency ของ Astryx **แต่โปรเจกต์นี้ไม่ได้ตั้ง StyleX compiler**
(ตั้งแล้วต้องใช้ babel → เสีย SWC/Turbopack) — Astryx components ส่ง CSS ที่ compile มาแล้ว จึงทำงานปกติ
แต่ `stylex.create()` ที่เราเขียนเองจะ **ไม่ถูก compile → ไม่มี style ออกมา เงียบๆ**

➡️ styling ที่เขียนเอง ใช้ `className` (Tailwind) หรือ CSS Module ที่อ้าง Astryx token เท่านั้น

### 1.3 Theme

- ใช้ `@astryxdesign/theme-neutral/built` + `theme.css` (**pre-built สำหรับ SSR**)
- ❌ ห้ามใช้ runtime `defineTheme()` ในหน้า production — style จะ inject หลัง hydration
- Theme provider อยู่ที่ `app/providers.tsx` (client component)

### 1.4 CLI คือแหล่ง docs (เว็บถูก proxy บล็อก)

```bash
npm run astryx -- component          # list components ทั้งหมด
npm run astryx -- component Button   # props + usage + theming
npm run astryx -- search <query>     # ค้นข้าม component/hook/docs/template
npm run astryx -- docs tokens        # token ทั้งหมด
npm run astryx -- doctor             # ตรวจ setup
```

Cheat sheet ของ Astryx อยู่**ท้ายไฟล์นี้** ระหว่าง `<!-- ASTRYX:START -->` / `<!-- ASTRYX:END -->`
— generate โดย `npm run astryx -- init --agent claude` ⇒ **ห้ามแก้มือในบล็อกนั้น** (จะถูกเขียนทับตอน upgrade)

> ในบล็อกนั้นเขียนคำสั่งเป็น `npx astryx <cmd>` — **ใน repo นี้ให้ใช้ `npm run astryx -- <cmd>`**
> (script ชี้ path จริง `node_modules/@astryxdesign/cli/clients/cli/bin/astryx.mjs`)

---

## 2. Database — logic อยู่ใน Postgres ไม่ใช่ TypeScript

### 2.1 🔴 ห้ามนับที่ว่างใน TypeScript

การลงชื่อ / waitlist / check-in **ทั้งหมด**ต้องผ่าน DB function ที่ `SELECT ... FOR UPDATE`
แถว `sessions` ก่อนนับ — app code เป็น **shell** เรียกฟังก์ชันเท่านั้น

| Function | หน้าที่ |
|---|---|
| `register_to_session(...)` | lock session → นับที่ว่าง → insert confirmed/waitlist |
| `cancel_registration(...)` | mark cancelled + คิด penalty จาก snapshot + promote ในตัว |
| `promote_waitlist(...)` | lock → เลื่อนคิวตาม ordering + reliability → event + notification |
| `check_in_registration(...)` | confirmed → checked_in + event |
| `transition_session(...)` | ตรวจ transition ที่อนุญาต + event + raise ถ้านอก flow |
| `close_session_with_charges(...)` | จุด commit เดียวของเงินตอนจบ session (ADR-001) |

❌ **ห้ามเขียน check-then-act ใน TS เด็ดขาด** (`if (count < max) insert(...)`) — race condition แน่นอน
cron sweep มีไว้กันงานหลุด **ไม่ใช่กันชน**

### 2.2 🔴 State transition ห้าม UPDATE status ตรงๆ

**Session**: `draft → open → in_play → billing → settled → archived`
เส้นเพิ่มเติมที่อนุญาต: `draft/open → cancelled`, `in_play → cancelled`, `open → billing`

**Payment**: `pending → submitted → verified | rejected` และ `rejected → submitted`

**Registration**: `waitlist → confirmed` (ผ่าน `promote_waitlist()` **เท่านั้น**),
`confirmed → checked_in | cancelled | no_show`, `waitlist → cancelled`
— ❌ ห้าม `waitlist → checked_in` ตรง

กลไกบังคับ: **BEFORE UPDATE trigger** ตรวจ `OLD.status IS DISTINCT FROM NEW.status`
แล้วเช็ค GUC `app.allow_transition` ที่ `transition_session()` เป็นคน `set_config(..., true)`
— ไม่มี setting = **raise exception**

> **"เต็ม" ไม่ใช่ state** — derive จาก `count(confirmed) >= max_players` เสมอ
> ถ้าทำเป็น state จะต้อง transition กลับทุกครั้งที่มีคนยกเลิก = sync bug

### 2.3 🔴 Billing — ADR-001

```
server action:  อ่าน snapshot + registrations + games
             →  SessionBilling.calculate()   [TypeScript, pure, unit-testable]
             →  close_session_with_charges(session_id, charges, expected_status)
                                             [DB function — atomic commit จุดเดียว]
```

- ❌ **ห้ามย้าย billing logic ลง SQL**
- ❌ **ห้าม insert `session_charges` ประเภท `session` ที่อื่นนอกจาก `close_session_with_charges()`**
- charges ประเภท `monthly_fee` commit ผ่านฟังก์ชันของ MembershipBilling เอง (**idempotent ต่อสมาชิก+เดือน**) เพราะไม่มี session ให้ transition
- `expected_status` = optimistic guard — ไม่ตรง = raise `INVALID_TRANSITION` ให้ server action คำนวณใหม่
- `close_session_with_charges()` เปลี่ยน status เอง จึงต้อง set GUC `app.allow_transition` ภายใน (หรือเรียก `transition_session()` ข้างใน) ไม่งั้น trigger ของตัวเองจะบล็อกตัวเอง

### 2.4 Snapshot rule

`sessions.snapshot` (jsonb) เก็บ **pricing plan เต็มก้อน + rounding policy + PromptPay ID +
ราคาคอร์ท/ลูก + cancellation policy + skill scale** ณ ตอนสร้างนัด + key `snapshot_version`

➡️ **ตอนคิดเงินอ่านจาก snapshot เสมอ ห้ามอ่านค่าปัจจุบันจาก `gangs` / `gang_pricing_plans`**
(ราคาเปลี่ยนทีหลังต้องไม่กระทบนัดเก่า)

Snapshot คือบันทึกแช่แข็ง — ไม่มี query pattern ที่ต้อง index เข้าไปข้างใน อย่าแตกเป็นคอลัมน์

### 2.5 🔴 PK vs Secret token

| | ใช้ | ห้าม |
|---|---|---|
| **PK ทุกตาราง** | `uuid_generate_v7()` (เรียงตามเวลา ลด index fragmentation) | `gen_random_uuid()` |
| **Secret token** | `gen_random_bytes(32)` → base64url → **เก็บเฉพาะ SHA-256 hash** | UUID ทุกชนิด |

❌ **ห้ามใช้ PK แทน token เพราะสะดวก** — UUIDv7 ฝัง timestamp ⇒ เดาได้
ใช้กับ `session_invite_tokens.token_hash` และ `session_registrations.guest_access_token_hash`
❌ **ห้าม log plaintext token**

### 2.6 Schema hygiene

- **เงินทุกคอลัมน์ `DECIMAL`** — ❌ ห้าม float
- **Soft delete** `deleted_at` บน `sessions`, `gang_members`, `payments`, `gangs`, `session_registrations`
  ➡️ ทุก query/policy ต้องกรอง `deleted_at IS NULL`
- **Unique บนตาราง soft delete = partial unique index เสมอ**
  เช่น `UNIQUE(gang_id, user_id) WHERE deleted_at IS NULL`
- **ทุก FK มี index**; composite index นำหน้าด้วย tenant key ตาม query จริง (equality ก่อน range/sort)
- `timestamptz` ทั้งหมด; ก๊วนมี `timezone` (default `Asia/Bangkok`) — แสดงผล/generate แปลงตาม timezone ก๊วนเสมอ

### 2.7 Migration policy

- ❌ ห้ามแก้ migration ที่รันบน production แล้ว — แก้ = **migration ใหม่เสมอ**
- เปลี่ยน schema แบบ **expand → migrate → contract** (additive → backfill → สลับ read → ลบของเก่า release ถัดไป)
- ทุก migration ระบุแนวทาง rollback; migration ที่ย้อนไม่ได้ (drop/truncate) ต้อง review เพิ่มหนึ่งชั้น

### 2.8 RLS

- Security definer functions ต้องมี `SET search_path` เสมอ: `is_gang_member()`, `is_gang_admin()`, `is_org_member()`
- Policy เรียกแบบ **`(SELECT is_gang_member(gang_id))`** — วงเล็บทำให้ Postgres cache เป็น initplan ไม่เรียกซ้ำต่อแถว
- Guest เขียนผ่าน DB function ที่ validate invite token — ❌ **ไม่มี service-role endpoint เปิด**
- `gang_line_configs` server-only

---

## 3. Layer discipline

```
app/        routes บางๆ — เรียก features เท่านั้น
features/   UI + logic ต่อฟีเจอร์
components/ ui/ (Astryx wrapper + custom) · layout/ (โครงหน้า Tailwind)
domain/     🔴 business logic ล้วน — ห้าม import next / react / supabase
lib/        infrastructure adapters (supabase, promptpay, line, crypto, events, notify)
server/     actions/ (shell เรียก DB functions) · cron/ (route handlers)
shared/     helper กลาง — typed response contract
supabase/   migrations/ · seed/
types/      shared types
```

### 🔴 `domain/` ห้าม import framework

`domain/` เป็น pure TypeScript เท่านั้น — ห้าม `next`, `react`, `@supabase/*`
มี lint rule ใน CI ตรวจข้อนี้ (ดู `BACKLOG.md` ถ้ายังไม่ได้ตั้ง)

เหตุผล: `domain/billing` + `domain/matching` ต้อง unit test ได้เต็มโดยไม่ต้อง mock framework

### 🔴 สิทธิ์ตรวจผ่าน `can()` เท่านั้น

`domain/permissions/can(role, action)` เป็น **แหล่งเดียว** ของ mapping role → สิทธิ์
❌ ห้าม hardcode `if (role === 'admin')` กระจายตามไฟล์

### 🔴 Feature flag ต้อง enforce ฝั่ง server

`gangs.features` (jsonb): `line`, `discovery`, `guests`, `coupons`, `statistics`

ตรวจที่ **`domain/permissions/can()`** และ **ใน DB function ที่เกี่ยวข้อง**
(เช่น `register_to_session` ตรวจ `features.guests` ก่อนรับ guest)

➡️ **UI ซ่อนปุ่มอย่างเดียว = flag ปลอม**

---

## 4. API response contract + error catalog

route handlers ทุกตัว (cron, webhook, endpoint ที่ guest เรียก) ตอบรูปแบบเดียว:

```ts
{ success: boolean, data?: T, error?: { code: ErrorCode, message: string } }
```

server actions ใช้ typed return เดียวกันผ่าน helper ใน `shared/`

### 🔴 `error.code` ต้องมาจาก `docs/errors.md` เท่านั้น

- DB functions raise ด้วย code เดียวกัน แล้ว map ผ่าน helper
- frontend แปลภาษาจาก code
- ❌ **ห้าม hardcode ข้อความ error กระจาย**
- เพิ่ม code ใหม่ = เพิ่มใน `docs/errors.md` ก่อน

---

## 5. Observability

- ทุก request / cron run มี **correlation id** แนบใน log และส่งต่อเข้า `event_logs.payload` เมื่อเขียน event
- ❌ **ห้าม swallow error เงียบ**
- `event_logs` เป็น**ตารางเดียว**สำหรับ event ธุรกิจ + audit (`type = 'audit.*'` เก็บ before/after)
  — append-only, ไม่มี `audit_logs` แยก, **ไม่ใช่ event sourcing** (ไม่มี replay จึงไม่มีคอลัมน์ version)

---

## 6. คำสั่งที่ใช้บ่อย

```bash
npm run dev          # dev server
npm run build        # production build — ต้องผ่านก่อนทุก commit ใหญ่
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run astryx -- <cmd>    # Astryx CLI (docs/components/tokens)
npm run supabase -- <cmd>  # Supabase CLI (local dev, migrations)
```

---

## 7. เวอร์ชันที่ pin ไว้ (ห้ามอัปเดตโดยไม่มีเหตุ)

| Package | Version | หมายเหตุ |
|---|---|---|
| `next` | `15.5.23` | baseline ระบุ Next.js 15 — ขึ้น 16 = ADR |
| `react` / `react-dom` | `19.2.8` | Astryx ต้องการ >= 19 |
| `tailwindcss` | `4.3.3` | v4 (bridge ใช้ `@theme inline`) |
| `@astryxdesign/core` · `theme-neutral` · `cli` | `0.3.0` | **Beta — pin ตายตัวทั้งชุด ต้องเวอร์ชันตรงกัน** |
| `@stylexjs/stylex` | `0.19.0` | peer dep ของ Astryx — ไม่ได้ใช้เอง (ดู §1.2) |
| `supabase` (CLI) | `2.112.0` | devDependency ไม่ลง global |

<!-- ASTRYX:START -->
Astryx v0.3.0 · 155 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else Tailwind utilities backed by tokens (bg-surface, text-primary, rounded-lg) via tailwind-theme.css. No raw hex/px.
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any style={{…}}, raw <div>/<span> layout, imported .css/@apply, or hardcoded/arbitrary value (e.g. bg-[#fff], p-[13px]) with the component or a token-backed utility. If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   155 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
