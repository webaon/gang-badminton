-- =============================================================================
-- WO-B11 · 0041 — สละสิทธิ์หลังถูกเลื่อนคิว (grace) + แอดมินเลื่อน/ยกเลิกแทนแบบไม่คิดค่าปรับ (ADR-011)
-- =============================================================================
-- ปัญหา: คนที่ถูกเลื่อนจาก waitlist ตอนใกล้นัด (เลย cutoff แล้ว) ยกเลิกทีไรโดนนับเป็น "ยกเลิกช้า"
--        ทั้งที่เพิ่งรู้ว่าได้ที่ · แอดมินก็เลือกเลื่อนคนเอง / เปลี่ยนคนแบบไม่คิดค่าปรับไม่ได้
--
-- 🔴 สิ่งที่ "ไม่ทำ" (ADR-011 / CLAUDE.md §2.2)
--   - ไม่มี status ใหม่ · ไม่มี `confirmed → waitlist` · ไม่มีทางเลื่อนคิวทางที่สอง
--     (ทุกการเลื่อนยังผ่าน promote_waitlist() ตัวเดียว — แค่รับ p_registration_id ได้)
--   - ไม่ย้าย billing ลง SQL (ADR-001) — SQL ตัดสิน "ยกเว้นหรือไม่" แล้วบันทึกเป็นข้อเท็จจริง
--     TS billing อ่านผลนั้นไปคิดเงิน
--
-- 🔴 ข้อค้นพบตอนทำ (บันทึกเป็น deviation ใน ADR-011)
--   ร่าง ADR บอก "ตัดสินใน cancel_registration() แล้วบันทึกลง event" แต่ของจริง**ไม่มีใครอ่าน
--   event ตอนคิดเงิน/ความน่าเชื่อถือ** — `member_reliability()` (SQL) และ `isLateCancel()` (TS billing)
--   ต่างคำนวณจาก `cancelled_at` เทียบ cutoff ใน snapshot ⇒ บันทึกลง event อย่างเดียวจะไม่มีผลกับเงิน
--   จึงเพิ่มข้อเท็จจริงลง **คอลัมน์** ของ session_registrations (ไม่ใช่ state ใหม่):
--     - promoted_at   : เวลาที่ถูกเลื่อนจาก waitlist (ใช้ตัดสิน grace)
--     - cancel_waiver : 'promoted_grace' | 'admin' | null — ยกเลิกแบบได้รับการยกเว้นค่าปรับ
--   ทั้งสองคอลัมน์เขียนได้จาก DB function เท่านั้น (authenticated มีแค่ SELECT บนตารางนี้)
--
-- Rollback:
--   -- คืนฟังก์ชันเวอร์ชัน 0009 (promote_waitlist 4 พารามิเตอร์ / cancel_registration 3 พารามิเตอร์ /
--   -- member_reliability เดิม) แล้ว:
--   DROP FUNCTION public.actor_is_gang_admin(uuid, uuid);
--   ALTER TABLE public.session_registrations DROP COLUMN cancel_waiver, DROP COLUMN promoted_at;
-- =============================================================================


-- -----------------------------------------------------------------------------
-- คอลัมน์ข้อเท็จจริง (expand — additive ล้วน, แถวเก่าเป็น null = พฤติกรรมเดิม)
-- -----------------------------------------------------------------------------
alter table public.session_registrations
  add column promoted_at   timestamptz,
  add column cancel_waiver text;

alter table public.session_registrations
  add constraint session_registrations_cancel_waiver_check
  check (cancel_waiver is null or cancel_waiver in ('promoted_grace', 'admin'));

comment on column public.session_registrations.promoted_at is
  '[ADR-011] เวลาที่ถูกเลื่อนจาก waitlist → confirmed (promote_waitlist เป็นคนเขียน) · null = ไม่เคยถูกเลื่อน/ถูกเลื่อนก่อน 0041';
comment on column public.session_registrations.cancel_waiver is
  '[ADR-011] ยกเลิกแบบได้รับการยกเว้นค่าปรับ: promoted_grace = สละสิทธิ์ภายใน grace หลังถูกเลื่อน · admin = แอดมินยกเลิกแทนและเลือกไม่คิดค่าปรับ · null = ไม่ได้รับ';

