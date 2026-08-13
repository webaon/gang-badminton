-- =============================================================================
-- WO-2.5 · 0018 — เปิด realtime ให้ตารางที่หน้าจอต้อง sync สด
-- =============================================================================
-- baseline §การตัดสินใจสะสม (Realtime ชนเพดาน free tier):
--   "opt-in เฉพาะหน้า game day console + waitlist, degrade เป็น polling ทุก 10 วิอัตโนมัติ"
--
-- ⇒ เปิดเฉพาะ `session_registrations` (กระดานคิว/waitlist) ตัวเดียว
--   ไม่เปิดทั้งฐานข้อมูล เพราะทุกตารางที่อยู่ใน publication กิน quota ของ free tier
--
-- 🔴 realtime เคารพ RLS — สมาชิกก๊วนอื่นจะไม่ได้รับ event ของนัดที่ตัวเองมองไม่เห็น
--    (policy `session_registrations_select` เป็นตัวกรอง)
--
-- ⚠️ realtime เป็น "ของแถม" ไม่ใช่ของที่ระบบพึ่งพา — หน้าจอต้องทำงานได้ด้วย polling
--    ถ้า realtime ต่อไม่ติด (ดู lib/sync/fallback.ts)
--
-- Rollback: ALTER PUBLICATION supabase_realtime DROP TABLE public.session_registrations;
-- =============================================================================

do $$
begin
  -- publication อาจมีตารางนี้อยู่แล้วถ้ารัน migration ซ้ำ — เช็คก่อนเพื่อไม่ให้ล้ม
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'session_registrations'
  ) then
    alter publication supabase_realtime add table public.session_registrations;
  end if;
end
$$;
