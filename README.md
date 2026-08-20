# Gang Badminton

ระบบจัดการก๊วนแบดมินตัน — เปิดนัด · ลงชื่อ/คิวรอ · เช็คอิน · จัดคู่ · เก็บเงินค่าสนาม/ค่าลูก ·
รายงาน · ประกาศ · ค้นหาก๊วน · แจ้งเตือนผ่าน LINE (เลือกเปิดต่อก๊วน)

**Stack**: Next.js 16 (App Router) · Supabase (Postgres + Auth + Storage + Vault) ·
Astryx Design System · Tailwind v4 · TypeScript · Vitest + Playwright

> เอกสารที่ต้องอ่านคู่กัน
> · `CLAUDE.md` — กติกาบังคับของโค้ด (อ่านก่อนแตะโค้ด)
> · `gang-badminton-plan-v3.3-FINAL.md` — สถาปัตยกรรม + ADR ทั้งหมด (source of truth)
> · `STATE.md` — สถานะงานล่าสุด/จุดเริ่มงานถัดไป
> · `AGENT-EXECUTION.md` — Work Order ทุกใบและผลลัพธ์
> · `docs/errors.md` · `docs/rate-limits.md` · `docs/security-checklist.md`

---

## 1. ตั้งเครื่องให้รันได้ (local)

ต้องมี: **Node 22+** · **Docker** (สำหรับ Supabase local) · npm

```bash
npm ci

# Supabase local — ⚠️ ต้องตัด analytics/studio ออก ไม่งั้นสตาร์ตไม่ขึ้นบนเครื่องส่วนใหญ่
npm run supabase -- start -x studio,logflare,vector,edge-runtime,mailpit

# สร้างสคีมาทั้งหมด + seed ตัวอย่าง
npm run supabase -- db reset
```

คัดลอก env:

```bash
cp .env.example .env.local
# แล้วเติมค่าจาก `npm run supabase -- status`
```

| ตัวแปร | เอามาจากไหน | ไม่ตั้งแล้วเป็นอะไร |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `API_URL` ของ `supabase status` | 🔴 **หน้าที่มี realtime พังทั้งหน้า** (ดูข้อ 5) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `ANON_KEY` | เหมือนข้างบน |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `API_URL` / `SERVICE_ROLE_KEY` | ทุก DB function เรียกไม่ได้ (ระบบเกือบทั้งหมดพัง) |
| `CRON_SECRET` | สร้างเอง `openssl rand -base64 32` | `/api/cron/*` ปฏิเสธทุก request (fail-closed โดยตั้งใจ) |
| `LINE_LINK_SECRET` | สร้างเอง `openssl rand -base64 32` | ผูกบัญชี LINE / LINE Login ใช้ไม่ได้ |
| `APP_BASE_URL` | โดเมนของแอป (ไม่ตั้งก็เดาจาก header) | redirect ของ LINE Login อาจไม่ตรงกับที่ลงทะเบียนไว้ |

```bash
npm run dev          # http://localhost:3000
```

---

## 2. คำสั่งที่ใช้บ่อย

```bash
npm run dev / build / start
npm run typecheck / lint

npm test             # vitest ทั้งชุด (ต้องมี Supabase local ขึ้นก่อน)
npm run test:unit    # เฉพาะที่ไม่ต้องใช้ DB — ใช้เป็น PR gate
npm run test:e2e     # Playwright smoke (ต้อง build ก่อน — ดูข้อ 5)

npm run supabase -- db reset                    # สร้างสคีมาใหม่ทั้งหมด + seed
npm run supabase -- migration up                # apply migration ใหม่บน local
npm run supabase -- migration list --linked     # เทียบ local vs cloud
npm run astryx -- component <Name>              # docs ของ design system (เว็บถูก proxy บล็อก)
```

---

## 3. โครงงานโดยย่อ

```
app/        routes บางๆ — เรียก features เท่านั้น
features/   UI + logic ต่อฟีเจอร์
domain/     🔴 business logic ล้วน (ห้าม import next/react/supabase — มี lint rule + เทสต์คุม)
lib/        adapters: supabase · line · promptpay · security · storage · sync
server/     actions/ (shell เรียก DB function) · cron/ · line/ · security/
supabase/   migrations/ (39 ไฟล์) · seed/
tests/      vitest — domain · rls · concurrency · e2e (ผ่าน DB function)
e2e-browser/ Playwright — smoke ผ่านเบราว์เซอร์จริง
```

