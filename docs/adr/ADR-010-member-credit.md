# ADR-010 — เครดิตสมาชิก (member credit) หักอัตโนมัติเมื่อมีหนี้ใหม่

> สถานะ: **ร่างจาก WO-B5a** — ตั้งใจให้ planner ต่อท้าย `gang-badminton-plan-v3.3-FINAL.md` (ย่อ, คง CRLF)
> ต่อยอดร่างใน `docs/phase6-redesign-plan.md` §9 · เจ้าของงานตัดสินแล้ว (26 ต.ค.): **เอา + หักอัตโนมัติเมื่อมีหนี้ใหม่**

### ADR-010 — เครดิตสมาชิกเป็นเงินที่ก๊วนติดสมาชิก: ledger append-only ต่อ (gang, user) · ใช้จ่ายหนี้ผ่าน `apply_credit()` ทางเดียว

- **Context**:
  - โอนเกินยอดที่ขอ (เช่น QR 150 โอน 200) ตอนนี้ไม่มีที่ลง — `payments.amount` ถูกกำหนดจาก DB เสมอ ส่วนเกินจึงหายจากบัญชีหรือแอดมินต้องจำเอง
  - baseline §การตัดสินใจสะสมเดิมบอกว่า **"ค้างเก็บ" กับ "ต้องคืน" ไม่หักกลบกัน** (`domain/billing/ledger.ts` `summarize()` แยก `outstanding` กับ `credit`) — กติกานี้ป้องกันรายงานโกหกว่า "เก็บครบแล้ว" ทั้งที่ยังมีคนค้างและมีคนต้องคืน
  - เจ้าของงานต้องการให้ส่วนเกินเป็น **เครดิต** ที่ถูกหักกับหนี้ใหม่ของคนเดียวกันได้เอง
- **Options**:
  - (ก) ไม่ทำ — แอดมินคืนเงินสด/จดเอง
  - (ข) ใช้ `payment_adjustments` type=`credit` เดิมเป็นกระเป๋าเงิน — ❌ เป็นรายการลดหนี้ **ของ charge ก้อนเดียว** (ติดลบ, อ้าง `session_charge_id`) ไม่มีเจ้าของยอดคงเหลือ ไม่มีการ "เก็บไว้ใช้ทีหลัง"
  - (ค) **ตารางใหม่ `credit_ledger` ระดับสมาชิก** ใช้จ่ายผ่าน `payment_allocations` เดิม ← เลือก
