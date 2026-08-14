-- =============================================================================
-- WO-3.A · 0030 — Rollup: member_statistics + daily_metrics
-- =============================================================================
-- baseline §ตาราง: "`member_statistics` — UI อ่านจากตารางนี้ **เป็นแหล่งเดียว
-- สำหรับการแสดงผล**" ⇒ ทุกหน้าจอสถิติของ Phase 3 อ่านจากที่นี่
--
-- 🔴 idempotent: คำนวณ**ใหม่ทั้งก้อน**แล้ว upsert
--    ❌ ห้าม `insert ... select` ที่บวกทับของเดิม — รันซ้ำแล้วยอดจะทวีคูณ
--
-- 🔴 เงินนับจาก **ledger** ไม่ใช่ผลรวม `session_charges` ดิบ
--    และไม่อิง `sessions.status` (baseline v3.3: นัดที่ยกเลิกกลางคันแต่มี charges
--    ก็เข้ารายงานปกติ)
--
-- ⚠️ นิยามที่ตรึงไว้ที่นี่ที่เดียว — หน้าจอห้ามนิยามเอง
--    · attended_count   = จำนวนครั้งที่สถานะจบลงที่ `checked_in`
--    · games_count      = จำนวนเกมที่ชื่ออยู่ในสี่ช่องของ `games`
--    · shuttles_used    = **ส่วนแบ่ง** ลูกของเกมที่ลง (`shuttles_used / 4`)
--                         ⇒ ผลรวมของทุกคนเท่ากับลูกที่ใช้จริงของก๊วน ไม่ใช่ 4 เท่า
--    · total_paid       = เงินที่จ่ายจริงสุทธิ = allocation ของสลิปที่ `verified`
--                         **หัก** refund (คืนเงินสดจริง)
--                         ⚠️ `credit` / `correction` ไม่นับ เพราะไม่ใช่การเคลื่อนเงินสด
--    · attendance_rate  = `attended / นัดที่เคยได้ที่` × 100
--                         **ตัวหารคือนัดที่ลงชื่อแล้วได้ที่** (`checked_in|confirmed|no_show`)
--                         ไม่ใช่นัดทั้งหมดของก๊วน และไม่นับนัดที่ยกเลิกทันกำหนด
--
-- Rollback: select cron.unschedule('gang-badminton-rollup');
--           DROP FUNCTION public.run_rollup(date), public.rollup_daily_metrics(date),
--                         public.rollup_member_statistics(uuid);
-- =============================================================================

