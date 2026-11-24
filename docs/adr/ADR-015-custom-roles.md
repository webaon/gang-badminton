# ADR-015 — บทบาทกำหนดเอง (เหรัญญิก / ผู้จัดคิว): สิทธิ์ซ้อนบน role เดิม ไม่ใช่แทนที่

> สถานะ: **ร่างจาก WO-B13-ADR (เอกสารเท่านั้น — ยังไม่มีโค้ด/migration)** — รอเจ้าของงานตอบตาราง ★ ท้ายเอกสาร แล้ว planner ต่อท้าย `gang-badminton-plan-v3.3-FINAL.md` (ย่อ, คง CRLF)
> ที่มา: `docs/phase6-redesign-plan.md` §5 แถว B13 (กลับเข้าแผนตามคำตัดสิน 26 ต.ค.) · **เป็น ADR กลับคำ**: baseline §"ADR — ข้อเสนอที่ไม่รับ" บรรทัด `RBAC เต็มรูป` (`gang-badminton-plan-v3.3-FINAL.md:291`) บอกว่า "3 role คงที่ครอบการใช้งานก๊วน … ย้าย mapping ลง DB ทีหลังแตะโมดูลเดียว" และ "จะทบทวนเมื่อ: ลูกค้าต้องการ custom role ต่อก๊วน" — เงื่อนไขทบทวนเกิดแล้ว (เจ้าของงานต้องการเหรัญญิก/ผู้จัดคิว)
> ข้อมูลทั้งหมดด้านล่างไล่จากโค้ด ณ commit `6d6a3ba` (migration ถึง 0049)

### ADR-015 — เพิ่ม "ชุดสิทธิ์" (role bundle) ซ้อนบน role พื้นฐาน owner/admin/member · ใช้ชื่อ action เดียวกับ `can()` ทั้งใน TS และ RLS · เปลี่ยน RLS แบบ expand → migrate → contract

#### Context — role ถูกเช็คที่ไหนบ้างตอนนี้ (ไล่ครบ)

> ⚠️ **แผนบอก vs ของจริง**: baseline คาดว่าย้าย mapping แล้ว "แตะโมดูลเดียว" — ของจริง role ถูกเช็คใน **3 ชั้น** (TS `can()` + RLS policy + DB function) กระจาย ~24 policy + 9 storage policy + ~13 จุดใน DB function + ~81 จุดเรียกใน TS งานนี้จึงไม่ใช่การแก้ `can()` ที่เดียว

**1) TypeScript — `can()` รวมศูนย์ (ชั้น "ตอบให้ถูก" ไม่ใช่ความปลอดภัย)**
- `domain/permissions/types.ts:9` `GANG_ROLES = ['owner','admin','member']` · `:19` `ORG_ROLES` · `ACTIONS` ~45 รายการ (`:30-95`)
- `domain/permissions/can.ts:26` `MEMBER` · `:45` `ADMIN` · `:85` `OWNER = ADMIN + gang.ownership.transfer` · `:87` `ROLE_ACTIONS` (3 Set) · `:117` `can(ctx, action)` ตรวจ feature flag → `effectiveRole` (แอดมินองค์กรนับเป็น admin) → Set · `:133` `assertCan` · `:142` `allowedActions`
- ตัวโหลด role ของผู้ใช้ **ซ้ำกัน 7 สำเนา** (`async function roleInGang`): `server/actions/credit.ts:30` · `gangs.ts:42` · `members.ts:19` · `membership.ts:28` · `payments.ts:32` · `sessions.ts:20` · `templates.ts:31` — แต่ละสำเนาอ่าน `gang_members.role` แล้วโยนเข้า `can({ role })`
- จุดเรียก `can({ role })` / `assertCan({ role })` / `roleInGang(` รวม **81 จุด**: server/actions (game-console 9, payments 8, credit 8, registrations 7, members 5, templates 4, sessions 3, membership 3, gangs 2, billing 2, อื่นๆ 1 ต่อไฟล์) · `server/sessions/console-loader.ts` 2 · `features/sessions/SessionDetailPage.tsx` 5 · `SessionsListPage.tsx` 2 · `features/billing/CloseSessionPage.tsx:56` · `app/gangs/[gangId]/*/page.tsx` 14 หน้า
- เมนู: `domain/navigation/gang-menu.ts:10-11` import `can` — เมนูตัดสินด้วย `can()` อยู่แล้ว ⇒ ไม่ต้องแก้ตัว navigation ถ้า `can()` รู้จักชุดสิทธิ์ · `app/gangs/[gangId]/layout.tsx:64` เรียก `buildGangMenu({ role, features })`
- **เช็ค role ตรงๆ นอก `can()`** (ผิดกติกา CLAUDE.md §3 แต่ยังอยู่ เพราะเป็นกติกา "owner" ไม่ใช่สิทธิ์ทั่วไป): `server/actions/members.ts:86-100` (เปลี่ยน role ห้ามทำ owner คนสุดท้ายหาย) · `:238-243` (ลบสมาชิก) · `server/actions/payments.ts:238` (ดูสลิปแบบมีอายุ: `["owner","admin"].includes(role)` — ต้องย้ายเป็น `payment.verify`) · `app/gangs/[gangId]/members/page.tsx:64` · `features/gangs/MembersPanel.tsx:27,132` (ตัวเลือก role)