**กติกาที่พังบ่อยถ้าไม่รู้** (รายละเอียดเต็มใน `CLAUDE.md`)

- ❌ ห้ามนับที่ว่าง/เปลี่ยนสถานะใน TypeScript — ต้องผ่าน DB function ที่ `SELECT … FOR UPDATE`
- ❌ ห้ามอ่านราคาปัจจุบันตอนคิดเงิน — อ่านจาก `sessions.snapshot` ที่แช่แข็งไว้เสมอ
- ❌ ห้ามส่ง `as={NextLink}` จาก server component (Next 16) — ลิงก์ Astryx ได้ router จาก
  `LinkProvider` ใน `app/providers.tsx` แล้ว
- 🔴 เพิ่มตารางใหม่ = `enable row level security` + `grant` + `create policy` ครบสามอย่าง

---

## 4. ฐานข้อมูล cloud + Vault

```bash
mkdir -p supabase/.temp && printf '<project-ref>' > supabase/.temp/project-ref
npm run supabase -- db push --linked
```

🔴 **อย่าเชื่อข้อความ success ของ CLI** — ตรวจของจริงเสมอ:

```bash
npm run supabase -- db query --linked "select count(*) from supabase_migrations.schema_migrations"
```

**Vault** ใช้เก็บ credentials ของ LINE ต่อก๊วน (`gang_line_configs` เก็บเฉพาะ secret id)
— ไม่ต้องตั้งค่าอะไรเพิ่ม ถ้า `supabase_vault` มีอยู่ใน project (ตรวจด้วย
`select extname from pg_extension where extname='supabase_vault'`)

⚠️ **กับดักที่เสียเวลาไปแล้ว**: probe ของ Vault ต้องแยกเป็นคนละ statement —
`with created as (select vault.create_secret(...)) select … from vault.decrypted_secrets`
จะได้ผลว่า "พัง" เสมอ เพราะ CTE ที่เขียนข้อมูลไม่ถูกมองเห็นในคำสั่งเดียวกัน

**Cron** มีสองชั้นซ้อนกันโดยตั้งใจ (ทุกงาน idempotent):
- `pg_cron` ในฐานข้อมูล — งาน SQL ล้วน (sweep waitlist · rollup · purge rate limits)
- **Vercel Cron → `/api/cron/<job>`** — งานที่ต้องใช้ runtime ของแอป (ส่ง notification ·
  ออกบิลรายเดือน · generate นัดจากตาราง · reminder) · ตาราง cron อยู่ใน `vercel.json`

---

## 5. Deploy (Vercel)

> ✅ **production ตอนนี้อยู่ที่ https://gang-badminton.vercel.app**
> (Vercel team `webaons-projects` · ชี้ Supabase cloud `emmzeriekkjryhucvctx`)
>
> ✅ **auto-deploy เปิดแล้ว** — push เข้า `main` = ขึ้น production เอง · เปิด PR = ได้ preview URL
> ⇒ ไม่ต้องรัน `vercel --prod` ด้วยมืออีก
>
> 🔴 **Hobby plan ให้ cron วันละครั้งต่อ job** ⇒ งานที่ต้องถี่ (ส่งข้อความ · reminder)
> ขับด้วย **GitHub Actions** แทน — ดู `docs/cron.md`

1. ตั้ง Environment Variables ให้ครบตามตารางข้อ 1
   🔴 **`NEXT_PUBLIC_*` ต้องมีตั้งแต่ตอน build** — Next inline ค่าพวกนี้เข้าไปใน bundle
   ตอน build **ไม่ได้อ่านตอน runtime** ⇒ ถ้าตั้งทีหลังหรือลืมตั้ง หน้าที่ต่อ realtime
   (เช่นหน้ารายละเอียดนัด) จะ **พังทั้งหน้าในเบราว์เซอร์** โดย server ไม่ error เลย
   (เจอมาแล้วจริงตอน WO-5.E)
