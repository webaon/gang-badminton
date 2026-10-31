# Phase 6 — Redesign "BadGame" ตาม Hi-fi 87 หน้า + Tokens v4

> แผนโดย @gb-planner · **สถานะ: Track A อนุมัติแล้ว — เริ่ม WO-6.0** (เจ้าของงานตัดสินแล้ว: ดู §3.1)
> แหล่งที่อ่าน (อยู่นอก repo): `../design/Screen inventory.html` · `../design/Hi-fi.html` (+ `hifi/*.jsx`) ·
> `../design/Design tokens.html` · `../design/hifi/tokens.css` (v4) · `../design/docs/ADR-002-004.md` ·
> `../design/uploads/BadGame Brand Guideline Board-1.png`
> baseline ไม่มี Phase 6 ⇒ ทุกอย่างในไฟล์นี้เป็นงาน**นอก baseline** และต้องได้ OK ก่อนทำ

---

## 1. สรุปของที่ได้รับมา

| ชิ้น | เนื้อหา | หมายเหตุ |
|---|---|---|
| Screen Inventory | 72 หน้า + 15 states = **87 artboards** แบ่ง 13 กลุ่ม (A–M) | ทุกหน้ามี hi-fi แล้ว · tag MVP-0 / 2.5 / 3 / 4 อิงตาม phase ของ baseline เดิม |
| Hi-fi | React prototype (มือถือ 390×844 สำหรับสมาชิก · เดสก์ท็อป 1280×800 สำหรับแอดมิน) | ใช้ CSS class ของตัวเอง (`.btn` `.chip` `.seg` `.toggle`) **ไม่ใช่ Astryx** |
| Tokens v4 | 3 ชั้น: spec → ramp/ส่วนขยาย → component + alias | Blue `#0169CC` · neutral เทา · orange = สถานะรอ/waitlist เท่านั้น · navy = live board · Segoe UI + Noto Sans Thai · ปุ่มทรง pill · card radius 16 · เงาเป็นเส้นขอบ |
| ADR ฝั่ง design | 7 ฉบับ (courts · ranking 2 ระบบ · หารค่าลูก · credit ledger · waitlist offer · game results · custom roles) | **เลข ADR ชนกับ ADR-002…009 ที่มีอยู่แล้วใน baseline** (ดู §3 C1) |

