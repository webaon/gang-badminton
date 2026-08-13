-- =============================================================================
-- WO-1.3 · 0009 — DB functions ทั้ง 6 (baseline §Database Functions = authoritative)
-- =============================================================================
--   register_to_session · cancel_registration · promote_waitlist
--   check_in_registration · transition_session · close_session_with_charges
--
-- 🔴 หลักการที่ทุกฟังก์ชันในไฟล์นี้ยึด:
--   1. นับที่ว่าง/เลื่อนคิว ต้อง SELECT ... FOR UPDATE แถว sessions ก่อนเสมอ
--      — แถว session คือ lock ตัวเดียวที่ serialize ทุก flow ของนัดนั้น
--   2. app code เป็น shell — ห้าม check-then-act ใน TypeScript
--   3. error raise ด้วย ERRCODE P0001 + MESSAGE = code จาก docs/errors.md
--      รายละเอียดใส่ DETAIL เป็น JSON
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Deviation notes (บันทึกตามกติกา CLAUDE.md §0 ข้อ 7 — ไม่ใช่การเปลี่ยนสถาปัตยกรรม
-- จึงไม่ต้องออก ADR ใหม่ แต่ห้ามเงียบ):
--
--   D-7  baseline เขียน signature ว่า close_session_with_charges(session_id,
--        charges, expected_status) แต่ย่อหน้าเดียวกันบอกว่าฟังก์ชันนี้ต้องรองรับ
--        ทั้ง "ปิดรอบปกติ open/in_play → billing" และ "ยกเลิกกลางคัน in_play →
--        cancelled" ⇒ signature ตามตัวอักษรบอกไม่ได้ว่าจะไปสถานะไหน
--        แก้: เพิ่มพารามิเตอร์ p_to_status (default 'billing')
--
--   D-8  promote_waitlist เรียงคิว "ตาม ordering + reliability" โดย baseline
--        ไม่ได้ให้สูตร reliability และไม่ได้บอกลำดับความสำคัญ
--        ตัดสินใจ (ยืนยันกับเจ้าของงาน 11 ส.ค. 2026):
--          ORDER BY ordering ASC, reliability DESC, created_at ASC
--          reliability = checked_in / (checked_in + no_show + late_cancel)
--          คนไม่มีประวัติ (รวม guest) = 1.0
--        ⇒ ordering เป็นหลัก (ยุติธรรม/เดาได้), reliability เป็นตัวตัดเสมอเท่านั้น
--
--   D-9  cancel_registration "ตัดสิน penalty" แต่ **ไม่ insert charges**
--        เพราะ ADR-001 บังคับว่า charges ประเภท session commit ได้ที่
--        close_session_with_charges() ที่เดียว ⇒ ที่นี่บันทึกเฉพาะ "ข้อเท็จจริง"
--        (cancelled_at + is_late + policy ที่ใช้) ลง event_logs ส่วน "จำนวนเงิน"
--        domain/billing (TS) คำนวณตอนปิดรอบจาก snapshot + cancelled_at ได้เอง
--
--   D-11 เพิ่ม claim_notifications() ซึ่งไม่อยู่ในลิสต์ 6 ฟังก์ชันของ baseline
--        เหตุผล: DoD ของ WO-1.3 เองข้อ 3 บังคับว่า "notification worker 2 ตัว
--        รันทับกันต้องไม่ส่งซ้ำ (SKIP LOCKED)" — ถ้าไม่มีฟังก์ชัน claim จริง
--        เทสต์จะกลายเป็นการทดสอบ SQL ที่เขียนในไฟล์เทสต์เอง ไม่ใช่โค้ด production
--        ขอบเขตจำกัดแค่ "หยิบงาน" เท่านั้น (ไม่มี logic ส่ง/retry — Phase 2)
--
--   D-10 ที่นั่งที่ถือว่า "ใช้แล้ว" = confirmed + checked_in
--        (คนเช็คอินแล้วยังกินที่อยู่ — ถ้านับแค่ confirmed จะ overbook ทันทีที่
--        มีคนเช็คอิน) baseline เขียนแค่ count(confirmed) เพราะยังไม่ได้พูดถึง
--        checked_in ในบริบทเดียวกัน
--
-- Rollback: DROP FUNCTION public.claim_notifications(integer);
--           DROP FUNCTION public.close_session_with_charges(uuid, jsonb, text, text, uuid, text);
--           DROP FUNCTION public.transition_session(uuid, text, uuid, text);
--           DROP FUNCTION public.check_in_registration(uuid, uuid, text);
--           DROP FUNCTION public.cancel_registration(uuid, uuid, text);
--           DROP FUNCTION public.promote_waitlist(uuid, integer, uuid, text);
--           DROP FUNCTION public.register_to_session(uuid, uuid, text, text, text, uuid, text);
--           DROP FUNCTION public.member_reliability(uuid, uuid, uuid);
--           DROP FUNCTION public.is_valid_session_transition(text, text);
--           DROP FUNCTION public.session_occupied_seats(uuid);
-- =============================================================================


