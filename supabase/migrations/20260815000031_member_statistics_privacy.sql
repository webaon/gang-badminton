-- =============================================================================
-- WO-3.C · 0031 — สถิติสมาชิก: เห็นของตัวเอง แอดมินเห็นทั้งก๊วน
-- =============================================================================
-- 🔴 policy เดิม (0010) ให้ **สมาชิกทุกคนอ่าน `member_statistics` ทั้งก๊วน**
--    ซึ่งรวม `total_paid` = ยอดเงินที่แต่ละคนจ่ายสะสม
--
--    ขัดกับกติกาที่ตั้งไว้ตั้งแต่ WO-2.9 (`payments`): **"สมาชิกคนอื่นในก๊วนเดียวกัน
--    ไม่ควรเห็นยอดหนี้ของเพื่อน"** — ถ้าปิดทางหนึ่งแต่เปิดอีกทาง เท่ากับไม่ได้ปิด
--
--    baseline §โมดูล ข้อ 7 ก็เขียนไว้ว่า "สมาชิกเห็นสถิติตัวเอง แอดมินเห็นภาพรวมก๊วน"
--
-- ⚠️ ตอนแก้ policy ต้อง DROP ก่อนแล้ว CREATE ใหม่ — Postgres ไม่มี `create or replace policy`
--
-- Rollback: DROP POLICY member_statistics_select ON public.member_statistics;
--           CREATE POLICY member_statistics_select ON public.member_statistics
--             FOR SELECT TO authenticated
--             USING ((SELECT public.is_gang_member(gang_id)));
-- =============================================================================

drop policy if exists member_statistics_select on public.member_statistics;

create policy member_statistics_select on public.member_statistics
  for select to authenticated
  using (
    -- แถวของตัวเอง (ผูกผ่าน gang_members เพราะตารางนี้ชี้ที่ gang_member_id)
    exists (
      select 1
        from public.gang_members m
       where m.id = member_statistics.gang_member_id
         and m.user_id = (select auth.uid())
         and m.deleted_at is null
    )
    -- หรือเป็นแอดมินของก๊วนนั้น
    or (select public.is_gang_admin(gang_id))
  );

comment on table public.member_statistics is
  '[WO-3.A] rollup รายคืน — UI อ่านจากตารางนี้เป็นแหล่งเดียว · [WO-3.C] สมาชิกเห็นเฉพาะแถวของตัวเอง';
