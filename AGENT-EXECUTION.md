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