-- =============================================================================
-- ส่วนที่ 1 — helper (pure, ไม่มี side effect)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- is_valid_session_transition(from, to)
-- -----------------------------------------------------------------------------
-- แหล่งเดียวของเส้น transition ที่อนุญาต (baseline §State Machines)
-- แก้ที่นี่ที่เดียว ทั้ง transition_session() และ close_session_with_charges() ใช้ร่วมกัน
create or replace function public.is_valid_session_transition(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select (p_from, p_to) in (
    -- เส้นหลัก
    ('draft',   'open'),
    ('open',    'in_play'),
    ('in_play', 'billing'),
    ('billing', 'settled'),
    ('settled', 'archived'),
    -- [v3.2] ยกเลิกก่อนเล่น / ยกเลิกกลางคัน
    ('draft',   'cancelled'),
    ('open',    'cancelled'),
    ('in_play', 'cancelled'),
    -- [v3.2] ก๊วนเหมาจ่ายที่ไม่ใช้ game console ข้าม in_play ได้
    ('open',    'billing')
  );
$$;

comment on function public.is_valid_session_transition(text, text) is
  'แหล่งเดียวของเส้น transition ที่อนุญาตตาม baseline §State Machines';


-- -----------------------------------------------------------------------------
-- session_occupied_seats(session_id) — จำนวนที่นั่งที่ถูกใช้จริง
-- -----------------------------------------------------------------------------
-- [D-10] confirmed + checked_in — "เต็ม" ไม่ใช่ state ต้อง derive สดทุกครั้ง
-- ⚠️ ผู้เรียกต้องถือ lock แถว sessions อยู่แล้ว ฟังก์ชันนี้ไม่ล็อกอะไรให้
create or replace function public.session_occupied_seats(p_session_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.session_registrations
   where session_id = p_session_id
     and deleted_at is null
     and status in ('confirmed', 'checked_in');
$$;

comment on function public.session_occupied_seats(uuid) is
  '[D-10] ที่นั่งที่ใช้แล้ว = confirmed + checked_in (checked_in ยังกินที่อยู่)';


-- -----------------------------------------------------------------------------
-- member_reliability(gang_id, user_id, exclude_session_id) → numeric 0..1
-- -----------------------------------------------------------------------------
-- [D-8] คำนวณสดจาก session_registrations ไม่อ่าน member_statistics
--       (member_statistics เป็น rollup รายคืน — ใช้ตัดคิวจะช้าไปหนึ่งวัน)
--
--   reliability = checked_in / (checked_in + no_show + late_cancel)
--
-- late_cancel = ยกเลิกหลัง cutoff ของ **นัดนั้น** ซึ่งอ่านจาก snapshot ของนัดนั้น
-- ไม่ใช่ค่าปัจจุบันของก๊วน (baseline §Snapshot rule — policy เปลี่ยนทีหลัง
-- ต้องไม่ย้อนไปตัดสินนัดเก่า)
--
-- ไม่มีประวัติ = 1.0 (ให้ประโยชน์แห่งความสงสัย) — guest ที่ user_id เป็น null
-- ก็ตกเคสนี้เพราะ `user_id = null` ไม่ match แถวไหนเลย
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
  '[D-8] checked_in / (checked_in + no_show + late_cancel) คำนวณสด — ไม่มีประวัติ = 1.0';


-- =============================================================================
-- ส่วนที่ 2 — state machine ของ session
-- =============================================================================

-- -----------------------------------------------------------------------------
-- transition_session(session_id, to_status, actor_id, correlation_id)
-- -----------------------------------------------------------------------------
-- ทางเดียวที่เปลี่ยน sessions.status ได้ (นอกจาก close_session_with_charges)
--
-- GUC app.allow_transition ถูก set เป็น **id ของแถวนี้** แล้ว **เคลียร์ทันที**
-- หลัง UPDATE — ทำให้ใบอนุญาตเป็น one-shot ต่อแถว ไม่ค้างไว้ทั้ง transaction
create or replace function public.transition_session(
  p_session_id      uuid,
  p_to_status       text,
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_from    text;
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

  v_from := v_session.status;

  if not public.is_valid_session_transition(v_from, p_to_status) then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_TRANSITION',
      detail  = json_build_object(
        'session_id',  p_session_id,
        'from_status', v_from,
        'to_status',   p_to_status
      )::text;
  end if;

  perform set_config('app.allow_transition', p_session_id::text, true);

  update public.sessions
     set status     = p_to_status,
         updated_by = coalesce(p_actor_id, updated_by)
   where id = p_session_id
  returning * into v_session;

  -- เคลียร์ทันที: ถ้าค้างไว้ การ UPDATE แถวเดิมซ้ำใน transaction เดียวกันจะผ่าน
  perform set_config('app.allow_transition', '', true);

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_session.gang_id, p_session_id, 'session.transitioned', 'session', p_session_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'from_status',    v_from,
       'to_status',      p_to_status
     ));

  return v_session;
end;
$$;

comment on function public.transition_session(uuid, text, uuid, text) is
  'ทางเดียวที่เปลี่ยน sessions.status — ตรวจเส้น transition + set GUC one-shot + เขียน event';


-- =============================================================================
-- ส่วนที่ 3 — flow ลงชื่อ
-- =============================================================================

-- -----------------------------------------------------------------------------
-- register_to_session(...)
-- -----------------------------------------------------------------------------
-- p_user_id NULL = guest → ต้องมี guest_name + invite token ที่ยังใช้ได้
--                          + features.guests เปิด + sessions.allow_guests
--
-- 🔴 ห้าม log p_invite_token (plaintext) ที่ใดทั้งสิ้น — เก็บ/เทียบเฉพาะ SHA-256
create or replace function public.register_to_session(
  p_session_id     uuid,
  p_user_id        uuid default null,
  p_guest_name     text default null,
  p_guest_phone    text default null,
  p_invite_token   text default null,
  p_registered_by  uuid default null,
  p_correlation_id text default null
)
returns public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session   public.sessions;
  v_features  jsonb;
  v_token     public.session_invite_tokens;
  v_occupied  integer;
  v_status    text;
  v_ordering  integer := 0;
  v_reg       public.session_registrations;
begin
  -- 🔴 lock แถว session ก่อนทุกอย่าง — นี่คือจุดที่กัน overbook
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

  if v_session.status <> 'open' then
    raise exception using
      errcode = 'P0001',
      message = 'SESSION_NOT_OPEN',
      detail  = json_build_object('session_id', p_session_id, 'status', v_session.status)::text;
  end if;

  -- ---------------------------------------------------------------------------
  -- guest path — feature flag + invite token
  -- ---------------------------------------------------------------------------
  if p_user_id is null then
    if p_guest_name is null or btrim(p_guest_name) = '' then
      raise exception using
        errcode = 'P0001',
        message = 'VALIDATION_ERROR',
        detail  = json_build_object('reason', 'guest_name is required when user_id is null')::text;
    end if;

    -- feature flag ต้อง enforce ฝั่ง server เสมอ (CLAUDE.md §3) — ซ่อนปุ่มไม่นับ
    select features into v_features
      from public.gangs
     where id = v_session.gang_id
       and deleted_at is null;

    if not coalesce((v_features ->> 'guests')::boolean, false) then
      raise exception using
        errcode = 'P0001',
        message = 'FEATURE_DISABLED',
        detail  = json_build_object('feature', 'guests', 'gang_id', v_session.gang_id)::text;
    end if;

    if not v_session.allow_guests then
      raise exception using
        errcode = 'P0001',
        message = 'FEATURE_DISABLED',
        detail  = json_build_object('feature', 'guests', 'session_id', p_session_id)::text;
    end if;

    if p_invite_token is null then
      raise exception using
        errcode = 'P0001',
        message = 'INVITE_TOKEN_INVALID',
        detail  = json_build_object('reason', 'missing token')::text;
    end if;

    -- lock แถว token ด้วย เพราะต้อง +1 used_count แบบกัน race
    select * into v_token
      from public.session_invite_tokens
     where session_id = p_session_id
       and token_hash = extensions.digest(p_invite_token, 'sha256')
     for update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'INVITE_TOKEN_INVALID',
        detail  = json_build_object('session_id', p_session_id)::text;
    end if;

    if v_token.revoked_at is not null or v_token.expires_at <= now() then
      raise exception using
        errcode = 'P0001',
        message = 'INVITE_TOKEN_EXPIRED',
        detail  = json_build_object('token_id', v_token.id, 'expires_at', v_token.expires_at)::text;
    end if;

    if v_token.used_count >= v_token.max_uses then
      raise exception using
        errcode = 'P0001',
        message = 'INVITE_TOKEN_EXHAUSTED',
        detail  = json_build_object(
          'token_id', v_token.id, 'max_uses', v_token.max_uses)::text;
    end if;

    update public.session_invite_tokens
       set used_count = used_count + 1
     where id = v_token.id;
  end if;

  -- ---------------------------------------------------------------------------
  -- นับที่ว่างสดๆ ใต้ lock → confirmed หรือ waitlist
  -- ---------------------------------------------------------------------------
  v_occupied := public.session_occupied_seats(p_session_id);

  if v_occupied < v_session.max_players then
    v_status := 'confirmed';
  else
    v_status := 'waitlist';
    -- ต่อท้ายคิวเสมอ
    select coalesce(max(ordering), 0) + 1 into v_ordering
      from public.session_registrations
     where session_id = p_session_id
       and status     = 'waitlist'
       and deleted_at is null;
  end if;

  begin
    insert into public.session_registrations
      (session_id, user_id, guest_name, guest_phone, status, ordering,
       registered_by, created_by)
    values
      (p_session_id, p_user_id,
       case when p_user_id is null then p_guest_name  else null end,
       case when p_user_id is null then p_guest_phone else null end,
       v_status, v_ordering,
       p_registered_by, coalesce(p_registered_by, p_user_id))
    returning * into v_reg;
  exception
    when unique_violation then
      -- ชน session_registrations_session_user_active_key
      raise exception using
        errcode = 'P0001',
        message = 'ALREADY_REGISTERED',
        detail  = json_build_object('session_id', p_session_id, 'user_id', p_user_id)::text;
  end;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_session.gang_id, p_session_id,
     case when v_status = 'confirmed' then 'registration.confirmed'
          else 'registration.waitlisted' end,
     'registration', v_reg.id, coalesce(p_registered_by, p_user_id),
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'status',         v_status,
       'ordering',       v_ordering,
       'is_guest',       (p_user_id is null),
       'occupied_seats', v_occupied,
       'max_players',    v_session.max_players
     ));

  return v_reg;