**กฎการใช้ของ tokens v4** (ต้องเข้า CLAUDE.md): ใช้ primary สีเดียวกับทุก interaction ·
orange ใช้เฉพาะสถานะรอ/waitlist (ยกเว้นปุ่มจ่ายเงิน #30 กับปุ่มปิดรอบบน live board) · 1 primary ต่อหน้าจอ ·
`shadow-raised` ได้ใบเดียวต่อหน้า · ข้อความรองต้องเป็น `text-muted #6B6B6B` (ห้ามใช้ icon-muted) ·
tap target ≥ 44px · mono ใช้เฉพาะรหัส ตัวเลขเงินใช้ sans + tabular-nums

---

## 2. Gap analysis — 87 หน้าเทียบกับระบบจริง (v1.0.0)

แบ่งเป็น 3 ถัง:

- **R = reskin** — backend/สิทธิ์มีครบแล้ว เปลี่ยนแค่ UI (ไม่มี migration)
- **R+** — reskin และต้องเพิ่ม query อ่านอย่างเดียว หรือ action เล็กๆ ที่ไม่แตะ state machine / เงิน
- **N = ความสามารถใหม่** — ต้องมี ADR และ/หรือ migration ⇒ **ต้องได้คำตัดสินก่อน**

| กลุ่ม | หน้า | ถัง | route ปัจจุบัน / หมายเหตุ |
|---|---|---|---|
| A Auth | 01 Welcome, 02 สมัคร, 03 เช็คอีเมล, 05 โปรไฟล์ | R | `/`, `/sign-up`, `/sign-in`, `/profile` (มี magic link แล้ว) |
| A | 04 ลืมรหัสผ่าน | **N** | ยังไม่มี SMTP และปิดยืนยันอีเมลไว้ (`mailer_autoconfirm`) |
| B | 06, 07 wizard, 08 ขอเข้า, 09 สำเร็จ | R | `/gangs`, `CreateGangForm`, `join_requests` |
| C | 10 Dashboard แอดมิน | R+ | ยังไม่มีหน้า ต้องรวมตัวเลข ค้างจ่าย/สลิปรอตรวจ/คำขอ/กำไรเดือนนี้ จากของที่มีอยู่ |
| C | 11, 12, 13, 14, 15, 16 | R | members / settings / `PricingAndSkills` |
| C | 14b นโยบายหารค่าลูก | **N** | ขัดกับ ADR-005 ที่มีอยู่ (C7) |
| C | 49 จัดการคอร์ท | **N** | ตาราง `courts` ใหม่ (design ADR-002) |
| D | 17, 18, 19, 20, 21, 22 | R | sessions/*, guest, join |
| D | 47 ตารางสนามหลายคอร์ท | R+ / N | ทำเป็น view ของ `games` ได้ก่อน · ส่วนลาก-วางขัดกับ D-19 (C10) |
| E | 23, 24, 25, 26, 27 | R | console + scan · #24 เป็นธีม navy เต็มจอ |
| F | 28, 29, 30, 31, 32, 33, 34 | R | close / pay / payments / LedgerPanel |
| G | 35, 36, 37 | R | notifications / announcements |
| H | 38, 39a, 40, 41 | R | reports / stats / timeline |
| H | 39b Elo, 50 ตั้งค่า ranking | **N** | ต้องเก็บผลเกม (design ADR-003) |
| I | 42, 43, 44 | R / R+ | #43 โปรไฟล์ก๊วนสาธารณะต้องมี DB function ใหม่ตาม ADR-007 **ห้ามเปิด policy บน `gangs`** |
| J | 45, 46 | R | line |
| J | 48 สรุปผลผ่านไลน์ | R+ | ข้อความสรุปสร้างใน `domain/` + ปุ่มคัดลอก · ส่ง Flex ต้องผ่าน whitelist ของ `line-message.ts` |
| K | ทั้ง 15 states | R | ต้องมี mapping ErrorCode → ข้อความไทยกลาง (ค้างใน BACKLOG) |
| L | 51 Onboarding, 52 แก้นัด, 53/53b นัดประจำ | R / R+ | templates มีแล้ว · #53b "ข้ามวัน" ต้องตรวจว่าทำได้ด้วยการลบนัดหรือเปล่า |
| L | 52b ยกเลิกนัด **+ คืนเป็นเครดิต** | **N** | ยกเลิกนัดทำได้แล้ว แต่ "เครดิต" ขึ้นกับ C8 |
| L | 54 Push notification | **N** | ยังไม่มี web push ใน baseline (C9) |
| L | 55 ออกจากก๊วน, 55b โอน owner | **N (เล็ก)** | ต้องมี DB function ใหม่ 2 ตัว (ตรวจยอดค้าง / owner ต้องมีหนึ่งคนพอดี) |
| M | 56 PDPA, 56b ลบบัญชี/ขอข้อมูล | **N** | ตาราง consent + export + anonymize |
| M | 57 เครดิตของฉัน | **N** | C8 |
| M | 58 คิวของฉัน + ขอพัก | R+ / N | ส่วนดูคิว = R+ · "ขอพัก 1 รอบ" ต้องส่งเข้า Matching (N เล็ก) |
| M | 59 สลับก๊วน | R | UI ล้วน |
| M | 60 รายจ่าย + สต็อกลูก | R / N | รายจ่ายมีแล้ว (`FinanceEntries`) · สต็อกลูกเป็นของใหม่ |
| M | 61 ยืนยันรับที่ว่าง | **N (ใหญ่)** | เปลี่ยน state machine ของ registration (C5) |
| M | 62 ส่งผลเกม | **N** | design ADR-007 |
| M | 63 สมาชิกรายเดือน | R | `/membership` |
| M | 64 การจับคู่ของฉัน | **N** | baseline "ไม่รับ" Constraint stage ไว้ (C6) |
| M | 65 บทบาทและสิทธิ์ | **N (ใหญ่)** | baseline "ไม่รับ" RBAC เต็มรูปไว้ (C6) |
| M | 66 ช่วยเหลือ | R+ | FAQ static · ส่งความคิดเห็นต้องมีตาราง/ปลายทาง |

**สรุป: ประมาณ 70 จาก 87 artboards ทำได้ด้วยการ reskin ล้วน** ⇒ แยกเป็น **Track A** ทำได้ทันที ·
ที่เหลือเป็น **Track B** รอคำตัดสินทีละเรื่อง

---

## 3. จุดที่ขัดกัน — `แผนบอก X / ของจริงคือ Y / ทางเลือกคือ Z`

| # | เรื่อง | แผน / design บอก | ของจริง | ทางเลือก (★ = ที่แนะนำ) |
|---|---|---|---|---|
| **C1** | เลข ADR | design ADR-002…008 "ต่อท้าย baseline ได้เลย" | baseline มี ADR-002…009 อยู่แล้วและเป็นคนละเรื่องกัน | ★ ตอนรับเข้าแต่ละเรื่อง ให้เลขใหม่ ADR-010+ และเขียนใหม่ให้เข้ากับโค้ดจริง · ห้าม copy ทั้งไฟล์ |
| **C2** | แบรนด์ | Brand board: `#3380F4` + เขียว lime + ฟอนต์ Fastwork · ชื่อ **BadGame** | Tokens v4 (ระบุว่า "ล็อกแล้ว"): `#0169CC` + orange + Segoe UI/Noto Sans Thai · แอปใช้ชื่อ "Gang Badminton" | ★ ใช้ **tokens v4** เป็น source of truth ของ UI · ชื่อในแอปเปลี่ยนเป็น BadGame · repo/โดเมนคงเดิม |
| **C3** | Dark mode | hi-fi มีแต่ light (navy ใช้เฉพาะ live board) | `Theme mode="system"` ⇒ production ขึ้นเป็น dark ตาม OS | ★ ล็อก `mode="light"` · dark ไปไว้ BACKLOG |
| **C4** | วิธีสร้าง UI | hi-fi ใช้ CSS ของตัวเอง | CLAUDE.md: Astryx = components, ห้ามใช้ raw hex, ห้ามใช้ไลบรารี UI อื่น | ★ ทำ theme `badgame` ด้วย `defineTheme` + `astryx theme build` (prebuilt CSS, ปลอดภัยกับ SSR) แล้วประกอบหน้าจากคอมโพเนนต์ Astryx · **ยอมรับว่าไม่เหมือน hi-fi ทุกพิกเซล** · ห้าม copy `.btn` / `.chip` เข้ามา |
| **C5** | Waitlist offer (#61) | ถือที่ว่างไว้ 15 นาที แล้วค่อยส่งต่อ | CLAUDE.md §2.2 (authoritative): `waitlist → confirmed` ผ่าน `promote_waitlist()` เท่านั้น · "เต็ม" derive จาก count · มีเทสต์ concurrency คุมอยู่ | ★ แยกเป็น ADR ใหญ่ของมันเอง ทำหลัง Track A · หรือ (ข) ไม่ทำ |
| **C6** | Custom roles (#65) · ความชอบในการจับคู่ (#64) | ต้องการ | baseline ใส่ทั้งสองเรื่องไว้ในตาราง "ไม่รับ" พร้อมเงื่อนไขว่า "ทบทวนเมื่อมีก๊วนต้องการจริง" | ★ เลื่อนไว้จนกว่าก๊วนจริงจะขอ · UI ของ #65 ใช้ได้กับ role 3 ระดับเดิม (ดูอย่างเดียว) |
| **C7** | หารค่าลูก (#14b) | 3 policy (`equal_all` เป็นค่าเริ่มต้น / `per_game` / `equal_players_only`) | ADR-005 ตรึงสูตรไว้แล้ว และก๊วนจริงใช้ `flat_rate` (ไม่มีค่าลูก) | ★ ทำเป็น ADR-0xx แบบ additive ใน snapshot (ไม่ขึ้น version) · ไม่ด่วน เพราะก๊วนจริงยังไม่ใช้ |
| **C8** | เครดิต (#57, #52b) | ตาราง `credit_ledger` ใหม่ + `apply_credit()` | มี `payment_adjustments(kind=credit)` ระดับ charge แล้ว · กติกาเดิมคือ "ค้างเก็บกับต้องคืนไม่หักกลบกัน" | ★ ADR ใหม่ที่ต่อยอดจาก ledger เดิม · ต้องเคาะกติกาหักกลบใหม่ก่อน |
| **C9** | Push (#54) | permission + toggle รายประเภท | ไม่มี web push · มีช่องทาง LINE อยู่แล้ว | ★ หน้า #54 ทำเป็น "ตั้งค่าการแจ้งเตือน" (in-app + LINE) ไปก่อน · web push ไว้ BACKLOG |
| **C10** | ลาก-วาง (#25, #47) | drag & drop | D-19 ทำเป็นแตะเลือกแล้วแตะสลับ (mobile-first) | ★ คง D-19 ไว้ |
| **C11** | ฟอนต์ | Segoe UI + Noto Sans Thai โหลดจาก Google Fonts | Segoe UI มีแค่บน Windows · CSP ปัจจุบันไม่อนุญาต font จากภายนอก | ★ `next/font/google` (self-host) สำหรับ Noto Sans Thai **ไม่ต้องแก้ CSP** · Segoe UI ใช้เป็นตัวแรกใน stack |
| **C12** | ลืมรหัสผ่าน (#04) | มี | ไม่มี SMTP | ★ Resend หรือ Brevo (ต้องใช้บัญชีของเจ้าของงาน) |

### 3.1 คำตัดสินของเจ้าของงาน

| # | ตัดสินว่า |
|---|---|
| C2 | ✅ **ใช้ Tokens v4** เป็น source of truth · **ชื่อในแอปยังเป็น "Gang Badminton"** (ยังไม่เปลี่ยนเป็น BadGame) |
| C3 | ✅ **ยังเปลี่ยนตาม OS (`mode="system"`)** ⇒ ต้อง**ออกแบบ dark tokens เพิ่ม** ซึ่ง v4 ไม่มี — อยู่ใน WO-6.0 |
| Track A | ✅ อนุมัติ เริ่ม WO-6.0 ทันที |
| Track B | ให้ planner แนะนำ ⇒ **B1 + B2 ก่อน** |
| C12 / B1 | ✅ **ไม่ทำ SMTP — ใช้ LINE Login เป็นทางเข้าหลัก** (26 ต.ค.) |
| C6 / C9 | ✅ **เอา #64 #65 #54 กลับเข้าแผน** เป็น B13–B15 (ต้องมี ADR ทุกข้อเพราะกลับคำ baseline) |
| ทีม | ✅ ย้าย backend/frontend/integrations → `claude-sonnet-5-5`, docs → `claude-haiku-5-5` (OpenRouter หมดวงเงิน) |
| WO-6.0 | ✅ ทำต่อจากงานค้าง · เจ้าของงาน OK ธีม/โหมดมืดล่วงหน้า (ยังต้องเก็บ screenshot ไว้) |
| ข้อมูล prod | ✅ ลบ guest "Ford" 3 แถวได้ (ผ่าน `cancel_registration()` — `docs/ops/2026-10-26-cancel-test-guests.sql`) · PromptPay ID ให้แอดมินก๊วนกรอกเองในหน้าตั้งค่า |
| B5 / B11 | ⏳ รอเจ้าของงานตัดสินหลังอธิบายตัวอย่าง |
| C1, C4–C11 | ยังไม่ได้ถาม ⇒ ใช้ ★ ไปก่อนเฉพาะข้อที่กระทบ Track A (C4, C10, C11) · ข้อที่เหลือถามตอนเปิด ADR ของเรื่องนั้น |

---

## 4. Track A — reskin ตาม hi-fi (ไม่มี migration · ทำได้ทันที)

ลำดับเรียงตาม **จุดที่ผู้ใช้จริงสะดุดอยู่** ก่อน แล้วค่อยไล่ตามความถี่ใช้งาน ·
ทุกใบเป็นของ @gb-frontend ยกเว้นที่ระบุ · ส่ง @gb-qa ตรวจทุกใบ · @gb-docs บันทึก STATE

| WO | งาน | หน้า | พึ่ง |
|---|---|---|---|
| **6.0** | Design foundation — theme `badgame` (tokens v4 → Astryx) + ฟอนต์ + ล็อก light + กติกาลง CLAUDE.md | — | — |
| **6.1** | App shell — tab bar มือถือ (นัด/ยอดเงิน/อันดับ/ฉัน) · sidebar แอดมิน · สลับก๊วน · global states · ErrorCode → ข้อความไทย | 59, g1–g4 | 6.0 |
| **6.2** | เส้นหลักของสมาชิก — ลิสต์นัด · รายละเอียด + ลงชื่อ (**แยก "ตัวเอง" กับ "guest" ให้ชัด**) · รายชื่อ/waitlist · guest | 17, 19, 20, 21, 22, K17, K19a–c | 6.1 |
| **6.3** | จ่ายเงินฝั่งสมาชิก — ยอดของฉัน · PromptPay QR · อัปสลิป | 29, 30, 31, K30, K31 | 6.1 |
| **6.4** | วันเล่น — เช็คอิน · live board navy · จัดคู่ · นับลูก · เวลาพัก · ปิดรอบ | 23–28, K28 | 6.1 |
| **6.5** | แอดมิน — Dashboard (R+) · ยืนยันสลิป · ค้างจ่าย · จ่ายแทน/คืนเงิน | 10, 32, 33, 34, K32 | 6.1 · @gb-backend ทำ query รวมของ #10 |
| **6.6** | ตั้งค่าก๊วน — สมาชิก · โปรไฟล์สมาชิก · skill · pricing · policy · flags · สร้าง/แก้นัด · นัดประจำ | 11–16, 18, 52, 53, 53b | 6.1 |
| **6.7** | Auth + onboarding — welcome · สมัคร (แก้ label "ชื่อที่ใช้แสดง") · เข้าระบบ · wizard · onboarding checklist | 01–03, 05–09, 51 | 6.1 |
| **6.8** | Growth — แจ้งเตือน · ประกาศ · รายงาน · อันดับการมีส่วนร่วม · timeline · สถิติ · หาก๊วน · LINE · รายเดือน · หน้าแรก (static) | 35–38, 39a, 40–42, 44–46, 63 | 6.1 |
| **6.9** | Checkpoint — Playwright smoke ไล่ journey ตามธีมใหม่ (ปิดช่องที่ค้างตั้งแต่ WO-5.E ด้วย) · tag `v1.1.0` | — | 6.2–6.8 |

> 6.2 → 6.4 → 6.3 คือเส้นเงินที่ก๊วนเรนนี่ต้องใช้จริง ⇒ ถ้าต้องตัดงาน ให้ตัด 6.8 ก่อน

## 5. Track B — ความสามารถใหม่ (รอตัดสิน · 1 เรื่อง = 1 ADR + WO ของ @gb-backend)

| ลำดับแนะนำ | เรื่อง | หน้า | ขนาด | เหตุผลของลำดับ |
|---|---|---|---|---|
| B1 | **LINE Login เป็นทางเข้าหลัก** (แทน SMTP/ลืมรหัสผ่าน — คำตัดสิน 26 ต.ค.) | 01–04 | M | ต้องมี ADR: ตอนนี้ LINE Login (WO-4.D) เป็น channel ต่อก๊วนใช้ผูกบัญชีเท่านั้น ⇒ ต้องมี channel ระดับแพลตฟอร์ม + ทางเข้า Supabase Auth (OIDC) + คนที่สมัครด้วยอีเมลไว้แล้วผูก LINE เพื่อกู้บัญชี · owner @gb-integrations |
| B2 | ออกจากก๊วน + โอน owner | 55, 55b | S | ฟังก์ชันพื้นฐานที่ยังไม่มี |
| B3 | PDPA consent + export + ลบบัญชี | 56, 56b | M | ต้องมีก่อนเปิด discovery ให้คนนอกใช้วงกว้าง |
| B4 | สรุปผลผ่านไลน์ (คัดลอกข้อความ) | 48 | S | ทำบน domain ล้วน ต้นทุนต่ำ |
| B5 | เครดิต + ยกเลิกนัดแล้วคืนเป็นเครดิต | 57, 52b | M | C8 — แตะเงิน ต้องเคาะกติกาก่อน |
| B6 | คอร์ทเป็น entity + ตารางสนาม | 49, 47 | M | expand → migrate → contract |
| B7 | หารค่าลูก 3 policy | 14b | S–M | C7 |
| B8 | คิวของฉัน + ขอพัก | 58 | S | input ใหม่ของ matching |
| B9 | สต็อกลูก | 60 | S | |
| B10 | ผลเกม + Elo + ตั้งค่า ranking | 62, 39b, 50 | L | 2 ADR พึ่งกัน |
| B11 | Waitlist offer | 61 | L | C5 — แตะ state machine |
| B12 | ช่วยเหลือ + feedback | 66 | S | |
| B13 | บทบาทกำหนดเอง (เหรัญญิก/ผู้จัดคิว) | 65 | L | **กลับเข้าแผนตามคำตัดสิน 26 ต.ค.** · baseline เคย "ไม่รับ" RBAC ⇒ ต้องมี ADR กลับคำ · `can()` รวมศูนย์ไว้แล้ว ⇒ หน้าจอไม่ต้องแก้ · RLS ต้องสลับ expand→contract |
| B14 | ความชอบในการจับคู่ (คู่ประจำ/ไม่ขอจับคู่) | 64 | M | กลับเข้าแผน · baseline "ไม่รับ" Constraint stage ⇒ ADR · pipeline เสียบ stage ได้อยู่แล้ว ต้นทุนอยู่ที่ data model |
| B15 | Web push | 54 | M | กลับเข้าแผน · ต้องมี service worker + ตาราง subscription + ช่อง `push` ในคิว (คีย์ `<เดิม>:push` แบบเดียวกับ line) · CSP ต้องเปิด `worker-src` |

---

## 6. WO-6.0 (รายละเอียดเต็ม — ใบแรกที่จะเริ่ม)

**Goal**: ทั้งแอปใช้ภาษาภาพของ tokens v4 ผ่าน Astryx theme ที่ build แล้ว โดยไม่มีหน้าไหนพังและไม่มี CSS ที่หลุดกติกา

**Scope**:
- `theme/badgame.ts` ใช้ `defineTheme({ extends: neutralTheme, ... })` map token v4 → token ของ Astryx
  (accent = `#0169CC` · พื้นผิว/ข้อความ/เส้นจาก neutral ของ v4 · radius: input 6 / card 16 / ปุ่ม pill ·
  เงา stroke · `--color-success` `--color-warning`(orange) `--color-error` · navy เป็น custom token สำหรับ live board)
- `astryx theme build` → `theme/badgame.{css,js,d.ts}` commit ผลลัพธ์ · เพิ่ม script `npm run theme:build`
- `globals.css`: แทน `@astryxdesign/theme-neutral/theme.css` ด้วย `badgame.css` **ใน layer `astryx-theme`** (ลำดับ layer เดิมห้ามเปลี่ยน)
- `app/providers.tsx`: `Theme theme={badgameTheme} mode="system"` (คงตาม OS — คำตัดสิน C3)
- **Dark tokens** (v4 ไม่มี ต้องออกแบบเพิ่ม) — ทุก token สีใน theme ต้องเป็นคู่ `[light, dark]` โดยใช้กติกาตั้งต้นดังนี้
  (เปลี่ยนได้ถ้าเจ้าของงานดู screenshot แล้วไม่ชอบ):
  พื้นหน้า `navy-950 #061525` · การ์ด/input `navy-900 #0A1E33` · พื้นยก `navy-800 #0F2944` · เส้น `navy-700 #173554` ·
  ข้อความหลัก `#F2F5F9` · ข้อความรอง `#AFC0D6` (ต้องผ่าน 4.5:1 บนการ์ด) · primary `#3B8AD6` (primary-400 เพื่อให้ contrast ผ่าน) ·
  orange/success/error ใช้เฉด 400 · live board (#24) ใช้ navy เหมือนกันทั้งสองโหมด
  ⇒ จดชุดนี้ลง `docs/design/tokens-dark.md` พร้อมตาราง contrast ที่วัดจริง
- ฟอนต์: Noto Sans Thai ผ่าน `next/font/google` (self-host) · stack `'Segoe UI', var(--font-noto-thai), system-ui` · `font-variant-numeric: tabular-nums` ที่ body
- **ไม่เปลี่ยนชื่อแบรนด์** — ยังเป็น "Gang Badminton" (คำตัดสิน C2)
- CLAUDE.md §1.3: เปลี่ยนคำว่า theme-neutral เป็น badgame + เพิ่มกฎการใช้ของ tokens v4 (§1 ของไฟล์นี้)

**ไม่แตะ**: layout หรือโครงของหน้าใดๆ (งานของ 6.1+) · migration · server actions

**Definition of Done**:
1. `npm run typecheck` · `npm run lint` · `npm run test:unit` · `npm run build` ผ่าน (แนบผลรันจริง)
2. เทสต์ใหม่ `tests/design/theme-tokens.test.ts`: ค่า token หลักใน `badgame.css` ตรงกับ spec v4 (primary, text, text-muted, surface, card, border-input, radius-card, radius-input) **และ**ทุกคู่ข้อความ/พื้นทั้ง light และ dark ผ่าน contrast 4.5:1 (คำนวณในเทสต์ ไม่ใช่ดูด้วยตา)
3. `tests/security/csp.test.ts` ยังเขียว (ฟอนต์ self-host ต้องไม่ต้องแก้ CSP) และ `STATIC_ROUTES` ไม่เปลี่ยน
4. `npm run astryx -- doctor` ผ่าน
5. Playwright smoke เดิมผ่าน + screenshot 4 หน้า (`/`, `/sign-in`, `/gangs`, หน้านัด) × light/dark (`colorScheme` ของ Playwright) ก่อน/หลัง เก็บไว้ที่ `docs/design/wo-6.0/` ให้เจ้าของงานดู
6. grep ต้องไม่เจอ hex ดิบหรือ `style={{` ที่เพิ่มขึ้นใน `app/` `features/` `components/`

**Forbidden**: copy `hifi/tokens.css` หรือ class `.btn` / `.chip` เข้า repo · override `--color-*` ใน `:root` ตรงๆ ·
ใช้ `defineTheme()` แบบ runtime ใน production · เปลี่ยน `mode` เป็น `light` · `@import` ที่ไม่ระบุ layer · โหลดฟอนต์จาก `fonts.googleapis.com` ตอน runtime ·
อัปเวอร์ชัน Astryx

**References**: CLAUDE.md §1, §1.1, §1.3 · `npm run astryx -- docs theme` · `../design/Design tokens.html` · `../design/hifi/tokens.css`

---

## 7. ของที่ต้องเตรียมก่อนเริ่ม

- [x] checkout `claude/badminton-group-system-4pfs7o` + `npm ci` (node_modules หายหลัง clone ใหม่)
- [ ] ⚠️ `npm ci` ของ npm รุ่นนี้ **บล็อก install scripts** (`esbuild`, `unrs-resolver`, `@astryxdesign/core` postinstall)
      ⇒ ต้องตรวจว่า build/test ยังทำงาน ถ้าไม่ได้ให้ใช้ `npm install-scripts approve <pkg>` (งานแรกของ 6.0)
- [ ] Docker + `supabase start -x ...` สำหรับเทสต์ที่ต้องมี DB (Track A ใช้แค่ unit + build + Playwright)
- [ ] ให้ทีมเข้าถึง `../design/` ได้ (อยู่นอก repo) — ★ แนะนำ copy `Hi-fi.html` + `hifi/` + tokens เข้า `docs/design/` แบบอ่านอย่างเดียว เพื่อให้ PR อ้างอิงได้

---

## 8. ข้อสรุปจากการเทียบ baseline กับ design (26 ต.ค. 2026)

1. **design เป็นชั้น UI ที่ครอบ baseline ไม่ได้มาแทน** — ทุกเรื่องสำคัญยังตรงกัน: auth แบบ email/password + magic link · state machine เดิม · snapshot · billing ทำใน domain · ใช้ PromptPay ต่อคน · LINE เป็น optional ⇒ baseline + ADR-001…009 ยังเป็น source of truth
2. **tag phase ใน Screen Inventory (MVP-0/2.5/3) ใช้ไม่ได้แล้ว** เพราะ phase เหล่านั้นจบไปแล้ว ⇒ เรียงงานใหม่ตาม Track A/B ของไฟล์นี้ · หน้าที่ design ติด tag "MVP-0" แต่ baseline ไม่เคยมี (PDPA, เครดิต, push, ออกจากก๊วน) = **scope ที่เพิ่มขึ้นใหม่**
3. **ADR ใน design เทียบกับของจริง**:
   | design | ของจริงในโค้ด | ข้อสรุป |
   |---|---|---|
   | 002 courts | `court_count` + `court_labels` + `games.court_no` | ทำแบบ additive ได้ (expand→contract) · ไม่ด่วน |
   | 003 ranking | ไม่มีผลเกม · ADR-003 ของจริง = กติกาจับทีม | ต่อยอดได้ ต้องใช้ `teamsOf()` เพื่อรู้ว่าใครอยู่ฝั่งไหน |
   | 004 หารค่าลูก | ADR-005: ค่าลูกรวม ÷ ผู้จ่าย = **`equal_all` อยู่แล้ว** | ค่า default ของ design ตรงกับพฤติกรรมปัจจุบัน ⇒ เพิ่มอีก 2 policy แบบ additive โดยนัดเก่าไม่เปลี่ยน |
   | 005 credit_ledger | `payment_adjustments` (credit ระดับ charge) + กติกาไม่หักกลบ | ขัดกับกติกาเดิม ⇒ ต้องตัดสินว่าเปลี่ยนกติกาไหม |
   | 006 waitlist offer | `promote_waitlist()` เป็นทางเดียว · ที่ว่าง = confirmed + checked_in (D-10) | แตะส่วนที่ baseline ถือเป็นหลักสูงสุด ⇒ ทำท้ายสุดหรือไม่ทำ |
   | 007 game results | — | ทำคู่กับ 003 |
   | 008 custom roles | baseline "ไม่รับ" · `can()` รวมศูนย์อยู่แล้ว | เลื่อนไว้ · สลับเป็นตารางได้ภายหลังโดยไม่ต้องแก้หน้าจอ |
4. **ความเสี่ยงทางเทคนิคของ Track A อยู่ที่ WO-6.0 ใบเดียว** (theme / layer / font / dark) ⇒ ห้ามเริ่ม 6.1 จนกว่า 6.0 จะผ่าน QA และเจ้าของงานดู screenshot ทั้งสองโหมดแล้ว
5. รีวิวงานระหว่างทำของ WO-6.0 เจอ 5 จุด (สะกดชื่อ layer ผิด · ใช้ `@next/font` ที่เลิกใช้แล้ว · import theme ตัว runtime · warning/text-muted ไม่ตรง v4 · font stack) — ส่งให้ @gb-frontend แก้แล้ว

---

## 9. คำตัดสิน B5 / B11 (26 ต.ค. 2026) + ร่าง ADR

### ADR-010 (ร่าง) — เครดิตสมาชิก (B5 · #57 · #52b · #34) — ✅ เจ้าของงาน: **เอา**
- `credit_ledger` append-only ต่อ (gang, user) · ยอดคงเหลือ derive จาก Σ (cache ได้แต่ต้อง recompute ได้) · CHECK ≥ 0 · guest ไม่มีเครดิต
- เข้า: โอนเกิน (แอดมินยืนยัน) · ยกเลิกนัดที่จ่ายแล้ว · แอดมินเติมมือ (ต้องมีเหตุผล) · ออก: ใช้จ่ายหนี้ · แอดมินจ่ายคืนเป็นเงินสด
- ใช้เครดิตผ่าน DB function เดียว (`apply_credit`, `FOR UPDATE` แถวยอด) → เขียน `payment_allocations` ที่ `source = 'credit'` ⇒ ledger เดิมยังเป็นแหล่งความจริงของยอดค้าง
- 🔴 เปลี่ยนกติกาเดิม "ค้างเก็บกับต้องคืนไม่หักกลบกัน" ⇒ หักกลบได้**ผ่านเครดิตเท่านั้น**
- รายงาน: เครดิตไม่ใช่เงินสด ⇒ "เก็บได้จริง" ไม่รวมส่วนที่จ่ายด้วยเครดิต · ยอดเครดิตคงค้างแสดงเป็น "เงินที่ก๊วนติดสมาชิก"
- ✅ **หักอัตโนมัติ** เมื่อมีหนี้ใหม่ (เจ้าของงานตัดสิน 26 ต.ค.)

### ADR-011 (ร่าง) — สละสิทธิ์หลังถูกเลื่อนคิว + แอดมินเลื่อน/เปลี่ยนคนเอง (B11 แบบ ค) — ✅ เจ้าของงาน: **ค, N = 3 ชม. + แอดมินจัดการเองได้**
- ไม่มี state ใหม่ ไม่มี offer ⇒ การเลื่อนยังผ่าน `promote_waitlist()` ทางเดียว (CLAUDE.md §2.2 ไม่เปลี่ยน)
- `cancellation_policy.promoted_grace_hours` (ค่าเริ่ม **3**) — additive ใน snapshot (ไม่ขึ้น version แนวเดียวกับ ADR-004) · นัดเก่าที่ไม่มีคีย์ = 0 (พฤติกรรมเดิม)
- คนที่ถูกเลื่อนจาก waitlist แล้วยกเลิกภายใน N ชม. นับจากเวลาที่ถูกเลื่อน (แต่ไม่เกินเวลาเริ่มนัด) ⇒ **ไม่นับเป็น late cancel · ไม่มีค่าปรับ · ไม่กระทบ reliability** · ตัดสินใน `cancel_registration()` แล้วบันทึกลง event
- แอดมิน**เลื่อนคนที่เลือกเอง** (ข้ามลำดับคิว) = เพิ่มพารามิเตอร์ `p_registration_id` ให้ `promote_waitlist()` (ยังเป็นฟังก์ชันเดียว · ตรวจสิทธิ์ `registration.promote.other` ผ่าน `can()` · event `promoted_by_admin`)
- แอดมิน**เปลี่ยนคน** = ยกเลิก A แทน (มีตัวเลือก "ไม่คิดค่าปรับ" + เหตุผล) แล้วเลื่อน B ⇒ ใช้ transition ที่มีอยู่แล้วทั้งหมด ❌ ไม่เพิ่ม `confirmed → waitlist`
- ✅ "เปลี่ยนคน" = **ยกเลิก A ไปเลย** ใช้ transition เดิม (เจ้าของงานตัดสิน 26 ต.ค.) ⇒ state machine ไม่เปลี่ยน

### 8a ปุ่มสีส้ม — ✅ ก. ตัวหนังสือเข้ม (`--color-on-warning`) บนส้ม · ห้ามตัวหนังสือขาว (2.70)

---

## 10. WO-6.0 ✅ ผ่าน QA (`315a507`, 26 ต.ค. 2026) → แตก WO-6.1 เป็น 2 ใบ

ของจริงที่ตรวจก่อนแตกใบ: repo **มี `app/layout.tsx` ไฟล์เดียว** — ไม่มี layout ซ้อน, `error.tsx`, `not-found.tsx`,
`loading.tsx` เลย · `features/` แสดง `error.message` จาก server ตรงๆ ราว 31 จุด · `docs/errors.md` มี 32 code
⇒ 6.1 เดิมใหญ่เกินหนึ่งใบ จึงแยกเป็น **6.1a (โครงแอป)** กับ **6.1b (states กลาง + ข้อความ error ไทย)** ทำต่อกันตามลำดับ

ข้อสังเกตจาก QA ของ 6.0 ที่รับเข้าใบถัดไป: **A** (`data-astryx-theme` บน `<html>` กันแฟลช) → 6.1a ·
**B** (สี ProgressBar ที่ติดมาจาก neutral) → ใบแรกที่ใช้ ProgressBar · **C** (ช่องล้นการ์ด / datetime-local / primary 3 ปุ่ม ในหน้านัด) → 6.6

### WO-6.1a: App shell — โครงหน้าสมาชิก/แอดมิน + สลับก๊วน
**Goal**: ทุกหน้าใต้ `/gangs/[gangId]/*` อยู่ในโครงเดียวกันตาม hi-fi — มือถือมี tab bar ล่าง, เดสก์ท็อปมี sidebar — และสลับก๊วนได้จาก header
**Scope**:
- `app/gangs/[gangId]/layout.tsx` (server) อ่าน membership + role ครั้งเดียว แล้วส่งให้ shell (client) — ตรวจสิทธิ์เมนูด้วย `can()` เท่านั้น
- **มือถือ** (< `md`): header (ชื่อก๊วน = ปุ่มเปิด #59) + tab bar ล่าง 4 ช่อง ตาม hi-fi #17: **นัด** → `sessions` · **ยอดเงิน** → `payments` · **อันดับ** → `stats` (ซ่อนถ้า flag `statistics` ปิด) · **ฉัน** → `/profile`
- **เดสก์ท็อป** (≥ `md`): Astryx `AppShell` + `SideNav` สำหรับแอดมิน (เมนูตาม hi-fi #10: แดชบอร์ด*, นัด, สมาชิก, เก็บเงิน, รายงาน, ประกาศ, ตั้งค่า, LINE) · สมาชิกทั่วไปเห็นเฉพาะเมนูที่ `can()` อนุญาต
  *แดชบอร์ด = ลิงก์ไป `sessions` ไปก่อน (หน้า #10 เป็นงาน 6.5)
- **#59 สลับก๊วน**: sheet/dialog จากชื่อก๊วน แสดงรายชื่อก๊วนของผู้ใช้ (query เดิมของ `/gangs`) — ยอดค้างต่อก๊วนไม่ต้องทำในใบนี้
- เมนูที่ใช้งานอยู่ (active) อ่านจาก pathname · tap target ≥ 44px · มี `aria-current`
- ข้อสังเกต A: ใส่ `data-astryx-theme` ให้ `<html>` ตั้งแต่ SSR (ตรวจชื่อ attribute/ค่าที่ Theme ตั้งจริงจาก `node_modules/@astryxdesign/core` ก่อน)
- **ไม่แตะเนื้อหาของแต่ละหน้า** นอกจากถอด header/nav เดิมที่ซ้ำกับ shell
**DoD**:
1. typecheck · lint · test:unit · build ผ่าน · หน้า static (`/`, `/sign-up`) ยัง static · `STATIC_ROUTES` ไม่เปลี่ยน
2. เทสต์ใหม่ (unit, pure): ฟังก์ชันสร้างรายการเมนูจาก role + features ⇒ member/admin/owner × flag `statistics` เปิด/ปิด ได้เมนูตรงตาม `can()` (ห้าม hardcode `role === 'admin'`)
3. Playwright: (ก) viewport 390×844 เห็น tab bar 4 ช่อง กดแต่ละช่องไปถูก route · (ข) 1280×800 แอดมินเห็น sidebar · (ค) สลับก๊วนไปอีกก๊วนได้ · smoke เดิมผ่าน
4. screenshot หน้า sessions ของก๊วน × มือถือ/เดสก์ท็อป × light/dark → `docs/design/wo-6.1a/`
5. grep: ไม่มี hex ดิบ / `style={{` / `<div>` ทำ layout ที่เพิ่มขึ้น (ใช้ Astryx layout ก่อน Tailwind ตาม §1)
**Forbidden**: hardcode role · ซ่อนเมนูอย่างเดียวแล้วถือว่าเป็นการกันสิทธิ์ (หน้าเดิมต้องตรวจสิทธิ์ฝั่ง server เหมือนเดิม) · `force-dynamic`/`cookies()` ในหน้าแรก · query ใหม่ที่ข้าม RLS · migration · ทำหน้า #10 Dashboard
**References**: CLAUDE.md §1, §1.3, §3 (`can()`) · hi-fi `H17`, `H10`, `HM59` ใน `../design/hifi/*.jsx` · `npm run astryx -- component AppShell` / `SideNav` / `TabList`

### WO-6.1a ✅ ผ่าน QA (`f042a50` + `0e0588f`, 27 ต.ค. 2026)
deviation ที่อนุมัติ: แท็บ "ยอดเงิน" ผูก `payment.verify` จนกว่า 6.3 · เมนูนอก hi-fi (ตารางประจำ/คำขอเข้าก๊วน/บิลรายเดือน/โปรไฟล์) ·
ขนาด element ทั้งระบบ 32/44/52 ตาม v4 · QA ยืนยัน: คนนอกก๊วนเปิด 11 หน้าได้ 404 ทุกหน้า · ไม่มีแฟลชแล้ว · a11y ผ่าน

### WO-6.1b: global states + ข้อความ error ไทยกลาง + เก็บกวาดจาก QA 6.1a
**Goal**: ผู้ใช้ไม่เห็นข้อความ error ดิบ/ภาษาอังกฤษอีก และทุกสถานะผิดพลาดกลางมีหน้าตาตาม hi-fi K (g1–g4)
**Scope**:
- `shared/` (หรือ `lib/i18n/`) map เดียว `ErrorCode → ข้อความไทย` ครบทุก code ใน `docs/errors.md` · แทน `result.error.message` / `?? 'ทำรายการไม่สำเร็จ'` ทั้ง ~31 จุดใน `features/` ด้วย helper ตัวเดียว
  ⚠️ ถ้ามี code ที่ข้อความต้องพึ่งรายละเอียดจาก server (เช่น validation รายช่อง) → **หยุดถามผม** อย่าตัดสินเอง
- `app/error.tsx` · `app/global-error.tsx` · `app/not-found.tsx` (g4 server error + ปุ่มลองใหม่ · 404) · offline banner (g1, client) ·
  session หมดอายุ (g2 → ไปหน้า sign-in พร้อม `next` ที่ผ่าน safe-next เดิม) · ลิงก์เชิญ/guest หมดอายุ (g3 ใช้กับ `/join/[token]` และ `/guest/*`)
- `lib/i18n/astryx-th.ts`: แปลข้อความของ Astryx ที่ยังเป็นอังกฤษให้ครบ (เช่น "Required" / "Optional" ในฟอร์ม)
- QA 6.1a ข้อ a: ใช้ไอคอน `calendar` / `wrench` ของ Astryx แทนที่วาดเอง (ถ้าไม่เข้าชุด stroke ให้เขียนเหตุผลในคอมเมนต์)
- QA 6.1a ข้อ c (บั๊กเดิมบนมือถือ 390px): **หน้าสมาชิกชื่อสมาชิกหายเพราะถูกบีบจนกว้าง 0** (`MembersPanel` แถวเดียว flex + Selector `w-40`) · ช่อง "วันที่" ในรายงานล้นขอบ ⇒ แก้ให้ซ้อนบรรทัดบนจอแคบ
**DoD**: typecheck/lint/test:unit/build · เทสต์ใหม่: ทุก code ใน `docs/errors.md` มีข้อความไทย และไม่มีข้อความไหนว่าง · grep gate: ไม่มี `error.message` ถูก render ใน `features/` อีก ·
Playwright: 404 ของ route มั่ว · token เชิญหมดอายุ · 390px หน้าสมาชิกเห็นชื่อทุกแถว · screenshot g1–g4 × light/dark ที่ `docs/design/wo-6.1b/`
**Forbidden**: แก้ `docs/errors.md`/เพิ่ม code ใหม่โดยไม่ถามก่อน · log ค่า token · เปลี่ยนการตรวจสิทธิ์ · migration
**ข้อสังเกตจาก QA 6.1a ที่ไม่อยู่ในใบนี้**: b (tap target < 44 ของปุ่ม sm / checkbox) → แก้ในใบที่ reskin หน้านั้น (6.5/6.6) · e (org admin ไม่ได้ shell) → BACKLOG · f (query รายชื่อก๊วนทุกหน้า) → รับได้

## 11. Track B เริ่มคู่ขนาน (27 ต.ค. 2026 — เจ้าของงานสั่ง "ทำเลย")
กติกาที่ใช้กับทุกใบใน Track B: 1 ใบ = 1 ADR (เลข ADR-010+ ต่อท้าย baseline ก่อนเขียนโค้ด) · migration ใหม่ต่อจาก `…000039` · ทุก DB function ที่เปลี่ยน state ต้อง `FOR UPDATE` + ตรวจสิทธิ์ผ่าน `can()`/RLS + GRANT ครบ ·
**ห้าม `supabase db push` ขึ้น cloud** จนกว่า planner ถามเจ้าของงาน · ไม่แตะไฟล์ UI ที่ @gb-frontend กำลังทำ (server action + DB + เทสต์เท่านั้น · หน้าจอทำใน Track A)

### WO-B2 (@gb-backend): ออกจากก๊วน + โอน owner — ADR-012
**ปัญหา**: สมาชิกออกจากก๊วนเองไม่ได้ · owner ส่งต่อก๊วนไม่ได้ (ตอนนี้มีแค่แอดมินเอาคนออก และกันไม่ให้เอา owner คนสุดท้ายออก)
**Scope**: DB function `leave_gang(p_gang_id)` + `transfer_gang_ownership(p_gang_id, p_to_user)` (FOR UPDATE แถว `gang_members` ของก๊วนนั้น) · server action คู่กัน · permission action ใหม่ใน `can()` ถ้าจำเป็น
**ต้องตัดสินใน ADR (ถ้าเกินนี้ให้หยุดถาม planner)**:
- owner คนสุดท้ายออกไม่ได้ ต้องโอนก่อน · โอนให้ได้เฉพาะสมาชิก active ของก๊วนนั้น · owner เดิมกลายเป็น admin
- คนที่มี **ยอดค้างจ่าย** ออกได้ไหม → ★ เสนอ: ออกได้ แต่ ledger/ยอดค้างยังอยู่และแอดมินยังเห็น (ไม่ลบประวัติเงิน) — ถ้าขัดกับ baseline เรื่องเงินให้หยุดถาม
- registration ที่ยัง confirmed/waitlist ในนัดอนาคต → ยกเลิกผ่าน `cancel_registration()` เดิม (ไม่เขียน state ตรง) · นัดที่ปิดรอบแล้วไม่แตะ
- ออกแล้วกลับเข้าใหม่ = ใช้ join request เดิม
**DoD**: typecheck/lint/test:unit · test:db ใหม่: (1) owner คนสุดท้าย leave ไม่ได้ (2) โอนให้คนนอกก๊วนไม่ได้ (3) member ธรรมดาโอนไม่ได้ (4) concurrency: โอน 2 ทางพร้อมกันได้ owner 1 คนเสมอ (5) leave แล้ว registration อนาคตถูกยกเลิกและ waitlist ถูกเลื่อน (6) RLS: ออกแล้วอ่านข้อมูลก๊วนไม่ได้ · `supabase db reset` local ผ่าน

### WO-B11 (@gb-backend · เริ่มหลัง B2 commit): สละสิทธิ์หลังถูกเลื่อนคิว + แอดมินเลื่อนเอง — ADR-011 (ร่างอยู่ §9 แล้ว)
**Scope**: ตาม §9 ทุกข้อ — `cancellation_policy.promoted_grace_hours` (default 3, additive ใน snapshot, นัดเก่า = 0) · `cancel_registration()` ตัดสิน grace แล้วลง event · `promote_waitlist(p_registration_id default null)` ตรวจ `registration.promote.other` · แอดมินยกเลิกแทนพร้อม "ไม่คิดค่าปรับ" + เหตุผล
**ห้าม**: state ใหม่ · transition `confirmed → waitlist` · ทางเลื่อนคิวทางที่สอง
**DoD**: test:db: ยกเลิกภายใน 3 ชม. ไม่มีค่าปรับและไม่กระทบ reliability · เกิน 3 ชม. คิดตามเดิม · grace ไม่เกินเวลาเริ่มนัด · นัดเก่าไม่มีคีย์ = พฤติกรรมเดิม · แอดมินเลื่อนข้ามคิวได้ / member ทำไม่ได้ · concurrency: เลื่อนพร้อมกับมีคนยกเลิกไม่เกิน capacity · billing ของนัดที่มีคนสละสิทธิ์ถูกต้อง

### WO-B1-ADR (@gb-integrations · เอกสารเท่านั้น ยังไม่เขียนโค้ด): LINE Login เป็นทางเข้าหลัก — ADR-013 (ร่าง)
**ต้องตอบในร่าง**: channel ระดับแพลตฟอร์ม (ไม่ใช่ channel ต่อก๊วนของ WO-4.D) · ทางเข้า Supabase Auth: OIDC provider ที่ Supabase รองรับ vs custom flow ออก session เอง — เทียบความเสี่ยง · บัญชีอีเมลเดิมผูก LINE เพื่อกู้บัญชี (กันการยึดบัญชีจากการผูกซ้ำ) · ผลกับ LIFF/LINE Login ต่อก๊วนที่มีอยู่ · CSP/redirect URI ที่ต้องเพิ่ม · env/secret ใหม่ · ของที่เจ้าของงานต้องสร้างใน LINE Developers Console (รายการทีละขั้น)
**DoD**: ไฟล์ `docs/adr/ADR-013-line-login-primary.md` (ร่าง) + คำถามที่ต้องให้เจ้าของงานตัดสินในรูป `แผนบอก X / ของจริงคือ Y / ทางเลือกคือ Z` ★ · อ้างของจริงในโค้ด (path:line) ไม่เดา

### 11.1 คำตัดสินเจ้าของงาน 27 ต.ค. 2026 — "ยังไม่มีผู้ใช้จริง ทำต่อได้เลยจนขึ้น UAT"
- **ADR-013 (B1 LINE Login)**: รับตาม ★ ทั้งหมด — Q1 Custom OIDC ของ Supabase · Q2 provider/channel แพลตฟอร์มแยก (ผูก OA ต่อก๊วนคงเดิม) · Q3 ไม่ขอ email scope + `email_optional` + ผูกด้วย `linkIdentity` ตอนล็อกอินอยู่เท่านั้น · Q5 อีเมล+รหัสผ่านเป็นทางสำรอง · Q9 ทางเชิญเข้าก๊วนสำหรับคนไม่มีอีเมล = WO แยก
  · Q4 ง่ายลง: ยังไม่มีผู้ใช้จริง ⇒ ไม่ต้องทำ cutover/แบนเนอร์ (เจ้าของงานผูก LINE กับบัญชีตัวเองตอน UAT) · Q6: ทดลองบนโปรเจกต์ cloud เดิม (`emmzeriekkjryhucvctx`) ได้ เพราะยังไม่ใช้งานจริง · Q7/Q8 planner ตัดสินตาม ★
- **ขอบเขตอำนาจจนถึง UAT**: planner รับ/ตัดสินแทนเจ้าของงานได้ ทั้งคำตัดสินตาม ★ และ `supabase db push` ขึ้น cloud หลัง QA ผ่าน · **ยังต้องถามเจ้าของงาน**: merge เข้า `main` / deploy production · ของที่ต้องใช้บัญชีเจ้าของงาน (LINE Developers Console, Supabase Dashboard) · การตัดสินที่แตะเงินซึ่งไม่มี ★ ชัด
- ข้อมูลทดสอบบน prod (guest "Ford") ⇒ ไม่เร่ง · ล้างพร้อมกันตอนเตรียม UAT

### 11.2 WO-B2 ✅ ผ่าน QA (`71c308b`) → WO-B2.1 (race ที่ QA เจอจากการอ่านโค้ด)
**ปัญหา**: `register_to_session()` ไม่ตรวจว่ายังเป็นสมาชิกใน DB (ตรวจแค่ role ใน TS ก่อน RPC) และ lock แค่แถว session ⇒ TS ตรวจผ่าน → `leave_gang` commit ก่อน → RPC insert ⇒ คนที่ออกแล้วยังถือที่ confirmed/waitlist (และมองไม่เห็นใบนั้นอีก) · เหมือนกันกับแอดมินลงชื่อให้ (`registration.create.other`)
**Scope**: `register_to_session` (และทางลงชื่อแทน) lock แถว `gang_members` ของผู้ลงชื่อด้วย `FOR SHARE` **ก่อน** lock แถว session (ลำดับ members → session เดียวกับ `leave_gang` → `cancel_registration` กัน deadlock) แล้วตรวจว่ายัง active · migration ใหม่ (CREATE OR REPLACE) ไม่แก้ไฟล์เก่า · guest flow ไม่กระทบ
**DoD**: เทสต์ concurrency ใน `tests/gangs/leave-transfer-gang.test.ts`: register แข่ง leave 40 รอบ ⇒ ถ้าสมาชิกถูก soft-delete ต้องไม่มีใบ confirmed/waitlist เหลือ · ไม่มี deadlock · ต้อง**ล้มบนโค้ดเดิม**อย่างน้อยบางรอบ (พิสูจน์ว่าเทสต์จับได้) · เทสต์ register/waitlist เดิมผ่านทั้งหมด
**อื่นๆ จาก QA B2**: UI ปุ่มออกจากก๊วนต้องแสดงเหตุผลเมื่อออกไม่ได้เพราะเลย cutoff (`detail.reason`) + ยอดค้างที่ `leaveGang()` คืน → ใส่ใน WO หน้าจอ (6.5/6.6) · `db push` ขึ้น cloud รวบทีเดียวหลัง B11 + B2.1 ผ่าน QA (โฟลเดอร์ migrations มีไฟล์ 0041 ที่ยังไม่ commit — ห้าม push จากโฟลเดอร์หลักระหว่างมี WIP)

### 11.3 WO-6.1b ✅ ผ่าน QA (`6f7790e` `fee5e90` `c7c45ae` `56832e9` `098fae4` `2c82b89`, 27 ต.ค. 2026)
deviation ที่อนุมัติ: errorText() ทางเลือก A (ข้อยกเว้นคงที่ VALIDATION_ERROR/CONFIRMATION_REQUIRED + ด่านอักษรไทย + ตัด 200) · @gb-frontend แก้ `shared/action.ts` (runAction แปลง redirect ไป /sign-in เป็น UNAUTHENTICATED, redirect/notFound/forbidden/unauthorized อื่น rethrow) ·
hotfix open redirect แยกเป็น `7e90739` → PR #15 เข้า main (QA บนฐาน main ผ่าน · probe 19 แบบ) · QA: unit 518 · Playwright 43/43 · session หมดกลางคัน → /session-expired?next=… ไม่วน

### WO-6.2 (@gb-frontend): เส้นหลักของสมาชิก — ลิสต์นัด · รายละเอียด + ลงชื่อ · รายชื่อ/waitlist · guest
**Goal**: สมาชิกเปิดแอปแล้วเห็นนัดถัดไป ลงชื่อ/ยกเลิกได้ใน 1–2 แตะ และแยก "ลงชื่อตัวเอง" กับ "ลงชื่อ guest" ชัดจนไม่มีใครกดผิด (ต้นเหตุ guest "Ford" 3 แถวบน prod)
**หน้า (hi-fi)**: 17, 19, 20, 21, 22 + states K17, K19a–c · route: `app/gangs/[gangId]/sessions/page.tsx` · `sessions/[sessionId]/page.tsx` · `app/guest/*` · features: `RegistrationActions` · `GuestJoinForm` · `GuestCancelButton` · `RosterSync`
**Scope**:
- ลิสต์นัด: การ์ดนัดถัดไปเด่น (วัน/เวลา/สนาม/จำนวนที่เหลือ/สถานะของฉัน) · นัดที่ผ่านมาย่อ · empty state
- รายละเอียดนัด: ปุ่มหลักเดียวตามสถานะของฉัน (ลงชื่อ / อยู่ waitlist ลำดับที่ N / ยกเลิก) · **guest เป็นปุ่มรองแยกส่วน** ต้องกรอกชื่อ + ยืนยันว่าเป็นคนอื่น · เตือนถ้าชื่อ guest ซ้ำกับคนที่ลงแล้วในนัดเดียวกัน (UI เท่านั้น ไม่บล็อก)
- ก่อนยกเลิกบอกผลให้ชัด: ก่อน/หลัง cutoff · ค่าปรับตาม policy (อ่านค่าที่ server คำนวณอยู่แล้ว ห้ามคิดเงินใน UI) · ถ้าเป็นคนที่ถูกเลื่อนจาก waitlist และยังอยู่ใน grace 3 ชม. ให้บอกว่า "ยกเลิกได้ไม่เสียค่าปรับถึง HH:MM" (ข้อมูลจาก B11: `promoted_at` + `promoted_grace_hours` ใน snapshot — ถ้า query ยังไม่ส่งค่านี้ ให้หยุดถามผม อย่าเพิ่ม query เอง)
- รายชื่อ: confirmed / waitlist (ลำดับ) / guest (บอกว่าใครพามา) · realtime เดิม (`RosterSync`) ต้องยังทำงาน
- หน้า guest (`/guest/*`): reskin + state ลิงก์หมดอายุใช้ StatePanel ของ 6.1b
**DoD**: typecheck/lint/test:unit/build · Playwright: สมาชิกลงชื่อ → ยกเลิก · ลง guest ต้องผ่านขั้นยืนยัน · นัดเต็มได้ waitlist ลำดับถูก · 390px ไม่มี horizontal scroll · screenshot 17/19/20/21/22 × light/dark ที่ `docs/design/wo-6.2/` · ไม่มี role === / ไม่มีการคิดเงินใน UI (grep gate)
**Forbidden**: migration · แก้ DB function / state machine / `domain/billing` · เปลี่ยนการตรวจสิทธิ์ · query ใหม่ที่ไม่ผ่าน server action/RLS เดิม · ปุ่มแอดมินเลื่อนคิว/เปลี่ยนคน (ของ B11 อยู่ใน 6.6)

### 11.4 WO-6.2 ✅ ผ่าน QA (`69533df` `56798cc` `cef63c0`, 28 ต.ค. 2026) · Track B ✅ B11 `f6977ed` · B2.1 `f12408f` · B11.1 `45cfa5b` · B1.a+c `217ad60` · hotfix open-redirect merge เข้า main (PR #15 `71d62ed`)
deviation ที่อนุมัติใน 6.2: guest ยังเกิดทางเดียวคือลิงก์ `/join/[token]` (ไม่มี action ให้สมาชิกลง guest เอง) ⇒ หน้า join เตือนเมื่อล็อกอิน + ติ๊กยืนยัน + กันกดซ้ำ · "ชื่อซ้ำ" เป็นป้ายในรายชื่อ · "guest พามาโดยใคร" → BACKLOG (ต้องให้ backend บันทึกผู้สร้างลิงก์)
ข้อสังเกตที่ส่งต่อ: timeline event ดิบ · แถบ "ดูนัดถัดมา" ลอยทับ header ที่ 390 dark → BACKLOG (ตรวจใน 6.4a ถ้าอยู่ใน shell) · TS test ของ `cancelPreview` → BACKLOG

### WO-6.4 แตกเป็น 2 ใบ (console เดิม 326 บรรทัด + scan + close)
| ใบ | หน้า | ของจริงใน repo |
|---|---|---|
| **6.4a** | 23 เช็คอิน · 24 กระดานคิวสด (navy เต็มจอ) · 25 จัดคู่ลงสนาม · 26 เกม + นับลูก · 27 เวลาพักแต่ละคน | `sessions/[sessionId]/console` + `scan` · `features/sessions/GameConsole.tsx` `ScanCheckin.tsx` `CheckinQrButton.tsx` · เวลาพักใช้ `waiting_since` + `games_played` ที่ `ConsoleQueueRow` มีอยู่แล้ว |
| **6.4b** | 28 ปิดรอบ → ตรวจยอด + K28a/b | `sessions/[sessionId]/close` · `features/billing/ConfirmCloseButton.tsx` |

### WO-6.4a (@gb-frontend): วันเล่น — เช็คอิน · กระดานคิวสด · จัดคู่ · เกม + นับลูก · เวลาพัก
**Goal**: แอดมินคุมทั้งวันเล่นจากมือถือมือเดียวได้ — เห็นคิวรอ/คนพักนานสุด/คอร์ทที่ว่างในจอเดียว กดจัดคู่ จบเกม ใส่จำนวนลูก ได้โดยไม่ต้องเลื่อนหา และมีจอ "กระดานคิวสด" สำหรับเปิดค้างบนแท็บเล็ต/ทีวีที่สนาม
**หน้า (hi-fi)**: e23, h24, e25, e26, h27 · route `console/page.tsx`, `scan/page.tsx` + route ใหม่สำหรับ 24 (เช่น `console/board/page.tsx` — อ่านอย่างเดียว ใช้ข้อมูลชุดเดียวกับ console)
**Scope**:
- 23 เช็คอิน: รายชื่อ confirmed + สถานะเช็คอิน · ปุ่มเช็คอิน/no-show/เช็คอินทุกคน (action เดิม) · QR ให้สแกน (`CheckinQrButton`) · หน้า scan reskin
- 24 กระดานคิวสด: ธีม navy เต็มจอ ตัวใหญ่อ่านได้จาก 3 เมตร · คอร์ท → ใครเล่นอยู่ · คิวถัดไป · ไม่มีปุ่มแก้ไข · อัปเดตด้วย realtime/refresh เดิม (`RosterSync` หรือ router.refresh เป็นระยะ — ห้ามเปิด channel ใหม่ที่ข้าม RLS) · สิทธิ์เดียวกับ console (ไม่ใช่ public)
- 25 จัดคู่: ปุ่ม generateGames เดิม · แสดงผลคู่ต่อคอร์ท · เปลี่ยนตัว (`substitutePlayer`) · logic การจัดคู่อยู่ `domain/matching` ห้ามแตะ
- 26 เกม + นับลูก: การ์ดเกมที่กำลังเล่น + ช่องลูกที่ใช้ + จบเกม · แก้จำนวนลูกเกมที่จบแล้วก่อนปิดรอบ (`updateGameShuttles`) · หลังปิดรอบแสดงแบบอ่านอย่างเดียว
- 27 เวลาพัก: คิวรอเรียงตามที่ server ส่ง แสดง "พักมา N นาที" จาก `waiting_since` + "เล่นแล้ว N เกม" · เน้นคนที่พักนานสุด (สี/ป้าย ไม่ใช่สีอย่างเดียว)
- ตรวจแถบ "ดูนัดถัดมา" ลอยทับ header ที่ 390 dark (BACKLOG 6.2) — ถ้าต้นเหตุอยู่ใน shell แก้ในใบนี้
**DoD**: typecheck/lint/test:unit/**build** · **Playwright ทั้งชุดเขียว** + spec ใหม่: เช็คอิน 4 คน → จัดคู่ → จบเกมใส่ลูก 2 → แก้เป็น 3 → กระดาน 24 แสดงคอร์ท/คิวตรงกับ console · member ธรรมดาเปิด console/board ได้ 404/forbidden · 390px ไม่มี horizontal scroll · screenshot 23–27 × light/dark (24 navy) ที่ `docs/design/wo-6.4a/` · grep gate: ไม่มี role ===, ไม่คำนวณเงิน, ไม่ import `domain/matching` ใน component
**Forbidden**: migration · แก้ DB function / state machine เกม / `domain/matching` / `domain/billing` · เปลี่ยน `can()` · query ใหม่นอก server action/RLS เดิม (กระดาน 24 ต้องใช้ loader เดียวกับ console) · หน้า close (เป็นของ 6.4b)

### WO-6.4b (@gb-frontend) + WO-R1 (@gb-backend · เดิมเรียก B12 — ชนกับ Track B ตาราง §5) — ปิดรอบ → ตรวจยอด (h28, K28a)
แผนบอก: H28 = KPI 5 ใบ (ค่าคอร์ท/ค่าลูก/ค่าปรับ/เศษปัด/เก็บรวม) + ตารางต่อคน 4 คอลัมน์ + K28b "ยอดไม่ลงตัว — ยืนยันไม่ได้"
ของจริง: `previewSessionCharges()` คืนแค่ยอดรวมต่อคน + total/roundingSurplus/shuttlesUsedTotal · `calculateSessionCharges()` มี `breakdown` ต่อ charge + courtCost/shuttleCost อยู่แล้วแต่ไม่ส่งออก · DB ไม่มีกติกา "ยอดไม่ลง ห้ามปิด" และตามสูตร roundingSurplus = เก็บรวม − ต้นทุนจริง เสมอ
คำตัดสิน planner:
- **WO-R1 (@gb-backend, R+ ไม่มี migration)**: ขยายผลของ `previewSessionCharges()` ให้ส่ง breakdown ต่อแถว (court/shuttle/penalty/rounding) + `courtCostTotal` `shuttleCostTotal` `penaltyTotal` โดย **map จากผลของ `calculateSessionCharges()` เดิมเท่านั้น** ห้ามสูตรใหม่ · ไม่แตะ close_session / state machine · เทสต์: ผลรวมคอลัมน์ต่อคน = amount ทุกแถว, KPI รวม = total, ตรงกับ charge ที่ปิดรอบจริงเขียนลง DB
- **WO-6.4b (@gb-frontend)**: ทำตาม (ก) ทันที — KPI ที่มีจริง (เก็บรวม/ถูกเก็บ N คน/เช็คอิน/ลูกที่ใช้/เศษปัด) · ตารางต่อคน ชื่อ+ป้ายประเภท+เหตุผล+ยอด · `loading.tsx` = K28a skeleton · preview ล้ม = StatePanel · คงด่าน ConfirmCloseButton เดิม (ไม่มีใครเช็คอิน + warnings + needsConfirmation) · เพิ่มปุ่ม/ลิงก์ "ปิดรอบ" บน **console** (ไม่ใช่กระดาน 24) เห็นเฉพาะ `can(billing.close)` · ออกแบบตารางให้เติมคอลัมน์ breakdown ได้เมื่อ B12 ลง (รอบเล็กตามมา)
- **K28b ยอดไม่ลงตัว**: ไม่ทำ — เป็นกติกาเงินใหม่ (บล็อกการปิดรอบ) → BACKLOG รอเจ้าของงานตัดสินถ้าต้องการ
DoD 6.4b: typecheck/lint/unit/build · Playwright ทั้งชุด + spec: แอดมินจาก console → ปิดรอบ → เห็น KPI/ตาราง → ยืนยัน → session closed · member ธรรมดาเปิด /close ไม่เห็นยอด · ไม่มีการคำนวณเงินใน component (grep gate) · 390px · screenshot h28/K28a light/dark ที่ `docs/design/wo-6.4b/`
Forbidden: migration · แก้ domain/billing / server action billing (เป็นของ B12) / DB function

### 11.5 ที่เหลือ + ลำดับ (28 ต.ค. 2026 · เจ้าของงาน: "เหลืออะไรทำได้เลย")
หมายเหตุชื่อ: WO เล็กที่ planner เปิดระหว่างทาง (breakdown ปิดรอบ / reminders แบ่งหน้า) เปลี่ยนชื่อเป็น **R1 / R2 / R2.1** เพราะ B12/B13 ชนกับตาราง Track B §5 (B12 = ช่วยเหลือ+feedback · B13 = บทบาทกำหนดเอง)
| ลำดับ | งาน | เจ้าของ | หมายเหตุ |
|---|---|---|---|
| 1 | 6.4b ปิดรอบ + fix Table idKey (/close /membership /stats) | @gb-frontend | 🔄 |
| 2 | **B5a เครดิตสมาชิก** — ADR-010 ร่างเต็ม + `credit_ledger` + `apply_credit()` + หักอัตโนมัติเมื่อมีหนี้ใหม่ | @gb-backend | เริ่มทันที (ตัดสินแล้ว 26 ต.ค.) · ADR ก่อนโค้ด |
| 3 | **B15-ADR web push** — เอกสารเท่านั้น | @gb-integrations | เริ่มทันที (กลับเข้าแผน 26 ต.ค.) |
| 4 | 6.3 จ่ายเงินฝั่งสมาชิก (29–31) | @gb-frontend | หลัง 6.4b · แสดงเครดิตเมื่อ B5a ลง |
| 5 | B5b เครดิต: ยกเลิกนัดที่จ่ายแล้ว → เครดิต · แอดมินเติม/จ่ายคืน | @gb-backend | หลัง B5a ผ่าน QA |
| 6 | 6.5 แอดมิน dashboard + เก็บเงิน (10, 32–34) | @gb-frontend (+@gb-backend query #10) | หลัง 6.3 · **ต้องกรอง `payment_allocations.source='transfer'` ในยอด "เก็บได้จริง" (ADR-010)** |
| 7 | 6.6 → 6.7 → 6.8 → 6.9 (`v1.1.0`) | @gb-frontend | ตาม §4 |
| — | B13 บทบาทกำหนดเอง · B14 ความชอบจับคู่ (ADR กลับคำ "ไม่รับ") | @gb-backend | หลัง B5b |
| — | B3 PDPA · B4 · B6–B10 · B12 | — | ยังไม่ตัดสิน → ถามเจ้าของงานก่อนเปิด discovery วงกว้าง |
| 👤 | B1 LINE Login เปิดใช้ | **เจ้าของงาน** | ตั้งค่า LINE Developers + Supabase + `APP_BASE_URL` ตาม `docs/ops/line-login-setup.md` |
กติกาคงเดิม: บอททำงานพร้อมกันไม่เกิน 3 ตัว · ห้าม db reset โดยไม่แจ้ง planner · build + Playwright ทั้งชุดทุกใบ UI

### WO-6.3 (@gb-frontend) + WO-R3 (@gb-integrations) — จ่ายเงินฝั่งสมาชิก (h29, h30, h31 + K30a/b, K31a/b)
ช่องว่างที่ frontend รายงาน (28 ต.ค.) + คำตัดสิน planner:
| # | แผนบอก | ของจริง | ตัดสิน |
|---|---|---|---|
| 1 | H29 "ยอดของฉัน" รวมข้ามนัด + ประวัติ | ไม่มีหน้า · แท็บ "ยอดเงิน" ผูก `payment.verify` ⇒ สมาชิกไม่มีทางเข้า · ไม่มี loader ข้ามนัด | **ทำ** — R3 ทำ loader อ่านอย่างเดียว · แท็บ "ยอดเงิน" ของสมาชิกชี้หน้าใหม่ (ผูก action ที่มีอยู่ `payment.submit.self` · แอดมินยังไป /payments) |
| 2 | รายละเอียด ค่าคอร์ท/ลูก/ปรับ ต่อคน | `session_charges.breakdown` jsonb มี แต่ไม่มี loader ฝั่งสมาชิก | R3 คืน breakdown ต่อ charge ของฉัน **map จากข้อมูลที่เก็บไว้/`breakdownCharges` เดิม ห้ามสูตรใหม่** · component ห้าม import `domain/billing` |
| 3 | หน้าจ่ายรายนัดโชว์ payment ของนัดนั้น | 🐞 pay/page.tsx เลือก payment ล่าสุดของก๊วน (`limit 1`) ไม่ผูกนัด ⇒ อาจโชว์ยอด/QR ของนัดอื่น | **แก้** — R3 คืน payment ที่ผูกกับ charge ของนัดนี้ (ผ่าน `payment_allocations`) · page ใช้ loader นี้ |
| 4 | QR หมดอายุ · ชื่อบัญชีผู้รับ · จ่ายเงินสดที่สนาม · โน้ตถึงแอดมิน · progress % / ยกเลิกอัปโหลด · ไฟล์ 8MB/HEIC | schema/สตอเรจไม่รองรับ (PromptPay QR สถิต · ไม่มีคอลัมน์ · bucket 5MB jpeg/png/webp/pdf) | **ตัดออกจาก 6.3 → BACKLOG** · ข้อความต้องตรงของจริง (5MB, ชนิดไฟล์จริง) |
Scope 6.3 (เริ่มได้ทันทีส่วนที่ไม่พึ่ง R3): reskin pay page เป็น Astryx (grep gate เดียวกับ 6.x) · H30 QR + คัดลอกเลข PromptPay + บันทึกรูป QR (client) · H31 เลือกรูป/ถ่ายรูป (`capture`) + preview + ปุ่มส่ง + ตรวจขนาด ≤5MB/ชนิดไฟล์ฝั่ง client ด้วยข้อความไทยคงที่ + ขั้นสถานะ 3 ขั้นจาก `payment.status` + rejected อัปใหม่ · K30a/b K31a/b ด้วย StatePanel · ช่องเครดิตเป็น block ที่ซ่อนเมื่อไม่มีข้อมูล (รอ B5a) · H29 + การต่อ loader ทำเมื่อ R3 ลง
DoD 6.3: typecheck/lint/unit/build · Playwright ทั้งชุด + spec: สมาชิกจากแท็บ ยอดเงิน → นัดค้าง → ขอ QR → อัปสลิป → แอดมินยืนยัน → สถานะ verified · **มี 2 นัดค้าง หน้าจ่ายนัดเก่าต้องโชว์ยอดของนัดเก่า** · ไฟล์ >5MB ถูกปฏิเสธก่อนอัป · member ไม่เห็นยอดคนอื่น · 390px · screenshot h29/h30/h31 + K30/K31 light/dark ที่ `docs/design/wo-6.3/` · ไม่มีการคิดเงินใน component
Forbidden: migration · แก้ domain/billing / server action payments เดิม (R3 เพิ่มได้) · เปลี่ยน `can()` (ใช้ action ที่มี)

### WO-R4 (@gb-backend · หลัง B5a) — waitlist.promoted + payment.due ส่งถึง LINE (คำตัดสินเจ้าของงาน 28 ต.ค.: ก ★)
- ที่มา: ADR-014 ข้อค้นพบ — 3 เหตุการณ์ insert `in_app` ตรง ไม่ผ่าน `enqueue_notifications()` ⇒ LINE ไม่เคยได้
- ตัดสิน: `waitlist.promoted` + `payment.due` ⇒ in_app + line · `session.opened` ⇒ **in_app เท่านั้น** (โควต้า LINE 200/เดือน)
- ทำ: ให้ฟังก์ชันที่ insert ตรงเรียก `enqueue_notifications()` (เพิ่ม `p_channels` ถ้าจำเป็น เพื่อให้ session.opened ไม่ fan-out ไป line) · dedupe_key เดิม · ไม่เปลี่ยน transition/ผลของ `promote_waitlist()` · ก๊วนที่ไม่ได้ผูก LINE ⇒ ไม่มีแถว line (เหมือนเหตุการณ์อื่น)
- DoD: vitest — promote (ทั้งอัตโนมัติและแอดมินเลือก B11) สร้างแถว in_app + line ครั้งเดียว (dedupe) · payment.due เหมือนกัน · session.opened มีแต่ in_app · ก๊วนไม่ผูก LINE ไม่มีแถว line · concurrency promote/cancel เดิมผ่าน (ไม่มี overbook / 40P01) · ข้อความ LINE ใน line-message.ts ส่งได้จริงจาก worker (mock LINE API) · EXECUTE matrix ไม่เปลี่ยน · ห้าม db reset

### WO-B5b (@gb-backend) — เครดิตส่วนที่ 2 · คำตัดสินเจ้าของงาน 29 ต.ค. 2026 (Q1–Q5 ตาม ★ ทั้งหมด)
| Q | ตัดสิน |
|---|---|
| Q1 เพดานโอนเกิน | **ก** แอดมินกรอก `received_amount` ตอนยืนยันสลิป · overpayment = received − amount คำนวณใน DB · `record_overpayment` ปฏิเสธเกิน (UI ช่องกรอก = งาน 6.5) |
| Q2 เครดิตคืน | **ก** `credit_return_charge` ทีละรายการ (คิดผิด / ยกเลิกทีหลัง / ค่ารายเดือน) · ❌ ไม่เพิ่ม billing→cancelled · ❌ ไม่ทำ pro-rata |
| Q3 เติมเครดิต | **ก** admin + owner · เหตุผลบังคับ + audit · ถือเป็น "ให้เครดิต" ไม่นับเงินสดเข้า |
| Q4 รายงาน | **ก** ตรงบัญชีธนาคาร: โอนเกินนับตอนเงินเข้า (บรรทัด "โอนเกินเข้าเครดิต") · allocation source=credit ไม่นับเป็นเงินสดซ้ำ · `cash_payout` = บรรทัด "เงินคืนสมาชิก" หัก netCash · **อนุญาตแตะ `domain/reports/finance.ts`** (สูตรรายงานเท่านั้น) |
| Q5 ออกจากก๊วน | **ข** leave_gang หักเครดิตกับหนี้ค้างอัตโนมัติก่อนออก (apply_credit) แล้วคืนยอดเครดิตสุทธิ + ยอดค้างสุทธิใน result · แอดมินจ่ายคืนเอง |
ใบย่อย: B5b-1 (N1 seq `cc8a14e` + type ใหม่ + N2/received_amount) → B5b-2 (topup / cash_payout / credit_return_charge + refund cap นับเฉพาะ transfer + finance.ts) → B5b-3 (leave_gang)