-- -----------------------------------------------------------------------------
-- rollup_member_statistics(gang_id) — ไม่ระบุก๊วน = ทุกก๊วนที่เปิด features.statistics
-- -----------------------------------------------------------------------------
create or replace function public.rollup_member_statistics(p_gang_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with target_gangs as (
    select g.id
      from public.gangs g
     where g.deleted_at is null
       -- 🔴 เคารพ feature flag ฝั่ง server (CLAUDE.md §3) — ก๊วนที่ปิดสถิติไม่ต้อง rollup
       and coalesce((g.features ->> 'statistics')::boolean, true)
       and (p_gang_id is null or g.id = p_gang_id)
  ),
  members as (
    select m.id as gang_member_id, m.gang_id, m.user_id
      from public.gang_members m
      join target_gangs tg on tg.id = m.gang_id
     where m.deleted_at is null
  ),
  -- การลงชื่อของสมาชิกแต่ละคน (ผูกด้วย user_id เพราะ registration ไม่ได้ชี้ gang_member)
  regs as (
    select mb.gang_member_id,
           r.id as registration_id,
           r.status
      from members mb
      join public.sessions s            on s.gang_id = mb.gang_id and s.deleted_at is null
      join public.session_registrations r on r.session_id = s.id
                                         and r.user_id = mb.user_id
                                         and r.deleted_at is null
  ),
  attendance as (
    select gang_member_id,
           count(*) filter (where status = 'checked_in')                         as attended_count,
           count(*) filter (where status in ('checked_in', 'confirmed', 'no_show')) as seats_held
      from regs
     group by gang_member_id
  ),
  game_play as (
    select rg.gang_member_id,
           count(*)                                        as games_count,
           coalesce(sum(g.shuttles_used) / 4, 0)           as shuttles_used
      from regs rg
      join public.games g
        on rg.registration_id in (g.player1_registration_id, g.player2_registration_id,
                                  g.player3_registration_id, g.player4_registration_id)
     group by rg.gang_member_id
  ),
  paid as (
    select rg.gang_member_id,
           coalesce(sum(alloc.amount), 0) - coalesce(sum(refund.amount), 0) as total_paid
      from regs rg
      join public.session_charges c on c.registration_id = rg.registration_id
      left join lateral (
        select coalesce(sum(a.amount), 0) as amount
          from public.payment_allocations a
          join public.payments p on p.id = a.payment_id
         where a.session_charge_id = c.id
           and p.status = 'verified'
           and p.deleted_at is null
      ) alloc on true
      left join lateral (
        select coalesce(-sum(j.amount), 0) as amount
          from public.payment_adjustments j
         where j.session_charge_id = c.id
           and j.type = 'refund'
      ) refund on true
     group by rg.gang_member_id
  ),
  computed as (
    select mb.gang_id,
           mb.gang_member_id,
           coalesce(a.attended_count, 0)                                as attended_count,
           coalesce(gp.games_count, 0)                                  as games_count,
           coalesce(gp.shuttles_used, 0)                                as shuttles_used,
           coalesce(pd.total_paid, 0)                                   as total_paid,
           case when coalesce(a.seats_held, 0) = 0 then 0
                else round(coalesce(a.attended_count, 0)::numeric * 100 / a.seats_held, 2)
           end                                                          as attendance_rate
      from members mb
      left join attendance a  on a.gang_member_id  = mb.gang_member_id
      left join game_play gp  on gp.gang_member_id = mb.gang_member_id
      left join paid pd       on pd.gang_member_id = mb.gang_member_id
  ),
  upserted as (
    insert into public.member_statistics
      (gang_id, gang_member_id, attended_count, games_count, shuttles_used,
       total_paid, attendance_rate, computed_at)
    select gang_id, gang_member_id, attended_count, games_count, shuttles_used,
           total_paid, attendance_rate, now()
      from computed
    on conflict (gang_member_id) do update
      set gang_id         = excluded.gang_id,
          attended_count  = excluded.attended_count,
          games_count     = excluded.games_count,
          shuttles_used   = excluded.shuttles_used,
          total_paid      = excluded.total_paid,
          attendance_rate = excluded.attendance_rate,
          computed_at     = excluded.computed_at
    returning 1
  )
  select count(*)::integer into v_count from upserted;

  return v_count;
end;
$$;

comment on function public.rollup_member_statistics(uuid) is
  '[WO-3.A] คำนวณสถิติสมาชิกใหม่ทั้งก้อนแล้ว upsert — idempotent · เงินนับจาก ledger';


-- -----------------------------------------------------------------------------
-- rollup_daily_metrics(date) — ตัวเลขระดับแพลตฟอร์มของหนึ่งวัน
-- -----------------------------------------------------------------------------
-- ⚠️ "วัน" ใช้นาฬิกาไทย (`Asia/Bangkok`) เพราะเป็นตัวเลขระดับแพลตฟอร์ม
--    ไม่ใช่ของก๊วนใดก๊วนหนึ่ง ⇒ ใช้ timezone ของก๊วนไม่ได้
create or replace function public.rollup_daily_metrics(p_date date default null)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Bangkok')::date);
begin
  insert into public.daily_metrics (metric_date, new_members, games_played, sessions_held, revenue)
  select
    v_date,
    (select count(*) from public.profiles p
      where (p.created_at at time zone 'Asia/Bangkok')::date = v_date),
    (select count(*) from public.games g
      where (coalesce(g.started_at, g.created_at) at time zone 'Asia/Bangkok')::date = v_date),
    (select count(*) from public.sessions s
      where (s.starts_at at time zone 'Asia/Bangkok')::date = v_date
        and s.deleted_at is null
        and s.status <> 'draft'),
    -- 🔴 รายรับนับจาก charges ที่เกิดขึ้นวันนั้น **ไม่อิง sessions.status**
    --    ⇒ นัดที่ยกเลิกกลางคันแต่มี charges ก็เข้ารายงาน (baseline v3.3)
    (select coalesce(sum(c.amount), 0) from public.session_charges c
      where (c.created_at at time zone 'Asia/Bangkok')::date = v_date)
  on conflict (metric_date) do update
    set new_members   = excluded.new_members,
        games_played  = excluded.games_played,
        sessions_held = excluded.sessions_held,
        revenue       = excluded.revenue,
        updated_at    = now();

  return v_date;
end;
$$;

comment on function public.rollup_daily_metrics(date) is
  '[WO-3.A] ตัวเลขระดับแพลตฟอร์มต่อวัน (นาฬิกาไทย) — upsert ต่อ metric_date จึง idempotent';


-- -----------------------------------------------------------------------------
-- run_rollup(date) — งานของ cron: ทำทั้งสองอย่างในรอบเดียว
-- -----------------------------------------------------------------------------
create or replace function public.run_rollup(p_date date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_members integer;
  v_date    date;
begin
  v_members := public.rollup_member_statistics(null);
  v_date    := public.rollup_daily_metrics(p_date);

  -- ⚠️ ไม่ผูกกับก๊วนใด ⇒ ไม่เขียน event_logs (ตารางนั้น gang_id not null)
  --    ผลลัพธ์ดูได้จาก `member_statistics.computed_at` และ `daily_metrics.updated_at`
  raise notice 'rollup: % members, date %', v_members, v_date;

  return v_members;
end;
$$;

comment on function public.run_rollup(date) is
  '[WO-3.A] งาน rollup รายคืน — คืนจำนวนแถวสถิติสมาชิกที่คำนวณใหม่';


revoke execute on function public.rollup_member_statistics(uuid) from public, anon, authenticated;
revoke execute on function public.rollup_daily_metrics(date)     from public, anon, authenticated;
revoke execute on function public.run_rollup(date)               from public, anon, authenticated;

grant execute on function public.rollup_member_statistics(uuid) to service_role;
grant execute on function public.rollup_daily_metrics(date)     to service_role;
grant execute on function public.run_rollup(date)               to service_role;


-- pg_cron: ตี 2 ตามเวลาไทย = 19:00 UTC ของวันก่อนหน้า
-- ⚠️ pg_cron ใช้ UTC เสมอ (ดูคอมเมนต์ใน 0012) ⇒ แปลงเองตรงนี้
select cron.schedule(
  'gang-badminton-rollup',
  '0 19 * * *',
  $$select public.run_rollup()$$
);