2. `npm run build` ต้องผ่านก่อนเสมอ · หน้าแรกต้องออกมาเป็น `○ /` พร้อม `Revalidate 1h`
   (ถ้ากลายเป็น `ƒ` แปลว่ามีใครเผลอใส่ `cookies()`/`force-dynamic` เข้าไป)
3. push migration ขึ้น cloud (ข้อ 4) **ก่อน** deploy โค้ดที่ใช้ของใหม่
4. ตั้ง Vercel Cron ตาม `vercel.json` และใส่ `CRON_SECRET` ให้ตรงกัน
   ⚠️ ถ้าอยู่บน **Hobby** ต้องตั้ง secret ของ GitHub repo ด้วย (`APP_BASE_URL`, `CRON_SECRET`)
   ไม่งั้นการแจ้งเตือนจะส่งวันละครั้ง — ดู `docs/cron.md`
5. ตั้งค่า LINE ต่อก๊วน (ถ้าใช้) — ดูข้อ 6

รัน smoke บน production build ที่เครื่องตัวเองก่อน deploy:

```bash
NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... npm run build
npm run test:e2e
```

---

## 6. ตั้งค่า LINE ต่อก๊วน (optional)

แอดมินก๊วนกรอกเองที่ `/gangs/<gangId>/settings` — **ค่าเหล่านี้ไม่ได้อยู่ใน env**
เพราะเป็นของแต่ละก๊วน และถูกเก็บลง **Vault** (ตารางเก็บแค่ secret id)

| ค่า | เอามาจาก LINE Developers Console |
|---|---|
| Channel access token | Messaging API channel → แท็บ Messaging API → Issue |
| Channel secret | แท็บ Basic settings (ใช้ verify ลายเซ็น webhook) |
| Webhook URL (ไปตั้งใน console) | `<โดเมน>/api/line/webhook/<gangId>` |
| Login channel ID + secret | **LINE Login channel ใน provider เดียวกัน** (คนละ provider = userId คนละใบ) |
| Callback URL (ไปตั้งใน console) | `<โดเมน>/api/line/login/callback` |
| LIFF ID + Endpoint URL | LIFF tab → Endpoint = `<โดเมน>/gangs/<gangId>/liff` |

การแจ้งเตือนในแอปทำงานเหมือนเดิมทุกอย่างแม้ไม่ต่อ LINE — LINE เป็นช่องทางเสริมผ่านคิวเดียวกัน

---

## 7. เวลามีปัญหา (runbook)

| อาการ | ตรวจตรงไหนก่อน |
|---|---|
| หน้าเว็บขาว/ปุ่มกดไม่ได้ ทั้งที่ server ตอบ 200 | console ของเบราว์เซอร์ — น่าจะเป็น CSP · หน้าที่ prerender ต้องอยู่ใน `STATIC_ROUTES` (`lib/security/csp.ts`) |
| หน้าที่มี realtime พังทั้งหน้า | `NEXT_PUBLIC_*` ตอน **build** (ข้อ 5) |
| แจ้งเตือนไม่ถึงผู้ใช้ | `notifications.status` + `last_error` · แถวค้าง `processing` มี cron sweep คืนคิวให้ |
| LINE ไม่ส่ง | `line_quota_status(gang_id)` (โควต้าเดือนนั้น) · `member_line_links.blocked_at` (ผู้ใช้บล็อก OA) · `gang_line_configs.is_enabled` |
| webhook ตอบ 401 | channel secret ในหน้าตั้งค่าไม่ตรงกับใน LINE console |
| ยอดเงินไม่ตรง | อ่านจาก **ledger** เท่านั้น (`charge_outstanding()` / `domain/billing/ledger.ts`) ❌ ห้ามนับจาก `payments.status` |
| เทสต์เขียวบนเครื่องแต่แดงบน CI | เทสต์ที่แตะคิวต้องวน claim จนเจอของตัวเอง · `dedupe_key` ต้องไม่ซ้ำข้ามการรัน (`STATE.md §8`) |
| push ขึ้น GitHub แล้ว 403 | `gh auth status` → `gh auth switch --user <เจ้าของ repo>` |

---

## 8. ความปลอดภัย

เดิน §Security Checklist ของ baseline ครบทุกข้อพร้อมหลักฐาน — ดู **`docs/security-checklist.md`**
