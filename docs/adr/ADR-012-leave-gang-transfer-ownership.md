# ADR-012 — ออกจากก๊วนเอง + โอนความเป็นเจ้าของ

> สถานะ: **ร่างก่อนโค้ดของ WO-B2** — เนื้อหาตั้งใจให้ต่อท้าย `gang-badminton-plan-v3.3-FINAL.md` (หลัง ADR-009)
> ตาม CLAUDE.md §0.6 · รอ planner อนุมัติการ append เข้า baseline (คำสั่งแรกถูกบล็อก — ดูข้อความถึง @gb-planner)
> เลข ADR-010 (เครดิต) และ ADR-011 (grace หลังถูกเลื่อนคิว) ยังเป็นร่างใน `docs/phase6-redesign-plan.md` §9

### ADR-012 — ออกจากก๊วนเอง + โอนความเป็นเจ้าของ: สองฟังก์ชัน DB ที่ lock แถวสมาชิก · หนี้ไม่หายเมื่อออก · registration อนาคตยกเลิกผ่าน `cancel_registration()`

- **Context**: ตอนนี้สมาชิก**ออกจากก๊วนเองไม่ได้** (มีแต่แอดมิน soft-delete คนอื่นผ่าน `removeMember`) และ owner **ส่งต่อก๊วนไม่ได้** (`domain/permissions/can.ts` เขียนไว้เองว่า "ย้ายเจ้าของ ยังไม่มีใน MVP-0") · กติกา "ห้ามเหลือก๊วนไร้ owner" ปัจจุบันอยู่ใน server action เป็น check-then-act (`count(owner)` แล้วค่อย `update`) ⇒ สอง request พร้อมกัน (โอน 2 ทาง / owner สองคนออกพร้อมกัน) ผ่านทั้งคู่แล้วก๊วนไม่มี owner ได้ ซึ่งขัดหลักของ CLAUDE.md §2.1 ที่ห้ามตัดสินเรื่องจำนวนใน TS · อีกเรื่องคือสมาชิกที่ออกยังถือ registration ที่ยัง confirmed/waitlist ในนัดอนาคต และอาจมียอดค้างจ่าย
- **Options**:
  - (ก) server action นับ owner / ยกเลิก registration เองแล้ว soft-delete — เร็วที่สุดแต่ race เหมือนเดิม และต้องยกเลิกทีละใบจาก TS
  - (ข) constraint trigger "ต้องมี owner ≥ 1" ดักทุกทางที่เปลี่ยน role — ปิด race ได้ แต่ไม่ช่วยเรื่องยกเลิก registration/ย้าย owner และ error ที่ได้ไม่สื่อความหมาย
  - (ค) **DB function สองตัว** `leave_gang()` / `transfer_gang_ownership()` ที่ `SELECT … FOR UPDATE` แถว `gang_members` ของก๊วนนั้นแล้วตรวจใหม่ภายใต้ lock — แพตเทิร์นเดียวกับ `register_to_session` / `cancel_registration`
  - เรื่องหนี้ค้าง: (ง) บล็อกการออกจนกว่าจะจ่ายครบ — คนจะ "ค้างตลอดชีพ" ในก๊วนที่ไม่อยากอยู่แล้ว · (จ) ออกได้และหนี้ยังอยู่ · (ฉ) ออกแล้วล้างหนี้ — ขัดกติกาเงิน (ledger ห้ามหาย)
