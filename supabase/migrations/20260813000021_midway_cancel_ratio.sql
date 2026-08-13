-- =============================================================================
-- ADR-004 · 0021 — เพิ่ม midway_cancel_ratio เข้า default ของ cancellation_policy
-- =============================================================================
-- ก๊วนตั้งสัดส่วนที่เก็บเมื่อยกเลิกกลางคันเองได้ (แอดมินยังแก้ได้อีกทีตอนกดยกเลิก)
--
-- ⚠️ **ไม่ backfill แถวเดิม** โดยตั้งใจ
--    `fromJson()` เติมค่า fallback 0.5 ให้อยู่แล้วเมื่อคีย์หายไป (ADR-004)
--    ⇒ ก๊วน/นัดที่มีอยู่ได้พฤติกรรมเดิมเป๊ะ และไม่ต้องแตะ snapshot ที่แช่แข็งไปแล้ว
--      ซึ่งเป็นสิ่งที่ baseline §Snapshot rule ห้ามอยู่แล้ว
--
-- Rollback: ALTER TABLE public.gangs ALTER COLUMN cancellation_policy SET DEFAULT
--           '{"cutoff_hours": 12, "allow_cancel_after_cutoff": true, "penalty_type": "full_share"}'::jsonb;
-- =============================================================================

alter table public.gangs
  alter column cancellation_policy
  set default '{"cutoff_hours": 12, "allow_cancel_after_cutoff": true, "penalty_type": "full_share", "midway_cancel_ratio": 0.5}'::jsonb;

comment on column public.gangs.cancellation_policy is
  'ADR-002/004 schema: { cutoff_hours, allow_cancel_after_cutoff, penalty_type, penalty_value?, midway_cancel_ratio } — snapshot ลง session ตอนสร้างนัด ห้ามอ่านค่านี้ตอนคิดเงิน';