- **Decision**: เลือก **(ค)**
  1. **`credit_ledger`** append-only ต่อ (`gang_id`, `user_id`) · `amount` บวก = เข้า / ลบ = ออก · เก็บ `balance_after` ทุกแถว · `CHECK (balance_after >= 0)` ⇒ เครดิตติดลบไม่ได้ในระดับ schema · ห้าม UPDATE/DELETE/TRUNCATE (trigger กันทุก role รวม service_role)
  2. **ยอดคงเหลือ = Σ `credit_ledger.amount`** คือความจริง · `credit_balances(gang_id, user_id, balance)` เป็น cache ที่ใช้เป็น **จุด `FOR UPDATE`** เท่านั้น (`CHECK balance >= 0`) แก้ได้จาก DB function ในทรานแซกชันเดียวกับการเพิ่มแถว ledger · คำนวณใหม่จาก Σ ได้เสมอ (`credit_balance_of()`) และมีเทสต์ยืนยัน cache = Σ
  3. **guest ไม่มีเครดิต** — `user_id` ผูก `profiles(id)` ไม่ null · charge ของ guest (`registration.user_id is null`) ข้ามการหักอัตโนมัติ
  4. **ช่องทางเข้าใบ B5a: "โอนเกิน" ทางเดียว** — `record_overpayment(payment_id, amount, reason)` แอดมินยืนยัน (ตรวจสิทธิ์แอดมินใน DB ผ่าน `actor_is_gang_admin()`): payment ต้อง `verified` · มี `payer_user_id` ที่ยังเป็นสมาชิก · ต้องมีเหตุผล · **หนึ่งสลิปบันทึกส่วนเกินได้ครั้งเดียว** (partial unique index) ⇒ กดซ้ำไม่ทำให้เครดิตเบิ้ล · ช่องอื่น (ยกเลิกนัดที่จ่ายแล้ว / แอดมินเติม / จ่ายคืนเป็นเงินสด) = **WO-B5b** (เพิ่ม `type` ใน CHECK ด้วย migration ใหม่)
  5. **ใช้เครดิตผ่าน `apply_credit(gang, user, charge_ids?, actor, correlation)` ทางเดียว** — `FOR UPDATE` แถว `credit_balances` → คำนวณ `take = least(ยอดค้างจริง, เครดิตที่เหลือ)` ต่อ charge เรียงเก่า→ใหม่ → สร้าง `payments` (ของผู้ใช้ สถานะ `verified` ผ่าน `transition_payment()` เดิม) + `payment_allocations` ที่ **`source = 'credit'`** + แถว ledger (`type = 'applied'`, ลบ) · เครดิตใช้ได้กับ **charge ของตัวเองเท่านั้น** (ไม่จ่ายแทนเพื่อนด้วยเครดิต)
  6. **หักอัตโนมัติ = `AFTER INSERT` statement trigger บน `session_charges`** (transition table) — เป็นจุดเดียวที่ครอบทุกทางที่สร้างหนี้: `close_session_with_charges()` (type `session`) และ `commit_monthly_fees()` (type `monthly_fee`) โดย**ไม่แก้สองฟังก์ชันนี้** (ADR-001 คงเดิม: TS คิดเงิน → DB commit) · trigger เรียงผู้ใช้ตาม `user_id` แล้วเรียก `apply_credit()` กับ **charge ที่เพิ่งเกิดในคำสั่งนั้นเท่านั้น** · หนี้เก่าที่ค้างก่อนมีเครดิตไม่ถูกหักเอง (ต้องเรียก `apply_credit()` ระบุ charge — กันเครดิตหายไปกับหนี้เก่าโดยไม่มีใครตั้งใจ)
  7. **สิทธิ์**: RLS — สมาชิกอ่านของตัวเอง · แอดมินอ่านทั้งก๊วน · **เขียนตรงไม่ได้ทุก role** (grant เฉพาะ SELECT) · ฟังก์ชันทั้งหมด `EXECUTE` เฉพาะ `service_role` · TS: `can()` เพิ่ม `credit.read.self`, `credit.read.other`, `credit.overpayment.record`
