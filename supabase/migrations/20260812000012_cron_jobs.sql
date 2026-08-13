-- =============================================================================
-- WO-1.5 · 0012 — pg_cron jobs (sweep งานที่หลุด)
-- =============================================================================
-- Baseline:
--   §Database Functions — "waitlist เลื่อนอัตโนมัติ (ใน cancel function + cron sweep)"
--   §Database Schema 0005 — "แถวค้าง processing เกิน N นาที ถูก sweep กลับเป็น pending (pg_cron)"
--   §Database Schema 0005 — "[v3.1] retry exponential backoff ผ่าน next_retry_at
--                            (5 นาที → 15 นาที → 1 ชม.) เกิน 3 ครั้ง = failed ถาวร"
--
-- 🔴 กติกาที่ห้ามลืม (CLAUDE.md §2.1):
--    "cron sweep มีไว้กันงานหลุด **ไม่ใช่กันชน**"
--    ⇒ sweep ห้ามมี logic ตัดสินใจของตัวเอง ต้องเรียก DB function เดิมที่ถือ lock อยู่แล้ว
--      ถ้า sweep ไปนับที่ว่างเองจะกลายเป็นทางที่สองที่ overbook ได้
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Deviation note
--
--   D-16 เพิ่มฟังก์ชัน sweep 3 ตัวที่ไม่อยู่ในลิสต์ของ baseline
--        (sweep_waitlist / sweep_stuck_notifications / purge_rate_limits)
--        baseline พูดถึง "cron sweep" ในเชิงพฤติกรรมแต่ไม่ได้ตั้งชื่อฟังก์ชันไว้
--        ทั้งสามตัวเป็น "ตัวเรียก" ล้วนๆ ไม่มี business logic ของตัวเอง
--
-- Rollback: select cron.unschedule('gang-badminton-waitlist-sweep');
--           select cron.unschedule('gang-badminton-notification-sweep');
--           select cron.unschedule('gang-badminton-rate-limits-purge');
--           DROP FUNCTION public.sweep_waitlist(), public.sweep_stuck_notifications(interval),
--                         public.purge_rate_limits(interval);
--           (ไม่ DROP EXTENSION pg_cron — อาจมี job ของงานอื่นใช้อยู่)
-- =============================================================================

create extension if not exists pg_cron;


-- -----------------------------------------------------------------------------
-- sweep_waitlist() → จำนวนคนที่ถูกเลื่อนขึ้นทั้งหมด
-- -----------------------------------------------------------------------------
-- ตาข่ายรองรับกรณีที่ promote ใน cancel_registration() ไม่ได้ทำงาน
-- (เช่น transaction ล้มหลัง cancel สำเร็จ หรือมีที่ว่างจากทางอื่น เช่น mark no_show)
--
-- ⚠️ ไม่ตัดสินใจเองแม้แต่นิดเดียว — แค่หา session ที่ "น่าจะมีที่ว่าง" แล้วส่งต่อให้
--    promote_waitlist() ซึ่งจะ lock แถว session แล้วนับใหม่เองอีกรอบ
--    เงื่อนไขที่กรองตรงนี้เป็นแค่ตัวลดจำนวน session ที่ต้องเรียก ไม่ใช่การตัดสิน
create or replace function public.sweep_waitlist()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_promoted   integer;
  v_total      integer := 0;
begin
  for v_session_id in
    select s.id
      from public.sessions s
     where s.status     = 'open'
       and s.deleted_at is null
       and exists (
         select 1
           from public.session_registrations r
          where r.session_id = s.id
            and r.status     = 'waitlist'
            and r.deleted_at is null
       )
       and public.session_occupied_seats(s.id) < s.max_players
     order by s.starts_at
  loop
    select count(*)
      into v_promoted
      from public.promote_waitlist(v_session_id, null, null, 'cron:sweep_waitlist');

    v_total := v_total + v_promoted;
  end loop;

  return v_total;
end;
$$;

comment on function public.sweep_waitlist() is
  '[D-16] ตาข่ายกันคิวหลุด — เรียก promote_waitlist() เท่านั้น ห้ามนับที่ว่างเอง';


