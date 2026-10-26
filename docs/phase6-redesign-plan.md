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

### WO-6.1b (แตกละเอียดหลัง 6.1a ผ่าน): global states g1–g4 + `ErrorCode` → ข้อความไทยกลาง
`app/error.tsx` · `global-error.tsx` · `not-found.tsx` · offline banner · session หมดอายุ · ลิงก์เชิญหมดอายุ · แทน `error.message` ทั้ง ~31 จุดด้วย map เดียวจาก `docs/errors.md` (มีเทสต์ว่าทุก code ในเอกสารมีข้อความ)