**2) ฐานข้อมูล — schema**
- `gang_members.role text … check (role in ('owner','admin','member'))` — `supabase/migrations/20260810000002_tenancy.sql:172-173` · index `:201` `(gang_id, role) where deleted_at is null`
- `organization_members.role check (role in ('owner','admin'))` — `tenancy.sql:66`

**3) ฐานข้อมูล — ฟังก์ชันช่วย RLS** (`20260811000010_rls.sql`)
- `is_gang_member` `:61` · `is_gang_admin(gang)` `:108` = สมาชิก role ∈ (owner, admin) **หรือ** แอดมินองค์กรของก๊วน · `is_session_admin(session)` `:181` · `is_payment_visible(payment)` `:201` (เจ้าของสลิป หรือแอดมิน)

**4) ฐานข้อมูล — RLS policy ที่ใช้ `is_gang_admin`/ตัวช่วย** (ไล่ตาม `awk` ทุก migration)
| ตาราง/ที่เก็บ | policy (path:line) | ตัวตัดสิน |
|---|---|---|
| `gangs` | `rls.sql:342` `gangs_update_admin` | admin |
| `gang_members` | `:355` insert_admin · `:359` update_admin | admin (⇒ ใครตั้ง role ได้) |
| `gang_skill_levels` / `gang_pricing_plans` / `session_templates` / `coupons` | `:370` / `:377` / `:384` / `:391` | admin |
| `gang_expenses` / `gang_incomes` | `:397` / `:402` | admin |
| `announcements` | `:409` write · `20260815000032_announcement_publish.sql:20` select | admin |
| `sessions` | `:424` insert_admin_draft_only · `:432` update_admin | admin |
| ตารางผูก session (ผ่าน `is_session_admin`) | `:455` `session_invite_tokens_admin` · `:468` `games_write_admin` | admin |
| `session_charges` / `payments` / `payment_adjustments` | `:478` / `:500,:519` / `:537` → ปรับใหม่ `20260817000039_tighten_read_policies.sql:75` | admin หรือเจ้าของ |
| `notification_logs` / `member_line_links` / `join_requests` | `:562` / `:582` / `:589,:600` | admin |
| `event_logs` | `20260817000039:56` `event_logs_select_member` (event เรื่องเงิน/`audit.%` เห็นเฉพาะแอดมิน ผ่าน `event_type_is_admin_only()`) | admin |
| `member_statistics` | `20260815000031_member_statistics_privacy.sql:22` | admin เห็นทั้งก๊วน |
| `credit_ledger` / `credit_balances` | `20260818000044_member_credit.sql:144` / `:154` | admin เห็นทั้งก๊วน |
| storage | `20260811000011_storage_buckets.sql:58,78,88` payment_slips · `:135,142,149` gang_assets · `:167,174,181` announcement_images | admin |