-- -----------------------------------------------------------------------------
-- sweep_stuck_notifications(stale) → จำนวนแถวที่ถูกกู้
-- -----------------------------------------------------------------------------
-- worker ที่ claim แล้วตายกลางทางจะทิ้งแถวค้างสถานะ processing ไว้ตลอดกาล
-- (claim_notifications ใช้ SKIP LOCKED ⇒ ไม่มีใครหยิบซ้ำได้อีก)
--
-- backoff ตาม baseline [v3.1]: attempt 1 → 5 นาที · 2 → 15 นาที · 3 → 1 ชม.
-- เกิน 3 ครั้ง = failed ถาวร (ไม่ปล่อยให้วนไม่รู้จบ)
create or replace function public.sweep_stuck_notifications(
  p_stale interval default '10 minutes'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with recovered as (
    update public.notifications n
       set status = case when n.attempt >= 3 then 'failed' else 'pending' end,
           next_retry_at = case n.attempt
                             when 1 then now() + interval '5 minutes'
                             when 2 then now() + interval '15 minutes'
                             else        now() + interval '1 hour'
                           end,
           claimed_at = null,
           last_error = coalesce(
             n.last_error,
             'worker timeout — sweep คืนคิวหลังค้าง processing เกิน ' || p_stale::text
           )
     where n.status     = 'processing'
       and n.claimed_at < now() - p_stale
    returning 1
  )
  select count(*)::integer into v_count from recovered;

  return v_count;
end;
$$;

comment on function public.sweep_stuck_notifications(interval) is
  '[D-16] คืนคิวแถวที่ worker ตายทิ้งไว้ + backoff 5น/15น/1ชม · เกิน 3 ครั้ง = failed ถาวร';


-- -----------------------------------------------------------------------------
-- purge_rate_limits(older_than) → จำนวนแถวที่ลบ
-- -----------------------------------------------------------------------------
-- rate_limits เป็น unlogged table ที่โตขึ้นเรื่อยๆ ตาม key ที่เคยถูกใช้
-- แถวที่หน้าต่างหมดอายุไปนานแล้วไม่มีความหมายอีก
create or replace function public.purge_rate_limits(
  p_older_than interval default '1 day'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with removed as (
    delete from public.rate_limits
     where window_start < now() - p_older_than
    returning 1
  )
  select count(*)::integer into v_count from removed;

  return v_count;
end;
$$;

comment on function public.purge_rate_limits(interval) is
  '[D-16] กวาดแถว rate_limits ที่หมดอายุแล้ว';


-- -----------------------------------------------------------------------------
-- EXECUTE grants — ยึดกติกาเดียวกับ WO-1.4 (server-side เท่านั้น)
-- -----------------------------------------------------------------------------
revoke execute on function public.sweep_waitlist()                      from public, anon, authenticated;
revoke execute on function public.sweep_stuck_notifications(interval)   from public, anon, authenticated;
revoke execute on function public.purge_rate_limits(interval)           from public, anon, authenticated;

grant execute on function public.sweep_waitlist()                       to service_role;
grant execute on function public.sweep_stuck_notifications(interval)    to service_role;
grant execute on function public.purge_rate_limits(interval)            to service_role;


-- -----------------------------------------------------------------------------
-- ตารางเวลา
-- -----------------------------------------------------------------------------
-- cron.schedule() ใช้ชื่อ job เป็น key ⇒ เรียกซ้ำ = อัปเดตตารางเวลาเดิม ไม่สร้างซ้ำ
--
-- ⚠️ job รันด้วยสิทธิ์ของ role ที่ schedule (postgres) ⇒ bypass RLS ตามที่ควรเป็น
-- ⚠️ เวลาทั้งหมดเป็น UTC — pg_cron ไม่สนใจ gangs.timezone
--    งานพวกนี้เป็นงาน "กวาด" ที่ไม่ผูกกับเวลาท้องถิ่น จึงไม่มีปัญหา
--    แต่ถ้าวันหนึ่งมี job ที่ต้องรันตามเวลาไทย (เช่นสรุปยอดสิ้นวัน) ต้องแปลงเอง
select cron.schedule(
  'gang-badminton-waitlist-sweep',
  '*/5 * * * *',
  $$select public.sweep_waitlist()$$
);

select cron.schedule(
  'gang-badminton-notification-sweep',
  '*/5 * * * *',
  $$select public.sweep_stuck_notifications()$$
);

select cron.schedule(
  'gang-badminton-rate-limits-purge',
  '0 4 * * *',
  $$select public.purge_rate_limits()$$
);