end;
$$;

comment on function public.register_to_session(uuid, uuid, text, text, text, uuid, text) is
  '🔴 lock session → นับที่ว่าง → confirmed/waitlist. guest ต้องผ่าน features.guests + invite token. ห้าม log plaintext token';


-- -----------------------------------------------------------------------------
-- promote_waitlist(session_id, limit, actor_id, correlation_id)
-- -----------------------------------------------------------------------------
-- เลื่อนคิวเท่าที่มีที่ว่างจริง — คืน setof แถวที่ถูกเลื่อน (ว่างได้ถ้าไม่มีที่/ไม่มีคิว)
--
-- serialize ด้วย lock แถว session ⇒ สอง transaction ที่ cancel พร้อมกันจะ
-- promote ทีละตัว ไม่มีทางเลื่อนคนเดียวกันซ้ำหรือข้ามคิว
create or replace function public.promote_waitlist(
  p_session_id     uuid,
  p_limit          integer default null,
  p_actor_id       uuid    default null,
  p_correlation_id text    default null
)
returns setof public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session  public.sessions;
  v_occupied integer;
  v_slots    integer;
  v_ids      uuid[];
  v_id       uuid;
  v_reg      public.session_registrations;
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

  v_occupied := public.session_occupied_seats(p_session_id);
  v_slots    := v_session.max_players - v_occupied;

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

  foreach v_id in array v_ids loop
    update public.session_registrations
       set status     = 'confirmed',
           ordering   = 0,
           updated_by = coalesce(p_actor_id, updated_by)
     where id     = v_id
       and status = 'waitlist'   -- กันซ้ำอีกชั้น (ต้องเป็นจริงเสมอเพราะถือ lock อยู่)
    returning * into v_reg;

    continue when not found;

    insert into public.event_logs
      (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
    values
      (v_session.gang_id, p_session_id, 'waitlist.promoted', 'registration', v_reg.id, p_actor_id,
       jsonb_build_object(
         'correlation_id', p_correlation_id,
         'registration_id', v_reg.id,
         'occupied_before', v_occupied
       ));

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

comment on function public.promote_waitlist(uuid, integer, uuid, text) is
  '[D-8] lock session → เลื่อนคิวตาม ordering → reliability → created_at + event + notification';


-- -----------------------------------------------------------------------------
-- cancel_registration(registration_id, actor_id, correlation_id)
-- -----------------------------------------------------------------------------
-- [D-9] ตัดสิน penalty (late/ไม่ late) แล้วบันทึกเป็น "ข้อเท็จจริง" ใน event เท่านั้น
--       ❌ ห้าม insert session_charges ที่นี่ (ADR-001)
--
-- cancellation_policy ที่อ่านจาก snapshot (คีย์ที่ใช้จริงใน WO นี้):
--   { "cutoff_hours": 12, "allow_cancel_after_cutoff": true, ... }
--   ไม่มีคีย์ = cutoff 0 ชม. + ยกเลิกได้เสมอ (ก๊วนที่ยังไม่ตั้ง policy)
create or replace function public.cancel_registration(
  p_registration_id uuid,
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg          public.session_registrations;
  v_session      public.sessions;
  v_session_id   uuid;
  v_policy       jsonb;
  v_cutoff_hours numeric;
  v_cutoff_at    timestamptz;
  v_is_late      boolean;
  v_was_status   text;
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

  -- 🔴 อ่าน policy จาก snapshot เท่านั้น ห้ามอ่านค่าปัจจุบันจาก gangs
  v_policy       := coalesce(v_session.snapshot -> 'cancellation_policy', '{}'::jsonb);
  v_cutoff_hours := coalesce((v_policy ->> 'cutoff_hours')::numeric, 0);
  v_cutoff_at    := v_session.starts_at - (v_cutoff_hours * interval '1 hour');
  -- คนที่รออยู่ใน waitlist ยังไม่ได้ที่ ⇒ ไม่มี penalty ไม่ว่ายกเลิกตอนไหน
  v_is_late      := (v_was_status = 'confirmed') and (now() > v_cutoff_at);

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
     set status       = 'cancelled',
         cancelled_at = now(),
         updated_by   = coalesce(p_actor_id, updated_by)
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
       'is_late_cancel', v_is_late,
       'cutoff_at',      v_cutoff_at,
       'cancelled_at',   v_reg.cancelled_at,
       'policy',         v_policy
     ));

  -- ที่ว่างเพิ่งเกิดขึ้นเฉพาะตอนที่คนยกเลิกเคยถือที่อยู่
  if v_was_status = 'confirmed' then
    perform public.promote_waitlist(v_session.id, null, p_actor_id, p_correlation_id);
  end if;

  return v_reg;