**5) ฐานข้อมูล — DB function ที่ตรวจแอดมินเอง** (เรียกผ่าน `service_role` จึงใช้ `actor_is_gang_admin(gang, actor)` ที่ `20260818000041:63`)
`promote_waitlist` (`…045:224`) · `cancel_registration` waiver (`…043:203`) + `preview_cancel_registration` (`…043:353`) · `record_overpayment` (`…047:240`) · `set_payment_received_amount` (`…047:103`) · `credit_cash_payout` (`…048:298`) · `credit_return_charge` (`…048:405`) · `credit_topup` (`…049:56`) — ส่วน `leave_gang`/`transfer_gang_ownership` (`…040`) เช็ค `role = 'owner'` ตรงๆ (กติกาความเป็นเจ้าของ — ไม่เกี่ยวกับชุดสิทธิ์)

**ข้อสังเกตที่กำหนดดีไซน์**
1. ชั้น RLS/DB function คือกำแพงจริง — ชุดสิทธิ์ที่เพิ่มต้องบังคับที่ชั้นนี้ ไม่ใช่แค่ `can()` (กติกา `can()` ไม่ใช่ชั้นความปลอดภัย, `can.ts:3-16`)
2. ชื่อ action ใน `can()` (`credit.topup`, `payment.verify`, …) เป็นคำศัพท์ที่ทั้งทีมและ test (`tests/domain/can.test.ts`) ใช้อยู่แล้ว ⇒ ใช้ชื่อเดียวกันใน DB แทนการสร้างคำศัพท์ "capability" ชุดที่สอง (กันสองแหล่งความจริง)
3. ทุก policy ปัจจุบันเป็น `is_gang_admin(...)` ซึ่ง **เป็นเซตย่อยของ** "มีสิทธิ์ X" เสมอ (admin ทำได้ทุกอย่างที่ delegate ได้) ⇒ เปลี่ยนเป็น "admin **หรือ** ถือชุดสิทธิ์ที่มี X" **ไม่ทำให้ใครเสียสิทธิ์เดิม**

#### Options

| | (ก) preset ในโค้ด · ขยาย `gang_members.role` | (ข) role อิสระ: ตารางสิทธิ์ต่อก๊วน เลือก permission เอง | (ค) **ตารางชุดสิทธิ์ (data model แบบ ข) แต่เปิดใช้แค่ 2 preset ระบบก่อน** ← เสนอ |
|---|---|---|---|
| โครงสร้าง | `role check` เพิ่ม `'treasurer','scheduler'` · `can.ts` เพิ่ม 2 Set | `gang_roles(permissions text[])` ต่อก๊วน · owner สร้าง/แก้เองได้ | ตารางเดียวกับ (ข) · seed เหรัญญิก/ผู้จัดคิวเป็น `is_system` · เฟสแรกไม่มี UI สร้างเอง |
| เพิ่ม role ที่สาม | migration + deploy ใหม่ | ไม่ต้อง | เพิ่ม preset = migration seed 1 แถว · custom = เฟส 2 (ตารางพร้อมแล้ว) |
| คนหนึ่งเป็นสองบทบาท (เหรัญญิก + ผู้จัดคิว) | ไม่ได้ (role คอลัมน์เดียว) | ได้ถ้าออกแบบ m:n | **ได้** (m:n) |
| กระทบ logic ที่เทียบ `role` (`last owner`, `leave_gang`, `members.ts:86`) | ต้องไล่แก้ทุกที่ที่ `role in ('owner','admin')` นับ role ใหม่เป็น "ไม่ใช่ admin" | ไม่กระทบถ้าเป็นชุดซ้อน | **ไม่กระทบ** (role พื้นฐานคงเดิมทุกตัว) |
| ความเสี่ยง escalation | ต่ำ (รายการคงที่) | สูง (เลือก permission อิสระ → ต้องมี catalog + validation + UI ซับซ้อน) | ต่ำในเฟสแรก (2 preset ที่ตรวจแล้ว) · เฟส 2 ใช้ catalog "delegable" เดิม |
| ต้นทุน | น้อยสุด แต่ **ต้องแก้ RLS ชุดเดียวกัน** (24 policy + 13 function) แล้วเฟสถัดไปต้องแก้ซ้ำ | ใหญ่สุด | ปานกลาง — จ่าย RLS migration **ครั้งเดียว** |

#### Decision (ร่าง — รอ ★)

เลือก **(ค)**: ชุดสิทธิ์เป็น **ข้อมูล** ซ้อนบน role พื้นฐาน (ไม่แทนที่)