- **ความสัมพันธ์กับของเดิม**:
  - **`payment_adjustments` type=`credit`** (0004/0026) **ไม่ถูกแทนที่และไม่ถูกใช้ร่วม** — คือ "ลดยอดหนี้ก้อนนี้" (ส่วนลด/ยกหนี้ ติดลบ ผูก charge) ไม่มียอดคงเหลือ · `credit_ledger` คือ "เงินที่ก๊วนติดสมาชิก" ระดับคน · ชื่อซ้ำกันแต่ความหมายต่างกัน — เอกสาร/UI ต้องเรียก adjustment ว่า "ปรับลดหนี้" ไม่ใช่ "เครดิต"
  - **`charge_outstanding()` ไม่ถูกแก้** — allocation ที่ `source = 'credit'` ผูกกับ payment `verified` จึงถูกหักจากยอดค้างเหมือนเงินโอนทุกประการ ⇒ **ledger ของยอดค้างยังเป็นแหล่งความจริงเดียว** (`ยอดค้าง = charge − allocations(verified) + adjustments` สูตรเดิมไม่เปลี่ยน)
  - **กติกาเดิม "ค้างเก็บกับต้องคืนไม่หักกลบ" → เปลี่ยนเป็น: หักกลบได้ผ่านเครดิตเท่านั้น** — `summarize()` ยังแยก `outstanding`/`credit` ของ **charge ก้อนที่จ่ายเกิน** (ยอดค้างติดลบ) ตามเดิม ไม่หักกลบข้ามคนหรือข้ามก้อนเอง · ส่วนเกินของสลิปไปอยู่ใน `credit_ledger` ไม่ทำให้ยอดค้างของ charge ติดลบ ⇒ ไม่ซ้ำซ้อนกัน
  - **รายงาน**: เครดิตไม่ใช่เงินสดเข้า ⇒ **"เก็บได้จริง" ต้องนับเฉพาะ allocation `source = 'transfer'`** (ไม่รวมส่วนที่จ่ายด้วยเครดิต) · ยอดเครดิตคงค้างทั้งก๊วน = Σ `credit_balances` แสดงเป็น "เงินที่ก๊วนติดสมาชิก" · เงินสดส่วนเกินที่รับมาไม่นับเป็น "เก็บได้จริง" ตอนรับ (เป็นหนี้สินของก๊วน) และไม่นับซ้ำตอนถูกใช้ · `member_statistics.total_paid` (มุมมองรายคน) **ยังนับรวมส่วนที่จ่ายด้วยเครดิต** = "สมาชิกจ่ายค่านัดไปเท่าไหร่" — ไม่แก้ `rollup_member_statistics()` ในใบนี้
- **Consequences**:
  - `payment_allocations` เพิ่มคอลัมน์ `source` (`'transfer'` default, `'credit'`) — แถวเดิมทั้งหมดเป็น `transfer` · query หน้ารายงาน/จ่ายเงินที่เลือก `payment_allocations(amount, payments(status))` ต้องเพิ่ม `source` เพื่อแยก "เก็บได้จริง" — **เป็นงานฝั่งหน้าจอ (Track A / 6.5)** ใบนี้ไม่แตะ UI
  - การหักอัตโนมัติรันใน transaction เดียวกับการปิดรอบ/ออกค่ารายเดือน ⇒ ปิดรอบแล้วหนี้ถูกหักทันที ผู้ใช้อาจเห็นหนี้ 0 บาทโดยไม่เคยกดจ่าย · notification `payment.due` ยังเข้าคิวตามเดิม (ผู้รับที่หนี้เหลือ 0 ไม่ควรถูกตามจ่าย — ตัวส่งต้องดูยอดค้างจริง; จดไว้ใน BACKLOG)
  - ล็อก: `apply_credit` ล็อก `credit_balances` ทีละคนตามลำดับ `user_id` · ไม่ล็อกซ้อนกับแถว session หรือ charge ที่อื่น ⇒ ปิดรอบสองนัดพร้อมกันของก๊วนเดียวกันไม่ deadlock
  - ออกจากก๊วน (`leave_gang`) **ไม่ล้างเครดิต** — ก๊วนยังติดเงินอยู่ แต่ผู้ออกอ่านเองไม่ได้ (RLS ผูกสมาชิก เหมือน `session_charges`) · `leave_gang()` ควรคืนยอดเครดิตคงเหลือเป็นประกาศสุดท้ายคู่กับยอดค้าง + แอดมินคืนเงินสดผ่าน B5b → จดใน BACKLOG ไม่แก้ในใบนี้
  - ขอบเขตที่ **ยังไม่ทำ** (B5b): ยกเลิกนัดที่จ่ายแล้ว → เข้าเครดิต · แอดมินเติมมือ · จ่ายคืนเป็นเงินสด (ลดเครดิต) · การ refund ของ charge ที่จ่ายด้วยเครดิตต้องคืนเข้าเครดิตไม่ใช่เงินสด (ตอนนี้ `add_payment_adjustment` refund ยังนับ allocation ทุก source ว่าคืนได้)
