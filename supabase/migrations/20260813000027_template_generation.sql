-- =============================================================================
-- WO-2.5-E · 0027 — นัดที่ generate จาก template ต้องไม่ซ้ำ
-- =============================================================================
-- baseline §Verification (Job tests): "รันซ้ำไม่ generate นัดซ้ำ"
--
-- 🔴 ทำไมต้องกันที่ระดับฐานข้อมูล ไม่ใช่แค่เช็คในโค้ด
--    cron กับปุ่ม "สร้างล่วงหน้าเลย" ของแอดมินยิงพร้อมกันได้ ⇒ check-then-act ใน TS
--    จะผ่านทั้งคู่แล้วได้นัดซ้ำสองใบ (CLAUDE.md §2.1)
--
-- ⚠️ **Deviation จาก CLAUDE.md §2.6** ("unique บนตาราง soft delete = partial
--    unique index ที่กรอง deleted_at is null เสมอ")
--    ที่นี่ **จงใจไม่กรอง `deleted_at`** เพราะตัวตนของนัดที่ generate คือ
--    "template ใบนี้ + เวลานี้" ⇒ ถ้ากรอง แอดมินที่ลบนัดที่งดเล่นทิ้ง
--    จะโดน cron สร้างกลับมาใหม่ในอีกไม่กี่นาที
--    การลบต้อง "ติดทน" — ถ้าอยากได้คืนให้สร้างนัดเองหรือปิด/เปิด template
--
-- Rollback: DROP INDEX public.sessions_template_slot_key;
-- =============================================================================

create unique index sessions_template_slot_key
  on public.sessions (template_id, starts_at)
  where template_id is not null;

comment on index public.sessions_template_slot_key is
  '[WO-2.5-E] idempotency ของ cron generate — จงใจไม่กรอง deleted_at เพื่อไม่ให้นัดที่ถูกลบถูกสร้างกลับ';