1. **role พื้นฐานคงเดิม** `owner|admin|member` (กติกา last-owner / leave / transfer / org admin ไม่เปลี่ยนเลย) — ชุดสิทธิ์ให้เพิ่มเฉพาะสมาชิก `member` (admin/owner มีสิทธิ์ครบอยู่แล้ว) · ถ้าเลื่อนเป็น admin ชุดสิทธิ์ถูกปลดอัตโนมัติ (transition ใน DB function ที่เปลี่ยน role)
2. **ตารางใหม่ (ทุกตารางเปิด RLS + revoke/grant + policy + `tests/rls/grant-matrix.test.ts`; PK `uuid_generate_v7()`; soft-delete)**
   - `gang_roles(id, gang_id uuid null → gangs, key text, name text, permissions text[] not null, is_system boolean, created_at, created_by, deleted_at)` · `gang_id null` = preset ระบบที่ทุกก๊วนใช้ร่วม (แก้ไม่ได้ผ่านแอป) · unique `(coalesce(gang_id, '00000000-…'), key) where deleted_at is null`
   - `gang_member_roles(gang_member_id → gang_members, role_id → gang_roles, assigned_by, assigned_at)` · PK `(gang_member_id, role_id)` · embed ต้องระบุชื่อ FK (กติกา PostgREST)
   - `permissions` เก็บ **ชื่อ action เดียวกับ `can()`** และถูกจำกัดด้วยรายการ *delegable* (ข้อ 4) ผ่าน CHECK/trigger ที่เรียกฟังก์ชัน `is_delegable_action(text)` — รายการเดียวกับ `DELEGABLE_ACTIONS` ใน `domain/permissions` (มีเทสต์เทียบสองฝั่งว่าตรงกัน)
3. **ฟังก์ชันตัดสินใน DB ตัวเดียว** (ใช้ทั้ง RLS และ DB function):
   - `has_gang_permission(gang, action)` = `is_gang_admin(gang)` **หรือ** ผู้ใช้ปัจจุบัน (`auth.uid()`) ถือชุดสิทธิ์ใน `gang_member_roles` ที่ `permissions` มี `action`
   - `actor_has_permission(gang, actor, action)` = เหมือนกันแต่รับ actor (สำหรับ function ที่เรียกผ่าน `service_role`) — แทนที่ `actor_is_gang_admin` ในจุดที่ delegate ได้
   - ทั้งคู่ `STABLE SECURITY DEFINER` + `set search_path=''` + EXECUTE ตามแบบเดียวกับ `is_gang_admin` (`rls.sql:684`)
4. **รายการที่ delegate ได้ (`DELEGABLE_ACTIONS`)** — ตั้งใจเป็นรายการปิด ไม่ใช่ "ทุก action":
   - ✅ delegate ได้: `payment.verify` · `credit.read.other` · `credit.overpayment.record` · `credit.payout.record` · `credit.return_charge` · `credit.topup`(★) · `gang.finance.view` · `gang.finance.manage` · `billing.close`(★) · `session.create/update/transition/invite.manage` · `registration.create.other/create.guest/cancel.other/promote.other/checkin/no_show` · `game.manage` · `announcement.manage`(★) · `statistics.view`(★)
   - ❌ **ห้าม delegate เด็ดขาด** (ต่อให้ owner ใส่ในชุดสิทธิ์ก็ถูก CHECK ปฏิเสธ): `gang.member.manage` (= ตั้ง role/ชุดสิทธิ์ให้ตัวเองหรือคนอื่น → escalation) · `gang.ownership.transfer` · `gang.update` · `gang.line.manage` (credentials LINE) · `gang.join_request.manage` · `gang.leave.self` เป็นต้น · `gang.pricing.manage` / `gang.skill.manage` (★ — เปลี่ยนกติกาคิดเงิน)
5. **Preset ที่เสนอ** (ปรับได้ตาม ★):
   - **เหรัญญิก (`treasurer`)**: `payment.verify` · `credit.read.other` · `credit.overpayment.record` · `credit.payout.record` · `credit.return_charge` · `gang.finance.view` · `gang.finance.manage` — **ไม่มี `credit.topup`** (ให้เครดิต = สร้างหนี้ของก๊วนโดยไม่มีเงินเข้า, ADR-010 Q3 ให้เฉพาะ admin/owner) และไม่มี `billing.close`
   - **ผู้จัดคิว (`scheduler`)**: `session.create/update/transition/invite.manage` · `registration.create.other/create.guest/cancel.other/promote.other/checkin/no_show` · `game.manage` — **ไม่มี** เงิน/ประกาศ/สมาชิก
