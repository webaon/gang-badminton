# ADR-011 — สละสิทธิ์หลังถูกเลื่อนคิว (grace) + แอดมินเลื่อน/เปลี่ยนคนเอง

> สถานะ: **ร่างจาก WO-B11** — เนื้อหาตั้งใจให้ต่อท้าย `gang-badminton-plan-v3.3-FINAL.md` (planner เป็นคนต่อ, คง CRLF)
> ต่อยอดร่างใน `docs/phase6-redesign-plan.md` §9 · เจ้าของงานตัดสินแล้ว: แบบ (ค), N = 3 ชม., แอดมินจัดการเองได้, "เปลี่ยนคน" = ยกเลิกคนเดิม

### ADR-011 — คนที่ถูกเลื่อนจาก waitlist ยกเลิกภายใน grace ไม่นับเป็นยกเลิกช้า · แอดมินเลือกเลื่อนคน/เปลี่ยนคนเองผ่านฟังก์ชันเดิม

- **Context**: คนที่ถูกเลื่อนจาก waitlist ตอนใกล้นัด (เลย cutoff แล้ว) ยกเลิกทีไรโดนนับเป็น "ยกเลิกช้า" (ค่าปรับ full_share + reliability ลด) ทั้งที่เพิ่งรู้ว่าได้ที่ · แอดมินก็เลือกเลื่อนคนเอง / เปลี่ยนคนแบบไม่คิดค่าปรับไม่ได้ · เงื่อนไขของ CLAUDE.md §2.2: `waitlist → confirmed` ผ่าน `promote_waitlist()` เท่านั้น ไม่มี state ใหม่ ไม่มี `confirmed → waitlist`
- **Options**: (ก) ไม่ทำ · (ข) state `offered` + เวลาตอบรับ — ขัด §2.2 และเพิ่ม state · (ค) **ไม่มี state ใหม่**: คนที่ถูกเลื่อนยกเลิกภายใน N ชม. ไม่นับเป็นยกเลิกช้า + แอดมินเลือกเลื่อน/ยกเลิกแทนได้ ← เลือก
- **Decision**: เลือก **(ค)**
  1. `cancellation_policy.promoted_grace_hours` (ค่าเริ่ม **3**, 0–48) — additive ใน snapshot ไม่ขึ้น `snapshot_version` (แนวเดียวกับ ADR-004/005) · **นัดเก่าที่ snapshot ไม่มีคีย์ = 0** (พฤติกรรมเดิม) ตัดสินใน DB · TS `fromJson()` ตอบ default 3 เฉพาะเพื่อให้ snapshot ของนัดที่สร้างหลังจากนี้ได้ค่าเริ่มต้น
  2. `cancel_registration()` ตัดสิน grace: `confirmed` ที่มี `promoted_at` ยกเลิกภายใน `min(promoted_at + grace, starts_at)` และ "มิฉะนั้นจะเป็นยกเลิกช้า" ⇒ บันทึก `cancel_waiver = 'promoted_grace'` · grace ข้ามด่าน `CANCEL_CUTOFF_PASSED` ได้ (ไม่งั้นคนที่เพิ่งถูกเลื่อนในก๊วนที่ห้ามยกเลิกหลัง cutoff สละสิทธิ์ไม่ได้)
  3. `promote_waitlist(..., p_registration_id default null)` — **ยังเป็นฟังก์ชันเดียวที่เปลี่ยน waitlist → confirmed** (DROP ตัวเก่าเพื่อไม่ให้มี overload สองตัว) · ระบุ registration = แอดมินเลือกคนเอง (ข้ามคิว): ตรวจสิทธิ์แอดมินใน DB (`actor_is_gang_admin`) + ต้องมีที่ว่างจริง (ไม่มี = `SESSION_FULL`, ห้ามสลับที่กับคนที่ได้ที่แล้ว) · เขียน `promoted_at` ทุกครั้ง · event `waitlist.promoted` (`by_admin: true`) + `audit.waitlist_promoted_by_admin` (admin-only, บอกว่าข้ามกี่คน)
  4. แอดมินยกเลิกแทนแบบไม่คิดค่าปรับ: `cancel_registration(p_waive_penalty, p_reason)` — actor ต้องเป็นแอดมิน (ตรวจใน DB) + ต้องมีเหตุผล ⇒ `cancel_waiver = 'admin'` · เหตุผลเก็บใน `audit.registration_penalty_waived` (admin-only)
  5. "เปลี่ยนคน" = ยกเลิก A (waive) + เลื่อน B ใน **transaction เดียว** ผ่าน `p_promote_registration_id` — แยกเป็นสองคำสั่งไม่ได้ เพราะ `cancel_registration` ต้อง promote หัวคิวทันที B จะแย่งที่ไม่ทัน (เป็นการส่งเป้าหมายเข้า `promote_waitlist()` ตัวเดิม ไม่ใช่ทางเลื่อนที่สอง) · B ไม่ผ่านเงื่อนไข ⇒ ยกเลิก A ถูก rollback
  6. `can()`: `registration.promote.other` (admin/owner) · server action `promoteRegistration` และตัวเลือกของ `cancelRegistration`
- **Deviation จากร่าง §9**: ร่างบอก "ตัดสินใน `cancel_registration()` แล้วบันทึกลง event" แต่ของจริง**ไม่มีใครอ่าน event ตอนคิดเงิน/ความน่าเชื่อถือ** — `member_reliability()` (SQL) และ `isLateCancel()` (TS billing) ต่างคำนวณจาก `cancelled_at` เทียบ cutoff ใน snapshot ⇒ บันทึกลง event อย่างเดียวจะไม่มีผลกับเงินเลย จึงเก็บ**ข้อเท็จจริงเป็นคอลัมน์** `session_registrations.promoted_at` / `cancel_waiver` (ไม่ใช่ state: `status` ไม่เปลี่ยน, เขียนได้จาก DB function เท่านั้นเพราะ `authenticated` มีแค่ SELECT) แล้วให้ทั้งสองจุดอ่านผลนั้น (`member_reliability` ไม่นับแถวที่มี waiver · `Participant.cancelPenaltyWaived` ใน billing) · ADR-001 ไม่ถูกแตะ: SQL แค่ตัดสิน "ยกเว้นหรือไม่" ส่วนการคิดเงินยังอยู่ใน `domain/billing`
- **Consequences**:
  - นัดเก่าไม่เปลี่ยนพฤติกรรม (ไม่มีคีย์ = 0, `promoted_at` เป็น null) · ก๊วนเดิมที่ยังไม่มีคีย์ใน `gangs.cancellation_policy` ได้ default 3 เมื่อสร้างนัดใหม่ (column default ของก๊วนใหม่ก็เป็น 3)
  - `cancel_registration` / `promote_waitlist` เปลี่ยน signature (มี default ทุกตัวใหม่ — ผู้เรียกแบบ positional เดิม รวม `cancel_registration_as_guest`, cron `sweep_waitlist`, `leave_gang` ยังใช้ได้)
  - ผู้ที่ถูกเลื่อนแล้วไม่ยกเลิก และไม่มา ⇒ ยังเป็น no-show ตามเดิม (grace ช่วยเฉพาะคนที่ "ตอบทัน")
  - ค่า grace ตั้งได้ที่ตั้งค่าก๊วน (`validate()` ตรวจ 0–48) — หน้าจอเป็นงาน Track A · ข้อความเหตุผลของแอดมินอ่านได้เฉพาะแอดมิน