- **Decision**: เลือก **(ค) + (จ)**
  1. `leave_gang(p_gang_id, p_actor_id, p_correlation_id)`: lock แถว `gang_members` ที่ active ของก๊วน (เรียงตาม `id` กัน deadlock ไขว้) → ต้องเป็นสมาชิก active (`NOT_GANG_MEMBER`) → **owner ที่ไม่มี owner คนอื่นเหลืออยู่ออกไม่ได้ ต้องโอนก่อน** (`VALIDATION_ERROR`) → ยกเลิก registration ที่ `confirmed`/`waitlist` ของตนในนัดที่ `draft/open` และ `starts_at > now()` โดยเรียก **`cancel_registration()` เดิมทีละใบ** (ได้ penalty / `is_late_cancel` / promote waitlist ตาม snapshot เหมือนยกเลิกเอง — ❌ ไม่เขียน status ตรง) → อ่านยอดค้าง ณ ตอนออกจาก ledger (อ่านอย่างเดียว) → soft-delete แถวสมาชิก → ลบ `member_line_links` ของ (ก๊วน, ผู้ใช้) → event `gang.member_left` (ไม่ใส่ยอดเงิน) → คืน `{ member_id, cancelled_registrations, outstanding_charges, outstanding_amount }`
     - นัดที่ `in_play` / `billing` / `settled` / `cancelled` และ registration ที่ `checked_in` **ไม่แตะ** (ปิดรอบตามปกติ) · guest ที่ผู้ออกเป็นคนลงชื่อให้ไม่ถูกแตะ
  2. `transfer_gang_ownership(p_gang_id, p_actor_id, p_to_user_id, p_correlation_id)`: lock แถวเดียวกัน → ผู้โอนต้องเป็น **owner active** (ไม่งั้น `FORBIDDEN`) → ผู้รับต้องเป็น**สมาชิก active ของก๊วนนั้น** ไม่ใช่ owner อยู่แล้ว และไม่ใช่ตัวเอง (`VALIDATION_ERROR`) → ผู้โอนกลายเป็น `admin` ผู้รับกลายเป็น `owner` ใน transaction เดียว → event `gang.ownership_transferred`
  3. ทั้งสองฟังก์ชัน `security definer` + `set search_path = ''` + EXECUTE เฉพาะ `service_role` (server action ยืนยันตัวตนด้วย `requireUser()` แล้วส่ง `p_actor_id` — แพตเทิร์นเดียวกับ `request_to_join_gang`) · สิทธิ์ใน `can()`: `gang.leave.self` (ทุก role) และ `gang.ownership.transfer` (**owner เท่านั้น** — สิทธิ์แรกที่ owner มีเหนือ admin)
  4. **หนี้**: ไม่แตะ `session_charges` / `payments` / `payment_allocations` / `payment_adjustments` เลย — ยอดค้างคำนวณจาก ledger (`charge_outstanding`) ไม่ขึ้นกับสถานะสมาชิก และ soft-delete แถว `gang_members` ไม่ทำให้ FK ใดหาย
  5. ไม่เพิ่ม `error.code` — ใช้ `NOT_GANG_MEMBER` / `FORBIDDEN` / `VALIDATION_ERROR` (พร้อม `detail.reason`) / `CANCEL_CUTOFF_PASSED` ที่มีใน `docs/errors.md` อยู่แล้ว
  6. กลับเข้าก๊วน = ช่องทางเดิม (join request ของก๊วน public + discovery หรือแอดมินเพิ่ม) ซึ่งกู้แถวเดิมที่ soft-delete กลับมาอยู่แล้ว
- **Consequences**:
  - ก๊วนมี owner ≥ 1 เสมอผ่านสองฟังก์ชันนี้ แม้โอน/ออกพร้อมกัน (เทสต์ concurrency พิสูจน์)
  - ผู้ออกที่มียอดค้างต้องได้รับแจ้ง**ตอนออก**: `leave_gang()` คืน `outstanding_charges` / `outstanding_amount` (อ่านจาก ledger ด้วย `charge_outstanding()`, ไม่แตะข้อมูล, ยอดเป็น string) เพราะ**ออกแล้วผู้ออกอ่านรายการหนี้ (`session_charges`) ของตัวเองไม่ได้อีก** — policy `session_charges_select` ตรวจผ่านแถว `gang_members` / `session_registrations` ซึ่ง RLS ของตารางเหล่านั้นกรองคนนอกก๊วนออก (พิสูจน์ในเทสต์) · ที่ยังอ่านได้คือ `payments` ที่ตนเป็น `payer_user_id` · แอดมินเห็นทุกอย่างผ่าน `is_gang_admin` ตามเดิม
  - แต่ผู้ออก**สร้างใบจ่ายเองไม่ได้อีก** (`payment.submit.self` ต้องเป็นสมาชิก) ⇒ แอดมินออกใบให้ผ่าน `createPaymentForCharges(payerUserId)` ที่มีอยู่ · UI ต้องแสดงยอดค้างจากผลของ `leaveGang()` และหน้าเก็บเงินของแอดมินต้องแสดงยอดค้างของคนที่ออกแล้ว (ตัวเลือก payer ใน `app/gangs/[gangId]/payments/page.tsx` กรอง `deleted_at is null` อยู่) = งานฝั่ง UI ใน Track A
  - ทางเลือกที่ไม่ได้ทำ (ถ้าเจ้าของงานอยากให้ผู้ออกเห็นหนี้ตัวเองต่อ): ขยาย `session_charges_select` ให้อ่านผ่าน `registration.user_id` โดยไม่ผ่าน RLS ของ registration — แตะ RLS ตารางเงิน จึงไม่ทำใน WO นี้
  - ก๊วนที่ตั้ง `allow_cancel_after_cutoff = false` + ผู้ออกถือที่ confirmed เลย cutoff ของนัดอนาคต ⇒ `leave_gang()` ล้มทั้งก้อน (`CANCEL_CUTOFF_PASSED`, atomic — ไม่ออกครึ่งๆ กลางๆ) ตั้งใจให้เคารพ policy ของก๊วน
  - RLS `gang_members_update_admin` ยังให้ admin UPDATE `role` ตรงได้ และ `changeMemberRole` / `removeMember` ยังเป็น check-then-act ใน TS — ปิดช่องนี้ไม่อยู่ใน ADR นี้ (จดใน `BACKLOG.md`)
  - ธง `is_monthly_member` ไม่ถูกรีเซ็ตตอนออก (เหมือนกรณีแอดมินเอาออก) — จดใน `BACKLOG.md`