6. **ใครแต่งตั้งได้**: ผู้ที่มี `gang.member.manage` (admin/owner) เท่านั้น · ผู้ถือชุดสิทธิ์แต่งตั้งต่อไม่ได้ (เพราะ `gang.member.manage` ไม่ delegable) · ผ่าน DB function `assign_gang_role(gang, member, role_key, actor)` / `revoke_gang_role(...)` ที่ `FOR UPDATE` แถว `gang_members` (ลำดับเดียวกับ `leave_gang` — กัน race กับการออกจากก๊วน/เปลี่ยน role) + audit `audit.role_assigned` / `audit.role_revoked` (แอดมินเท่านั้นเห็น เหมือน `audit.%` เดิม) · สมาชิกออกจากก๊วน/ถูกลบ ⇒ ชุดสิทธิ์ถูกลบใน txn เดียวกัน
7. **TypeScript**: `domain/permissions` เพิ่ม `PermissionContext.extra?: readonly Action[]` (สิทธิ์จากชุดสิทธิ์) — `can()` = สิทธิ์ของ role พื้นฐาน **∪** `extra` (feature flag ตรวจก่อนเหมือนเดิม) → **ไม่ breaking**: เรียก `can({ role })` เหมือนเดิมยังได้ผลเดิม · เพิ่ม `lib/supabase/permission-context.ts` ตัวโหลดเดียว `loadPermissionContext(gangId, userId)` คืน `{ role, extra }` แทน `roleInGang` 7 สำเนา (ย้ายทีละไฟล์ ไม่ต้องทำพร้อมกัน — สำเนาเก่ายังทำงานได้แต่จะ "ไม่เห็น" ชุดสิทธิ์ ⇒ **ต้องย้ายก่อนเปิดใช้ (ข้อ 9 ขั้น 4)**) · `domain/` ยังไม่ import supabase/next (กติกาเดิม)
8. **UI**: เมนู/ปุ่มตาม `can()` อยู่แล้ว (`gang-menu.ts`) ⇒ ไม่ต้องแก้ตรรกะเมนู · งาน UI จริงมีแค่ (ก) `MembersPanel.tsx:132` เพิ่มตัวเลือก/ป้ายชุดสิทธิ์ต่อสมาชิก (ข) layout ส่ง `extra` ให้ `buildGangMenu` — เป็น WO ฝั่ง @gb-frontend แยก
9. **ลำดับ expand → migrate → contract (ไม่มีช่วงสิทธิ์หลวมหรือหาย)**
   0. **ถ่ายภาพก่อน**: เขียน `tests/rls/role-matrix.test.ts` (golden) — ทุกตาราง/ที่เก็บ × การกระทำ (select/insert/update/delete) × {owner, admin, member, คนนอก, แอดมินองค์กร} บันทึกผลที่คาดเป็น literal จากระบบปัจจุบัน และต้องผ่านก่อนแตะอะไร
   1. **Expand** (migration เดียว): สร้าง 2 ตาราง + seed 2 preset + `is_delegable_action` + `has_gang_permission` + `actor_has_permission` · **ไม่แก้ policy/function เดิมสักตัว** ⇒ golden ต้องไม่เปลี่ยนแม้แต่ช่องเดียว
   2. **Migrate** (หลาย migration ทีละกลุ่ม ใบละกลุ่มเพื่อให้ QA ไล่ได้): การเงิน (`payments` / `payment_adjustments` / `session_charges` / `payment_slips` storage / `credit_*` / `gang_expenses` / `gang_incomes` / DB function เครดิตทั้งหมด) → การจัดนัด (`sessions` / ตารางผูก session / `registration` functions) → ประกาศ (ถ้า ★ อนุญาต) · แต่ละ migration `drop policy` เก่า + `create policy` ใหม่ (`is_gang_admin(g)` → `has_gang_permission(g,'<action>')`) **ใน transaction เดียวกัน** ⇒ ไม่มีช่วงที่ policy หาย · เพราะ `has_gang_permission ⊇ is_gang_admin` ⇒ **ไม่มีใครเสียสิทธิ์** · ผู้ได้สิทธิ์เพิ่มมีได้เฉพาะผู้ถือชุดสิทธิ์ ซึ่ง **ยังไม่มีใคร** (ขั้น 4 ยังไม่เปิด) ⇒ ไม่มีช่วงสิทธิ์หลวม · หลังแต่ละ migration golden ต้องเท่าเดิม
   3. **TS**: `loadPermissionContext` + `PermissionContext.extra` + ย้าย 7 สำเนา `roleInGang` · ตรวจด้วยเทสต์ "ไม่มี `async function roleInGang` เหลือ" (กันสำเนากลับมา) · ทุก server action ที่ `assertCan` ต้องใช้ context ใหม่
   4. **Enable**: เปิด `assign_gang_role` / `revoke_gang_role` + UI + (★) feature flag ต่อก๊วน — **จุดแรกที่มีผู้ถือชุดสิทธิ์จริง**
   5. **Contract**: ลบการอ้าง `is_gang_admin` ตรงๆ ในกลุ่มที่ migrate แล้วที่ไม่ใช่ admin-only โดยตั้งใจ (ตรวจด้วย `grep` ใน migration ใหม่) · `actor_is_gang_admin` เก็บไว้เป็นฟังก์ชันของ admin-only function (เช่น ตั้ง role) · rollback แต่ละ migration = คืนข้อความ policy เดิม (เก็บเป็นคอมเมนต์)