end;
$$;

comment on function public.cancel_registration(uuid, uuid, text) is
  '[D-9] cancelled + บันทึก is_late_cancel ลง event (ไม่ insert charges — ADR-001) + promote ในตัว';


-- -----------------------------------------------------------------------------
-- check_in_registration(registration_id, actor_id, correlation_id)
-- -----------------------------------------------------------------------------
-- confirmed → checked_in เท่านั้น (❌ ห้าม waitlist → checked_in ตรง)
create or replace function public.check_in_registration(
  p_registration_id uuid,
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg     public.session_registrations;
  v_gang_id uuid;
begin
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

  if v_reg.status <> 'confirmed' then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_reg.status,
        'to_status',       'checked_in'
      )::text;
  end if;

  update public.session_registrations
     set status        = 'checked_in',
         checked_in_at = now(),
         updated_by    = coalesce(p_actor_id, updated_by)
   where id = p_registration_id
  returning * into v_reg;

  select gang_id into v_gang_id from public.sessions where id = v_reg.session_id;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_gang_id, v_reg.session_id, 'registration.checked_in', 'registration',
     p_registration_id, p_actor_id,
     jsonb_build_object('correlation_id', p_correlation_id));

  return v_reg;
end;
$$;

comment on function public.check_in_registration(uuid, uuid, text) is
  'confirmed → checked_in เท่านั้น — waitlist ต้อง promote ก่อน';


