-- =============================================================================
-- WO-5.D · 0039 — รัด policy อ่านที่ค้างมาตั้งแต่ Phase 3 (`BACKLOG.md`)
-- =============================================================================
-- 🔴 (1) `event_logs` — สมาชิกทั่วไปอ่าน **payload ดิบ** ของ event เรื่องเงินได้
--
--    WO-3.C ตัดสินไว้ว่า event ที่มี "ยอดเงินรายคน" เป็น `adminOnly` แล้วกรองที่
--    `domain/reports/timeline.ts` — แต่ **นั่นกรองแค่หน้าจอ** ใครยิง PostgREST ตรง
--    (`GET /rest/v1/event_logs?gang_id=eq.…`) ก็อ่าน payload ได้ทั้งหมดอยู่ดี
--    ⇒ ย้ายกติกาเดียวกันมาไว้ที่ **RLS** ให้เป็นด่านจริง
--
-- 🔴 (2) `payment_adjustments` — เดิมแอดมินเท่านั้นที่อ่านได้
--    ⇒ **คนที่ถูกคืนเงินดูรายการคืนเงินของตัวเองไม่ได้** ซึ่งขัดสามัญสำนึกเรื่องเงิน
--    (WO-2.5-D บันทึกไว้ว่า refund กระทบยอดของ "คนนั้น" โดยตรง)
--
-- ⚠️ `coupons` **ไม่แก้ในใบนี้** — ตรวจ schema แล้วคูปองผูกกับ **ก๊วน** ไม่ใช่รายคน
--    (`gang_id` + `code` ไม่มีคอลัมน์เจ้าของ) ⇒ สมาชิกเห็นโค้ดของก๊วนตัวเองเป็นเรื่องปกติ
--    และการเขียนเป็นของแอดมินอยู่แล้ว · ถ้าวันหนึ่งมีคูปองรายคน **ต้องกลับมารัด policy ก่อนเปิดใช้**
--
-- Rollback:
--   DROP POLICY event_logs_select_member ON public.event_logs;
--   CREATE POLICY event_logs_select_member ON public.event_logs FOR SELECT TO authenticated
--     USING (gang_id IS NOT NULL AND (SELECT public.is_gang_member(gang_id)));
--   DROP POLICY payment_adjustments_select ON public.payment_adjustments;
--   CREATE POLICY payment_adjustments_select ON public.payment_adjustments FOR SELECT TO authenticated
--     USING (EXISTS (SELECT 1 FROM public.session_charges sc
--                     WHERE sc.id = session_charge_id AND (SELECT public.is_gang_admin(sc.gang_id))));
--   DROP FUNCTION public.event_type_is_admin_only(text);
-- =============================================================================


-- -----------------------------------------------------------------------------
-- event_type_is_admin_only(text) — กติกาเดียวกับ `adminOnly` ใน timeline
-- -----------------------------------------------------------------------------
-- 🔴 **ต้องตรงกับ `domain/reports/timeline.ts`** — มีเทสต์ที่อ่าน descriptor ฝั่ง domain
--    แล้วยิงจริงผ่าน RLS เพื่อยืนยันว่าสองที่ไม่เบี่ยงจากกัน (`tests/rls/event-log-privacy`)
--
-- `immutable` เพื่อให้ planner ใช้ใน policy ได้โดยไม่เรียกซ้ำต่อแถวมากเกินจำเป็น
create or replace function public.event_type_is_admin_only(p_event_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_event_type like 'payment.%'
      -- audit.* เก็บ before/after ของการแก้ข้อมูล = ข้อมูลภายในเสมอ
      or p_event_type like 'audit.%'
      or p_event_type in ('session.charges_committed', 'membership.fees_generated');
$$;

comment on function public.event_type_is_admin_only(text) is
  '[WO-5.D] event ที่มียอดเงินรายคน — สมาชิกทั่วไปอ่านไม่ได้ (ตรงกับ adminOnly ใน timeline)';


drop policy if exists event_logs_select_member on public.event_logs;

create policy event_logs_select_member on public.event_logs
  for select to authenticated
  using (
    gang_id is not null
    and (
      (select public.is_gang_admin(gang_id))
      or (
        (select public.is_gang_member(gang_id))
        and not public.event_type_is_admin_only(event_type)
      )
    )
  );


-- -----------------------------------------------------------------------------
-- payment_adjustments — เจ้าของหนี้เห็นรายการของตัวเองได้
-- -----------------------------------------------------------------------------
drop policy if exists payment_adjustments_select on public.payment_adjustments;

create policy payment_adjustments_select on public.payment_adjustments
  for select to authenticated
  using (
    exists (
      select 1
        from public.session_charges sc
       where sc.id = payment_adjustments.session_charge_id
         and (
           (select public.is_gang_admin(sc.gang_id))
           -- หนี้ของนัด: เจ้าของคือคนที่ลงชื่อในนัดนั้น
           or exists (
             select 1 from public.session_registrations r
              where r.id = sc.registration_id
                and r.user_id = (select auth.uid())
           )
           -- ค่าสมาชิกรายเดือน: เจ้าของคือสมาชิกคนนั้น
           or exists (
             select 1 from public.gang_members gm
              where gm.id = sc.gang_member_id
                and gm.user_id = (select auth.uid())
           )
         )
    )
  );

comment on policy payment_adjustments_select on public.payment_adjustments is
  '[WO-5.D] แอดมินเห็นทั้งก๊วน · คนอื่นเห็นเฉพาะรายการที่ผูกกับหนี้ของตัวเอง';