10. **ผลต่อ privacy**: เหรัญญิกเห็นสลิปและยอดของทุกคนในก๊วน (ตั้งใจ — ต้องใช้ตรวจสลิป) · ไม่เห็นรายชื่อ LINE/คำขอเข้าก๊วน/ตั้งค่า · `event_logs`: เห็นเฉพาะ event `payment.*`/`audit.credit_*`/`audit.payment_*` (★ ข้อ 6 ในตาราง) ไม่ใช่ `audit.%` ทั้งหมด
11. **ไม่ทำในใบนี้**: UI สร้าง/แก้ role เอง (เฟส 2) · role ระดับองค์กร · สิทธิ์ระดับรายนัด · ลบ `gang_members.role` เดิม

- **Consequences**:
  - (+) role พื้นฐาน/กติกา owner/leave/transfer **ไม่เปลี่ยน** ⇒ ความเสี่ยง regression ต่ำ · จ่าย RLS migration ครั้งเดียวแต่รองรับ custom role ในเฟสถัดไปโดยไม่แตะ policy อีก
  - (+) `can()` ยัง pure, backward-compatible; คำศัพท์สิทธิ์ชุดเดียวทั้ง TS/RLS
  - (−) งานจริงใหญ่กว่า baseline คาด: **~24 policy + 9 storage policy + ~13 จุดใน DB function + 7 loader + 81 จุดเรียก** (ดู Context) · ต้องมี role-matrix golden ก่อนเริ่ม
  - (−) สอง "แหล่งความจริง" ชั่วคราวช่วงขั้น 2–3 (บางกลุ่ม migrate แล้ว บางกลุ่มยังไม่) — ควบคุมด้วยการไม่เปิดขั้น 4 จนกว่า TS+DB ครบทุกกลุ่ม
  - (−) ผู้ถือชุดสิทธิ์ของก๊วนหนึ่งที่ DB function ยังเป็น `actor_is_gang_admin` จะ "UI ให้กดแต่ DB ปฏิเสธ" ถ้า migrate ไม่ครบ ⇒ เทสต์ consistency (ข้อ test plan 3) เป็นด่านก่อนเปิด
  - (−) สิทธิ์ดูข้อมูลเพิ่มสำหรับสมาชิกทั่วไป (เหรัญญิกเห็นสลิปทุกคน) เป็นการเปิดข้อมูลส่วนบุคคลเพิ่ม — แจ้งใน UI ตอนแต่งตั้ง

#### Test plan

