-- =============================================================================
-- WO-1.4 (แก้ตาม) · 0013 — ประกาศ grant matrix ให้ชัด ไม่พึ่ง default ACL
-- =============================================================================
-- 🔴 ปัญหาที่เจอตอน push 0010 ขึ้น cloud
--
-- 0010 ตั้งอยู่บนสมมติฐานว่า "ตารางที่ไม่ได้ grant = anon/authenticated แตะไม่ได้"
-- ซึ่งจริงบน local (default ACL ของ role postgres ใน schema public ให้แค่ `Dxtm`)
-- แต่ **ไม่จริงบน cloud** — ที่นั่น default ACL ให้ `arwdDxtm` ⇒ ตรวจแล้วพบว่า
-- `anon` มี SELECT ระดับตารางบน gang_line_configs / daily_metrics / rate_limits
--
-- ข้อมูลยังไม่รั่ว เพราะสามตารางนั้นเปิด RLS ไว้และ **ไม่มี policy เลย**
-- (ไม่มี policy = ปฏิเสธทุกแถว) — แต่เหลือกำแพงชั้นเดียวแทนที่จะเป็นสองชั้น
-- และที่แย่กว่านั้นคือพฤติกรรมต่างกันระหว่าง local กับ production
-- ⇒ เทสต์ที่ผ่านบนเครื่องพิสูจน์อะไรเกี่ยวกับ production ไม่ได้เลย
--
-- ─────────────────────────────────────────────────────────────────────────────
-- วิธีแก้: เลิกพึ่ง default ACL ทั้งหมด
--
--   1. revoke ทุกอย่างจาก anon/authenticated บนทุกตารางใน public
--   2. grant กลับเฉพาะที่ policy รองรับ (ลอกจาก 0010 ส่วนที่ 4.5 เป๊ะๆ)
--
-- ผลคือ grant matrix กลายเป็น **ของที่ประกาศไว้ในไฟล์นี้** ไม่ใช่ผลพลอยได้ของ
-- environment ⇒ local กับ cloud เหมือนกันเสมอ
--
-- ⚠️ ตารางใหม่ในอนาคตจะได้สิทธิ์ตาม default ACL ของ environment นั้นอีก
--    ⇒ **migration ที่สร้างตารางใหม่ต้อง revoke/grant เองทุกครั้ง**
--    (บันทึกไว้ใน BACKLOG + STATE แล้ว)
--
-- Rollback: ไม่มี — การคืนสิทธิ์ที่กว้างกว่าเดิมไม่ใช่สิ่งที่อยากย้อนกลับไป
--           ถ้าต้องแก้จริง ให้เขียน migration ใหม่ที่ grant เฉพาะสิ่งที่ต้องการ
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ล้างกระดาน
-- -----------------------------------------------------------------------------
-- ไม่แตะ service_role (ต้องใช้ได้ทุกตาราง) และไม่แตะ postgres (owner)
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- -----------------------------------------------------------------------------
-- 2. grant กลับตามที่ policy ใน 0010 รองรับ
-- -----------------------------------------------------------------------------

-- อ่านอย่างเดียว (เขียนผ่าน DB function เท่านั้น — [D-13])
grant select on public.session_registrations to authenticated;
grant select on public.session_charges       to authenticated;
grant select on public.event_logs            to authenticated;
grant select on public.member_statistics     to authenticated;
grant select on public.notification_logs     to authenticated;
grant select on public.payment_allocations   to authenticated;
grant select on public.payment_adjustments   to authenticated;
grant select on public.member_line_links     to authenticated;

-- อ่าน + เขียนบางส่วน
grant select, insert, update         on public.profiles             to authenticated;
grant select, insert, update         on public.organizations        to authenticated;
grant select, insert, delete         on public.organization_members to authenticated;
grant select, insert, update         on public.gangs                to authenticated;
grant select, insert, update         on public.gang_members         to authenticated;
grant select, insert, update         on public.sessions             to authenticated;
grant select, insert, update         on public.payments             to authenticated;
grant select, update                 on public.notifications        to authenticated;
grant select, insert, update         on public.join_requests        to authenticated;

-- ตารางที่แอดมินจัดการเต็ม (policy เป็น FOR ALL)
grant select, insert, update, delete on public.gang_skill_levels     to authenticated;
grant select, insert, update, delete on public.gang_pricing_plans    to authenticated;
grant select, insert, update, delete on public.session_templates     to authenticated;
grant select, insert, update, delete on public.coupons               to authenticated;
grant select, insert, update, delete on public.gang_expenses         to authenticated;
grant select, insert, update, delete on public.gang_incomes          to authenticated;
grant select, insert, update, delete on public.announcements         to authenticated;
grant select, insert, update, delete on public.games                 to authenticated;
grant select, insert, update, delete on public.session_invite_tokens to authenticated;

-- anon เห็นได้อย่างเดียวคือก๊วน public (หน้า discovery) — policy จำกัดแถวไว้แล้ว
grant select on public.gangs to anon;

-- service_role = ฝั่ง server ที่เชื่อถือได้ (ย้ำอีกครั้งเผื่อ environment ไหนไม่ได้ให้)
grant select, insert, update, delete on all tables in schema public to service_role;

-- -----------------------------------------------------------------------------
-- 3. ย้ำว่าตาราง server-only ต้องไม่มีสิทธิ์หลงเหลือ
-- -----------------------------------------------------------------------------
-- ทั้งสามตัวนี้ไม่ได้อยู่ในรายการ grant ด้านบนอยู่แล้ว บรรทัดนี้จึงซ้ำซ้อน
-- แต่เขียนไว้ให้เจตนาชัด และเป็นที่ที่ grep เจอเวลาสงสัยว่า "ทำไมอ่านไม่ได้"
revoke all on public.gang_line_configs from anon, authenticated;
revoke all on public.daily_metrics     from anon, authenticated;
revoke all on public.rate_limits       from anon, authenticated;