-- =============================================================================
-- ส่วนที่ 4 — ADR-001: จุด commit เดียวของเงินตอนจบ session
-- =============================================================================

-- -----------------------------------------------------------------------------
-- close_session_with_charges(session_id, charges, expected_status, to_status, ...)
-- -----------------------------------------------------------------------------
-- p_charges = jsonb array:
--   [ { "registration_id": uuid, "amount": "150.00", "breakdown": { ... } }, ... ]
--   คำนวณมาแล้วจาก domain/billing (TypeScript) — ❌ ห้ามย้าย logic คิดเงินมาไว้ที่นี่
--
-- ลำดับสำคัญมาก: ตรวจ expected_status **ก่อน** insert อะไรทั้งสิ้น
-- ถ้า guard ไม่ผ่าน ต้องไม่มี charges เกิดขึ้นเลยแม้แต่แถวเดียว (DoD ข้อ 4)
create or replace function public.close_session_with_charges(
  p_session_id      uuid,
  p_charges         jsonb,
  p_expected_status text,
  p_to_status       text default 'billing',   -- [D-7]
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session       public.sessions;
  v_inserted      integer := 0;
  v_total         numeric(12, 2) := 0;
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

  -- 🔴 optimistic guard (ADR-001) — ด่านแรกสุด ก่อนแตะเงิน
  if v_session.status <> p_expected_status then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_TRANSITION',
      detail  = json_build_object(
        'session_id',      p_session_id,
        'expected_status', p_expected_status,
        'actual_status',   v_session.status,
        'reason',          'stale expected_status — server action ต้องคำนวณใหม่'
      )::text;
  end if;

  -- เรียกซ้ำไม่ได้ — charges ประเภท session ของนัดนี้ต้อง commit ครั้งเดียว
  --
  -- ⚠️ ต้องตรวจ **ก่อน** is_valid_session_transition ไม่ใช่หลัง:
  --    ถ้าตรวจทีหลัง เคสเรียกซ้ำจะไปตกที่ INVALID_TRANSITION ก่อนเสมอ
  --    (close สำเร็จแล้ว status = billing/cancelled ซึ่งไม่มีเส้นออกที่ close ใช้ได้)
  --    ⇒ CHARGES_ALREADY_COMMITTED จะกลายเป็น dead code และผู้เรียกได้ error
  --      ที่ชี้สาเหตุผิด — จับได้จากเทสต์ 4c
  if exists (
    select 1 from public.session_charges
     where session_id = p_session_id and type = 'session'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'CHARGES_ALREADY_COMMITTED',
      detail  = json_build_object('session_id', p_session_id)::text;
  end if;

  if not public.is_valid_session_transition(v_session.status, p_to_status) then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_TRANSITION',
      detail  = json_build_object(
        'session_id',  p_session_id,
        'from_status', v_session.status,
        'to_status',   p_to_status
      )::text;
  end if;

  if jsonb_typeof(p_charges) <> 'array' then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'p_charges must be a jsonb array')::text;
  end if;

  -- ทุก registration_id ต้องอยู่ในนัดนี้จริง (FK อย่างเดียวกันข้ามนัดไม่ได้)
  if exists (
    select 1
      from jsonb_array_elements(p_charges) c
      left join public.session_registrations r
             on r.id = nullif(c ->> 'registration_id', '')::uuid
     where r.id is null
        or r.session_id <> p_session_id
        or r.deleted_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'reason', 'registration_id ในบาง charge ไม่มีอยู่จริงหรือไม่ได้อยู่ใน session นี้')::text;
  end if;

  begin
    insert into public.session_charges
      (gang_id, type, session_id, registration_id, amount, breakdown, created_by)
    select v_session.gang_id,
           'session',
           p_session_id,
           (c ->> 'registration_id')::uuid,
           (c ->> 'amount')::numeric(12, 2),
           coalesce(c -> 'breakdown', '{}'::jsonb),
           p_actor_id
      from jsonb_array_elements(p_charges) c;

    -- ต้องอ่านทันทีหลัง INSERT — ถ้าอ่านนอกบล็อก exception ค่าจะเป็นของคำสั่งอื่น
    get diagnostics v_inserted = row_count;
  exception
    when unique_violation then
      -- ชน session_charges_session_registration_key (registration_id ซ้ำใน payload)
      raise exception using
        errcode = 'P0001',
        message = 'VALIDATION_ERROR',
        detail  = json_build_object(
          'reason', 'registration_id ซ้ำกันใน p_charges — หนึ่ง registration มีได้หนึ่ง charge')::text;
  end;

  select coalesce(sum(amount), 0) into v_total
    from public.session_charges
   where session_id = p_session_id and type = 'session';

  perform set_config('app.allow_transition', p_session_id::text, true);

  update public.sessions
     set status     = p_to_status,
         updated_by = coalesce(p_actor_id, updated_by)
   where id = p_session_id
  returning * into v_session;

  perform set_config('app.allow_transition', '', true);

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_session.gang_id, p_session_id, 'session.closed_with_charges', 'session',
     p_session_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'from_status',    p_expected_status,
       'to_status',      p_to_status,
       'charge_count',   v_inserted,
       'charge_total',   v_total
     ));

  return v_session;