1. **Golden role-matrix (ก่อน/หลังทุก migration)**: ตาราง/ที่เก็บ × ops × 5 ตัวตน (owner/admin/member/outsider/org-admin) — ผลต้องเท่าเดิมทุกช่อง · รวมใน CI
2. **Preset matrix**: ทุก `Action` × {owner, admin, member, treasurer, scheduler, treasurer+scheduler} — `can()` เทียบ literal (ต่อยอด `tests/domain/can.test.ts`) · และ RLS probe ผ่าน `asRole('authenticated', userId)` ของเหรัญญิก: อ่าน/แก้ `payments`, `payment_adjustments`, `credit_*`, `gang_expenses` ได้ · **เขียน `sessions`, อ่าน `join_requests`, แก้ `gang_members` ไม่ได้** · ผู้จัดคิวกลับกัน
3. **TS ↔ DB ไม่ drift**: สำหรับทุก action ใน `DELEGABLE_ACTIONS` × role/ชุดสิทธิ์ — `can()` ต้องตรงกับ `actor_has_permission()` ใน DB (ถ้าฝั่งใดเพิ่ม action แล้วอีกฝั่งลืม เทสต์แดง) · `is_delegable_action` ต้องตรง `DELEGABLE_ACTIONS` 100%
4. **Escalation**: ใส่ action ที่ห้าม delegate ลง `permissions` ⇒ ถูกปฏิเสธ (CHECK) · ผู้ถือชุดสิทธิ์/สมาชิกทั่วไปเรียก `assign_gang_role` ⇒ FORBIDDEN · admin แต่งตั้งตัวเอง/ข้ามก๊วนไม่ได้ · เขียน `gang_member_roles` ตรงผ่าน PostgREST ไม่ได้ (RLS + grant)
5. **Concurrency (≥20 รอบ)**: แต่งตั้ง/ถอนพร้อมใช้สิทธิ์ (ถอนแล้ว statement ถัดไปใช้ไม่ได้ทันที) · แต่งตั้งแข่ง `leave_gang`/เปลี่ยน role เป็น admin/ลบสมาชิก (ไม่เหลือแถวชุดสิทธิ์ค้างของคนที่ออก) · ไม่มี deadlock (40P01) — ลำดับ lock `gang_members` ก่อนเสมอ
6. **ไม่มีสำเนา `roleInGang`** เหลือ (เทสต์ grep) · server action ทุกตัวที่เคย `assertCan({ role })` ใช้ context ใหม่ (เทสต์เรียก action จริงด้วยเหรัญญิก/ผู้จัดคิว)
7. **Regression**: vitest ทั้งชุดต้องผ่านหลังทุก migration (ไม่ `db reset` — `migration up --local`)
8. **Audit**: `audit.role_assigned/revoked` เขียนครบ · สมาชิกทั่วไปอ่านไม่ได้ (ต่อยอด `tests/rls/event-log-privacy.test.ts`)

#### แตกเป็น WO (เสนอ — ส่ง planner ตัดสินลำดับ)

| WO | เนื้อหา | เจ้าของ | ติด ★ |
|---|---|---|---|
| R-roles-0 | role-matrix golden (เทสต์อย่างเดียว ไม่แตะโค้ด) | @gb-backend (+QA ตรวจ) | — |
| R-roles-1 | Expand: ตาราง + seed + 3 ฟังก์ชัน + `DELEGABLE_ACTIONS` + assign/revoke function (ยังไม่เปิด) | @gb-backend | Q1–Q3 |
| R-roles-2a/2b/2c | Migrate: การเงิน → การจัดนัด → ประกาศ/สถิติ | @gb-backend | Q2, Q6 |
| R-roles-3 | `loadPermissionContext` + `PermissionContext.extra` + ย้าย 7 สำเนา/81 จุด | @gb-backend | — |
| R-roles-4 | Enable: assign/revoke action + feature flag (ถ้ามี) | @gb-backend | Q4, Q5 |
| UI-roles | ป้ายชุดสิทธิ์ใน `MembersPanel` + เมนูตาม `extra` + ข้อความแจ้ง privacy | @gb-frontend | หลัง R-roles-4 |

#### คำถามให้เจ้าของงาน (แผนบอก / ของจริง / ทางเลือก ★)

