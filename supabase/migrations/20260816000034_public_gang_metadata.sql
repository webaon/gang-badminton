-- =============================================================================
-- WO-3.G · 0034 — ปิดการอ่านแถวก๊วน public ของคนนอก (ADR-007)
-- =============================================================================
-- 🔴 ช่องโหว่ที่ปิดในใบนี้ (เจอตอนไล่ policy 0010 ใน WO-3.E)
--
--    `gangs_select_public` (0010) เปิด **ทั้งแถว** ให้ `anon` + `authenticated`
--    เมื่อ `is_public = true` — แต่ RLS กรองได้แค่ "แถว" ไม่ใช่ "คอลัมน์"
--    ⇒ ใครก็ได้ที่ถือ anon key ยิง
--        GET /rest/v1/gangs?select=promptpay_id&is_public=eq.true
--      แล้วได้ **PromptPay ID (เบอร์โทร) ของทุกก๊วนสาธารณะ**
--      พร้อม `settings` / `cancellation_policy` / `features` ทั้งชุด
--
--    discovery (WO-3.E) ทำให้ก๊วนเปิด `is_public` กันมากขึ้น ⇒ ต้องปิดก่อนเปิดใช้จริง
--
-- ✅ ทางออกตาม **ADR-007**: คนนอกอ่านก๊วนได้ทางเดียวคือ `search_public_gangs()`
--    (security definer ที่ประกาศคอลัมน์ที่คืนไว้ชัดเจน) ⇒ เจตนาของ baseline
--    ("ก๊วน public ค้นเจอ") ยังอยู่ครบ เปลี่ยนแค่ **ช่องทาง**
--
-- ⚠️ ตรวจก่อนถอดแล้วว่าทุกจุดที่อ่าน `from('gangs')` ในแอปเป็นการอ่าน
--    **ในฐานะสมาชิก/แอดมินของก๊วนนั้น** ทั้งหมด ⇒ `gangs_select_member` ครอบอยู่แล้ว
--    · `/join/[token]` และหน้า guest ใช้ RPC ที่ grant ให้ `service_role` จึงไม่กระทบ
--
-- ➡️ หน้าโปรไฟล์ก๊วนสาธารณะในอนาคต **ต้องเพิ่ม DB function ที่คืนคอลัมน์ที่เลือกไว้**
--    ❌ ห้ามเปิด policy ให้อ่านตาราง `gangs` ตรงกลับมาอีก
--
-- Rollback (‼️ เปิดช่องโหว่กลับ — อย่าใช้ถ้าไม่ได้ทำ ADR ใหม่):
--   GRANT SELECT ON public.gangs TO anon;
--   CREATE POLICY gangs_select_public ON public.gangs
--     FOR SELECT TO anon, authenticated
--     USING (deleted_at IS NULL AND is_public = true);
-- =============================================================================

drop policy if exists gangs_select_public on public.gangs;

-- `anon` ไม่เหลือเหตุผลให้แตะตารางนี้อีก (ทุกเส้นทางของคนนอกผ่าน security definer function)
revoke select on public.gangs from anon;

comment on column public.gangs.is_public is
  '[ADR-007] "เปิดเผยตัวตน" = โผล่ใน search_public_gangs() ได้ — ไม่ได้แปลว่าอ่านแถวนี้ตรงได้';