end;
$$;

comment on function public.close_session_with_charges(uuid, jsonb, text, text, uuid, text) is
  'ADR-001 — จุด commit เดียวของ charges ประเภท session: ตรวจ expected_status ก่อน แล้ว insert + transition แบบ atomic';


-- =============================================================================
-- ส่วนที่ 5 — [D-11] notification worker claim
-- =============================================================================

-- -----------------------------------------------------------------------------
-- claim_notifications(limit) → setof notifications
-- -----------------------------------------------------------------------------
-- หยิบงานที่ถึงคิวส่งแล้ว mark เป็น processing แบบ atomic
--
-- 🔴 FOR UPDATE SKIP LOCKED คือหัวใจ: worker ตัวที่สองจะ "ข้าม" แถวที่ตัวแรก
--    ล็อกอยู่แทนที่จะรอ ⇒ ไม่มีทางหยิบงานเดียวกันสองครั้ง และไม่บล็อกกันเอง
--    (ถ้าใช้ FOR UPDATE เฉยๆ จะไม่ซ้ำเหมือนกันแต่ worker จะรอคิวกันเป็นแถว)
--
-- ใช้ CTE: SELECT ... FOR UPDATE SKIP LOCKED ต้องอยู่คนละ query level กับ UPDATE
create or replace function public.claim_notifications(p_limit integer default 10)
returns setof public.notifications
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    select id
      from public.notifications
     where status        = 'pending'
       and next_retry_at <= now()
       and scheduled_at  <= now()
     order by scheduled_at
     limit p_limit
     for update skip locked
  )
  update public.notifications n
     set status     = 'processing',
         claimed_at = now(),
         attempt    = n.attempt + 1
    from claimed c
   where n.id = c.id
  returning n.*;
$$;

comment on function public.claim_notifications(integer) is
  '[D-11] worker claim ด้วย FOR UPDATE SKIP LOCKED — สอง worker หยิบงานเดียวกันไม่ได้';