| # | แผนบอก | ของจริง | ทางเลือก (★ = ที่เสนอ) |
|---|---|---|---|
| Q1 | B13 "บทบาทกำหนดเอง (เหรัญญิก/ผู้จัดคิว)" ขนาด L | role ถูกเช็ค 3 ชั้น ~24 policy + 9 storage + ~13 จุด function + 81 จุด TS (ไม่ใช่โมดูลเดียวตามที่ baseline คาด) · role คอลัมน์เดียวต่อคน | (ก) preset ใน `role` — ถูกสุดแต่ต้องแก้ RLS ชุดเดียวกัน และสองบทบาทพร้อมกันไม่ได้ · (ข) role อิสระเต็มรูป — ยืดหยุ่นสุด ใหญ่สุด เสี่ยงตั้งสิทธิ์ผิด · **(ค) ★ ตารางชุดสิทธิ์ + เปิดแค่ 2 preset ก่อน (หนึ่งคนถือได้หลายชุด)** |
| Q2 | เหรัญญิก = `payment.verify` + `credit.*` + รายงาน · ผู้จัดคิว = session/game manage + check-in | ADR-010 Q3 ตัดสินให้ `credit.topup` (ให้เครดิตฟรี) เฉพาะ admin+owner · `billing.close` สร้างหนี้ทั้งนัด · `gang.pricing.manage` เปลี่ยนสูตรราคา · เทมเพลตนัด (`session_templates`) ผูก admin | เหรัญญิก: (ก) ★ ไม่มี `credit.topup`, ไม่มี `billing.close`, ไม่มี pricing · (ข) เพิ่ม `billing.close` · ผู้จัดคิว: (ก) ★ ไม่รวมเทมเพลต/ประกาศ · (ข) รวม `announcement.manage` + เทมเพลตนัด |
| Q3 | — | ถ้าแยกคอลัมน์ role ต้องเลือกบทบาทเดียว · ชุดสิทธิ์ซ้อนทำให้เป็นทั้งสองบทบาทได้ | (ก) ★ หนึ่งคนถือได้หลายชุด · (ข) หนึ่งชุดต่อคน · และให้เฉพาะ role พื้นฐาน `member` (★) — admin/owner ไม่ต้องมี |
| Q4 | — | ตอนนี้ตั้ง role ต้อง `gang.member.manage` (admin+owner) · เหรัญญิกแตะเงินทั้งก๊วน | ใครแต่งตั้งเหรัญญิก: (ก) ★ admin+owner (ตามสิทธิ์จัดการสมาชิกเดิม) · (ข) owner เท่านั้น (เพราะเกี่ยวกับเงิน) · ผู้ถือชุดสิทธิ์แต่งตั้งต่อ: ★ ไม่ได้ (บังคับเสมอ) |
| Q5 | feature flags ต่อก๊วนมีอยู่ (`line`, `discovery`, `guests`, `coupons`, `statistics`) | `can()` ตรวจ flag ก่อน role (`can.ts:117`) | (ก) ★ ไม่ต้องมี flag — ไม่แต่งตั้งใครก็ไม่มีผล · (ข) เพิ่ม flag `roles` ปิดเป็นค่าเริ่มต้น (ต้องแก้ `FEATURES` + ทุกก๊วนเดิม) |
| Q6 | — | `event_logs` `audit.%` + เรื่องเงินเห็นเฉพาะแอดมิน (`…039:56`) · `member_statistics` แอดมินเห็นทั้งก๊วน (`…031:22`) · `credit_*` แอดมินเห็นทั้งก๊วน | เหรัญญิกเห็น: (ก) ★ event `payment.*`/`audit.credit_*` เท่านั้น + `credit_*` · (ข) event ทั้งหมดแบบแอดมิน (ง่ายกว่า เปิดข้อมูลมากกว่า) · สถิติสมาชิก: ★ ให้ผู้จัดคิวดู (`statistics.view` ทั้งก๊วน) / ไม่ให้ |
| Q7 | — | เฟสแรกเปิดแค่ preset ระบบ แก้ไม่ได้จากแอป | (ก) ★ UI สร้าง/แก้ role เองเป็นเฟส 2 (ตารางพร้อมแล้ว) · (ข) ทำในใบเดียวกัน (ใหญ่ขึ้นมาก + ต้องมี permission editor + catalog UI) |
| Q8 | — | ชื่อ "เหรัญญิก"/"ผู้จัดคิว" เป็น i18n ฝั่ง UI · `key` ใน DB เป็น `treasurer`/`scheduler` | (ก) ★ ชื่อแสดงแก้ได้ต่อก๊วน (เก็บ `name` ต่อแถว) · (ข) ชื่อคงที่จาก i18n |