-- default ของก๊วนใหม่ (แนวเดียวกับ 0021/ADR-004) — ก๊วนเดิมที่ไม่มีคีย์นี้ยังทำงานได้:
-- TS `fromJson()` ตอบ default 3 ตอนสร้าง snapshot ของนัดใหม่ · นัดที่ snapshot ไม่มีคีย์ = grace 0
-- Rollback: ALTER TABLE public.gangs ALTER COLUMN cancellation_policy SET DEFAULT (ค่าจาก 0021)
alter table public.gangs
  alter column cancellation_policy
  set default '{"cutoff_hours": 12, "allow_cancel_after_cutoff": true, "penalty_type": "full_share", "midway_cancel_ratio": 0.5, "promoted_grace_hours": 3}'::jsonb;

comment on column public.gangs.cancellation_policy is
  'ADR-002/004/011 schema: { cutoff_hours, allow_cancel_after_cutoff, penalty_type, penalty_value?, midway_cancel_ratio, promoted_grace_hours } — snapshot ลง session ตอนสร้างนัด ห้ามอ่านตอนคิดเงิน';


-- -----------------------------------------------------------------------------
-- actor_is_gang_admin(gang_id, actor_id) — ตรวจสิทธิ์แอดมินจาก "ตัวคนที่ส่งมา"
-- -----------------------------------------------------------------------------
-- is_gang_admin() อ่าน auth.uid() ซึ่งเป็น null เมื่อเรียกผ่าน service_role ⇒ ใช้ไม่ได้ใน
-- DB function ที่ server action เรียก · ตรรกะเดียวกันเป๊ะ (owner/admin ของก๊วน หรือของ org)
-- ใช้เป็นด่านที่สองหลัง can() ฝั่ง server — ห้ามพึ่ง can() อย่างเดียว
create or replace function public.actor_is_gang_admin(p_gang_id uuid, p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor_id is not null
     and (
       exists (
         select 1
           from public.gang_members gm
          where gm.gang_id    = p_gang_id
            and gm.user_id    = p_actor_id
            and gm.deleted_at is null
            and gm.role       in ('owner', 'admin')
       )
       or exists (
         select 1
           from public.gangs g
           join public.organization_members om on om.org_id = g.org_id
          where g.id         = p_gang_id
            and g.deleted_at is null
            and om.user_id   = p_actor_id
       )
     );
$$;

comment on function public.actor_is_gang_admin(uuid, uuid) is
  '[ADR-011] แอดมินก๊วน (หรือ org) ตาม actor id ที่ส่งมา — เทียบเท่า is_gang_admin() สำหรับฟังก์ชันที่ถูกเรียกผ่าน service_role';

revoke execute on function public.actor_is_gang_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.actor_is_gang_admin(uuid, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- member_reliability() — ไม่นับ "ยกเลิกแบบได้รับการยกเว้น" เป็นยกเลิกช้า
-- -----------------------------------------------------------------------------
-- เหมือน 0009 ทุกอย่าง ยกเว้นเพิ่ม `r.cancel_waiver is null` ในเงื่อนไข late cancel
create or replace function public.member_reliability(
  p_gang_id            uuid,
  p_user_id            uuid,
  p_exclude_session_id uuid default null
)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
           when w.total = 0 then 1.0
           else round(w.good::numeric / w.total, 4)
         end
    from (
      select
        count(*) filter (where r.status = 'checked_in') as good,
        count(*) filter (
          where r.status in ('checked_in', 'no_show')
             or (
               r.status = 'cancelled'
               and r.cancelled_at is not null
               and r.cancel_waiver is null
               and r.cancelled_at > s.starts_at
                   - (coalesce(
                        (s.snapshot -> 'cancellation_policy' ->> 'cutoff_hours')::numeric,
                        0
                      ) * interval '1 hour')
             )
        ) as total
      from public.session_registrations r
      join public.sessions s on s.id = r.session_id
     where r.user_id      = p_user_id
       and r.deleted_at   is null
       and s.gang_id      = p_gang_id
       and s.deleted_at   is null
       and (p_exclude_session_id is null or s.id <> p_exclude_session_id)
    ) w;
$$;

comment on function public.member_reliability(uuid, uuid, uuid) is
  '[D-8][ADR-011] checked_in / (checked_in + no_show + late_cancel ที่ไม่ได้รับการยกเว้น) คำนวณสด — ไม่มีประวัติ = 1.0';


-- -----------------------------------------------------------------------------
-- promote_waitlist(session_id, limit, actor_id, correlation_id, registration_id)
-- -----------------------------------------------------------------------------
-- ยังเป็นฟังก์ชันเดียวที่เปลี่ยน waitlist → confirmed
--   p_registration_id = null  → เหมือนเดิมทุกอย่าง (ตาม ordering → reliability → created_at)
--   p_registration_id = <id>  → แอดมินเลือกคนเอง (ข้ามคิว): ต้องเป็นแอดมินก๊วนนี้ + มีที่ว่างจริง
--                               ไม่มีที่ว่าง = SESSION_FULL (ห้ามสลับที่กับคนที่ได้ที่แล้ว)
-- เปลี่ยน signature ⇒ ต้อง DROP ตัวเก่า ไม่งั้นได้ overload สองตัว = ทางเลื่อนคิวสองทาง
drop function if exists public.promote_waitlist(uuid, integer, uuid, text);

create or replace function public.promote_waitlist(
  p_session_id      uuid,
  p_limit           integer default null,
  p_actor_id        uuid    default null,
  p_correlation_id  text    default null,
  p_registration_id uuid    default null
)
returns setof public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  public.sessions;
  v_target   public.session_registrations;
  v_occupied integer;
  v_slots    integer;
  v_ids      uuid[];
  v_id       uuid;
  v_reg      public.session_registrations;
  v_by_admin boolean := (p_registration_id is not null);
  v_skipped  integer := 0;
begin
  select * into v_session
    from public.sessions
   where id = p_session_id
     and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session', 'session_id', p_session_id)::text;
  end if;

  if v_by_admin then
    -- ด่านสิทธิ์ใน DB (can() ฝั่ง server เป็นด่านแรก ไม่ใช่ด่านเดียว)
    if not public.actor_is_gang_admin(v_session.gang_id, p_actor_id) then
      raise exception using
        errcode = 'P0001',
        message = 'FORBIDDEN',
        detail  = json_build_object('reason', 'เฉพาะแอดมินที่เลือกเลื่อนคนจากคิวได้')::text;
    end if;

    if v_session.status not in ('open', 'in_play') then
      raise exception using
        errcode = 'P0001',
        message = 'SESSION_NOT_OPEN',
        detail  = json_build_object('session_id', p_session_id, 'status', v_session.status)::text;
    end if;

    select * into v_target
      from public.session_registrations
     where id         = p_registration_id
       and session_id = p_session_id
       and deleted_at is null;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'REGISTRATION_NOT_FOUND',
        detail  = json_build_object('registration_id', p_registration_id)::text;
    end if;

    if v_target.status <> 'waitlist' then
      raise exception using
        errcode = 'P0001',
        message = 'INVALID_REGISTRATION_TRANSITION',
        detail  = json_build_object(
          'registration_id', p_registration_id,
          'from_status',     v_target.status,
          'to_status',       'confirmed'
        )::text;
    end if;
  end if;

  v_occupied := public.session_occupied_seats(p_session_id);
  v_slots    := v_session.max_players - v_occupied;

  if v_by_admin then
    -- เลือกคนเองต้องมีที่ว่างจริง — ไม่ใช่ no-op เงียบๆ เพราะแอดมินกำลังรอผลอยู่
    if v_slots <= 0 then
      raise exception using
        errcode = 'P0001',
        message = 'SESSION_FULL',
        detail  = json_build_object(
          'session_id',  p_session_id,
          'max_players', v_session.max_players,
          'occupied',    v_occupied
        )::text;
    end if;

    -- กี่คนที่รอก่อนหน้าแล้วถูกข้าม (ไว้ตรวจย้อนหลังเรื่องความเป็นธรรม)
    select count(*)::integer into v_skipped
      from public.session_registrations r
     where r.session_id = p_session_id
       and r.status     = 'waitlist'
       and r.deleted_at is null
       and r.id        <> p_registration_id
       and r.ordering   < v_target.ordering;

    v_ids := array[p_registration_id];
  else
    if p_limit is not null then
      v_slots := least(v_slots, p_limit);
    end if;

    if v_slots <= 0 then
      return;   -- ไม่มีที่ว่าง = ไม่ทำอะไร (ไม่ใช่ error)
    end if;

    -- [D-8] ordering ก่อน, reliability เป็นตัวตัดเสมอ, created_at กันเสมอซ้ำ
    select array_agg(q.id order by q.rn)
      into v_ids
      from (
        select r.id,
               row_number() over (
                 order by r.ordering asc,
                          public.member_reliability(v_session.gang_id, r.user_id, p_session_id) desc,
                          r.created_at asc
               ) as rn
          from public.session_registrations r
         where r.session_id = p_session_id
           and r.status     = 'waitlist'
           and r.deleted_at is null
         order by r.ordering asc,
                  public.member_reliability(v_session.gang_id, r.user_id, p_session_id) desc,
                  r.created_at asc
         limit v_slots
      ) q;

    if v_ids is null then
      return;   -- ไม่มีใครรออยู่
    end if;
  end if;

  foreach v_id in array v_ids loop
    update public.session_registrations
       set status      = 'confirmed',
           ordering    = 0,
           promoted_at = now(),          -- [ADR-011] จุดเริ่มนับ grace
           updated_by  = coalesce(p_actor_id, updated_by)
     where id     = v_id
       and status = 'waitlist'   -- กันซ้ำอีกชั้น (ต้องเป็นจริงเสมอเพราะถือ lock อยู่)
    returning * into v_reg;

    continue when not found;

    insert into public.event_logs
      (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
    values
      (v_session.gang_id, p_session_id, 'waitlist.promoted', 'registration', v_reg.id, p_actor_id,
       jsonb_build_object(
         'correlation_id',  p_correlation_id,
         'registration_id', v_reg.id,
         'occupied_before', v_occupied,
         'by_admin',        v_by_admin,
         'promoted_at',     v_reg.promoted_at
       ));

    if v_by_admin then
      -- audit.* = admin-only ตาม event_type_is_admin_only() — สมาชิกทั่วไปไม่เห็นว่าใครถูกข้ามคิว
      insert into public.event_logs
        (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
      values
        (v_session.gang_id, p_session_id, 'audit.waitlist_promoted_by_admin', 'registration',
         v_reg.id, p_actor_id,
         jsonb_build_object(
           'correlation_id',   p_correlation_id,
           'registration_id',  v_reg.id,
           'queue_position',   v_target.ordering,
           'skipped_ahead',    v_skipped
         ));
    end if;

    -- guest ไม่มีบัญชี ⇒ ไม่มี in-app notification (แจ้งผ่าน guest link แทน — Phase 2)
    if v_reg.user_id is not null then
      insert into public.notifications
        (gang_id, recipient_id, channel, event_type, payload)
      values
        (v_session.gang_id, v_reg.user_id, 'in_app', 'waitlist.promoted',
         jsonb_build_object(
           'correlation_id',  p_correlation_id,
           'session_id',      p_session_id,
           'registration_id', v_reg.id
         ));
    end if;

    return next v_reg;
  end loop;

  return;
end;
$$;

comment on function public.promote_waitlist(uuid, integer, uuid, text, uuid) is
  '[D-8][ADR-011] ทางเดียวที่ waitlist → confirmed · p_registration_id = แอดมินเลือกคนเอง (ข้ามคิว, ต้องมีที่ว่าง, ตรวจสิทธิ์ใน DB) · เขียน promoted_at ทุกครั้ง';

revoke execute on function public.promote_waitlist(uuid, integer, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.promote_waitlist(uuid, integer, uuid, text, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- cancel_registration(registration_id, actor_id, correlation_id, waive_penalty, reason, promote_registration_id)
-- -----------------------------------------------------------------------------
-- เหมือน 0009 ยกเว้น:
--   1. grace: confirmed ที่ถูกเลื่อนมาจาก waitlist (promoted_at) ยกเลิกภายใน
--      min(promoted_at + promoted_grace_hours, starts_at) ⇒ ไม่นับเป็นยกเลิกช้า (cancel_waiver = promoted_grace)
--      · promoted_grace_hours อ่านจาก snapshot เท่านั้น · ไม่มีคีย์ = 0 = พฤติกรรมเดิม
--   2. แอดมินยกเลิกแทนแบบไม่คิดค่าปรับ: p_waive_penalty = true ต้องมีเหตุผล + actor ต้องเป็นแอดมิน
--      (cancel_waiver = admin) · เหตุผลลง event audit.* (admin-only)
--   3. ได้รับการยกเว้นแล้วข้ามด่าน CANCEL_CUTOFF_PASSED ได้ — ไม่งั้นคนที่เพิ่งถูกเลื่อนตอนใกล้นัด
--      ในก๊วนที่ห้ามยกเลิกหลัง cutoff จะสละสิทธิ์ไม่ได้ ซึ่งขัดเจตนาของ grace
--   4. p_promote_registration_id: "เปลี่ยนคน" แบบ atomic — ยกเลิก A แล้วเลื่อน B ที่แอดมินเลือกใน
--      transaction เดียว (ไม่งั้นหัวคิวแย่งที่ B ก่อน) · ส่งต่อเข้า promote_waitlist(p_registration_id) เท่านั้น
-- เปลี่ยน signature ⇒ DROP ตัวเก่า (cancel_registration_as_guest / leave_gang เรียกแบบ positional 3 ตัว
-- ยังใช้ได้เพราะพารามิเตอร์ใหม่มี default)
drop function if exists public.cancel_registration(uuid, uuid, text);

create or replace function public.cancel_registration(
  p_registration_id         uuid,
  p_actor_id                uuid    default null,
  p_correlation_id          text    default null,
  p_waive_penalty           boolean default false,
  p_reason                  text    default null,
  p_promote_registration_id uuid    default null
)
returns public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg           public.session_registrations;
  v_session       public.sessions;
  v_session_id    uuid;
  v_policy        jsonb;
  v_cutoff_hours  numeric;
  v_cutoff_at     timestamptz;
  v_grace_hours   numeric;
  v_grace_until   timestamptz;
  v_in_grace      boolean := false;
  v_would_be_late boolean;
  v_is_late       boolean;
  v_waiver        text;
  v_reason        text := nullif(btrim(coalesce(p_reason, '')), '');
  v_was_status    text;
begin
  -- อ่าน session_id ก่อนโดยไม่ล็อก เพื่อจะได้ล็อกตามลำดับ session → registration
  -- (ลำดับเดียวกันทุกฟังก์ชัน = ไม่มี deadlock ไขว้)
  select session_id into v_session_id
    from public.session_registrations
   where id = p_registration_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  select * into v_session
    from public.sessions
   where id = v_session_id
     and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session')::text;
  end if;

  select * into v_reg
    from public.session_registrations
   where id = p_registration_id
     and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  v_was_status := v_reg.status;

  -- อนุญาตเฉพาะ confirmed → cancelled และ waitlist → cancelled
  if v_was_status not in ('confirmed', 'waitlist') then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_was_status,
        'to_status',       'cancelled'
      )::text;
  end if;

  -- "เปลี่ยนคน": ยกเลิก A แล้วเลื่อน B ใน transaction เดียว — ถ้าปล่อยให้ promote ตามคิวเอง หัวคิวจะได้ที่ก่อน
  -- B ที่แอดมินเลือกจะไม่ได้ที่ (SESSION_FULL) ⇒ ต้องส่งเป้าหมายเข้ามาตรงนี้ · ยังเป็นการเลื่อนผ่าน
  -- promote_waitlist() ตัวเดียว (ตรวจสิทธิ์แอดมิน/ที่ว่าง/สถานะของ B ในนั้น — พังตรงไหน ยกเลิก A ถูก rollback ด้วย)
  if p_promote_registration_id is not null and v_was_status <> 'confirmed' then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field',  'promote_registration_id',
        'reason', 'เลือกคนเลื่อนได้เฉพาะตอนยกเลิกคนที่ถือที่อยู่'
      )::text;
  end if;

  -- ขอยกเว้นค่าปรับ: ต้องเป็นแอดมินจริง (ตรวจใน DB) และต้องบอกเหตุผล
  if coalesce(p_waive_penalty, false) then
    if not public.actor_is_gang_admin(v_session.gang_id, p_actor_id) then
      raise exception using
        errcode = 'P0001',
        message = 'FORBIDDEN',
        detail  = json_build_object('reason', 'เฉพาะแอดมินที่ยกเว้นค่าปรับได้')::text;
    end if;

    if v_reason is null then
      raise exception using
        errcode = 'P0001',
        message = 'VALIDATION_ERROR',
        detail  = json_build_object('field', 'reason', 'reason', 'ต้องระบุเหตุผลที่ไม่คิดค่าปรับ')::text;
    end if;
  end if;

  -- 🔴 อ่าน policy จาก snapshot เท่านั้น ห้ามอ่านค่าปัจจุบันจาก gangs
  v_policy       := coalesce(v_session.snapshot -> 'cancellation_policy', '{}'::jsonb);
  v_cutoff_hours := coalesce((v_policy ->> 'cutoff_hours')::numeric, 0);
  v_cutoff_at    := v_session.starts_at - (v_cutoff_hours * interval '1 hour');
  -- คนที่รออยู่ใน waitlist ยังไม่ได้ที่ ⇒ ไม่มี penalty ไม่ว่ายกเลิกตอนไหน
  v_would_be_late := (v_was_status = 'confirmed') and (now() > v_cutoff_at);

  -- [ADR-011] grace หลังถูกเลื่อนคิว — นัดเก่าไม่มีคีย์ = 0 = ไม่มี grace
  v_grace_hours := coalesce((v_policy ->> 'promoted_grace_hours')::numeric, 0);
  if v_was_status = 'confirmed' and v_reg.promoted_at is not null and v_grace_hours > 0 then
    v_grace_until := least(
      v_reg.promoted_at + (v_grace_hours * interval '1 hour'),
      v_session.starts_at
    );
    v_in_grace := now() <= v_grace_until;
  end if;

  -- แอดมินยกเว้น > grace (ถ้าเข้าทั้งคู่ ให้บันทึกว่าแอดมินตัดสินใจ)
  -- grace บันทึกเฉพาะตอนที่ "มิฉะนั้นจะนับเป็นยกเลิกช้า" เพื่อไม่ให้ข้อมูลรก
  v_waiver := case
                when coalesce(p_waive_penalty, false) then 'admin'
                when v_in_grace and v_would_be_late   then 'promoted_grace'
                else null
              end;

  v_is_late := v_would_be_late and v_waiver is null;

  if v_is_late and not coalesce((v_policy ->> 'allow_cancel_after_cutoff')::boolean, true) then
    raise exception using
      errcode = 'P0001',
      message = 'CANCEL_CUTOFF_PASSED',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'cutoff_at',       v_cutoff_at,
        'starts_at',       v_session.starts_at
      )::text;
  end if;

  update public.session_registrations
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancel_waiver = v_waiver,
         updated_by    = coalesce(p_actor_id, updated_by)
   where id = p_registration_id
  returning * into v_reg;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_session.gang_id, v_session.id, 'registration.cancelled', 'registration',
     p_registration_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'from_status',    v_was_status,
       -- [D-9] บันทึกข้อเท็จจริงให้ domain/billing คิดเงินตอนปิดรอบ
       --       is_late_cancel = "ถูกคิดเป็นยกเลิกช้าจริง" (หลังหักการยกเว้นแล้ว)
       'is_late_cancel', v_is_late,
       'cutoff_at',      v_cutoff_at,
       'cancelled_at',   v_reg.cancelled_at,
       'policy',         v_policy,
       -- [ADR-011]
       'would_be_late_cancel', v_would_be_late,
       'penalty_waived_by',    v_waiver,
       'promoted_at',          v_reg.promoted_at,
       'grace_until',          v_grace_until
     ));

  if coalesce(p_waive_penalty, false) then
    -- เหตุผลเป็นข้อความอิสระของแอดมิน ⇒ เก็บใน audit.* (admin-only) ไม่ใส่ใน event ที่สมาชิกอ่านได้
    insert into public.event_logs
      (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
    values
      (v_session.gang_id, v_session.id, 'audit.registration_penalty_waived', 'registration',
       p_registration_id, p_actor_id,
       jsonb_build_object(
         'correlation_id',      p_correlation_id,
         'reason',              v_reason,
         'would_be_late_cancel', v_would_be_late
       ));
  end if;

  -- ที่ว่างเพิ่งเกิดขึ้นเฉพาะตอนที่คนยกเลิกเคยถือที่อยู่
  if v_was_status = 'confirmed' then
    if p_promote_registration_id is not null then
      perform public.promote_waitlist(
        v_session.id, null, p_actor_id, p_correlation_id, p_promote_registration_id
      );
    else
      perform public.promote_waitlist(v_session.id, null, p_actor_id, p_correlation_id);
    end if;
  end if;

  return v_reg;
end;
$$;

comment on function public.cancel_registration(uuid, uuid, text, boolean, text, uuid) is
  '[D-9][ADR-011] cancelled + บันทึก is_late_cancel (หลังหัก grace/ยกเว้น) + cancel_waiver ลงแถว (ไม่ insert charges — ADR-001) + promote ในตัว (ตามคิว หรือคนที่แอดมินเลือก)';

revoke execute on function public.cancel_registration(uuid, uuid, text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_registration(uuid, uuid, text, boolean, text, uuid) to service_role;
