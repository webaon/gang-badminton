-- =============================================================================
-- 20260818000042 — WO-B2.1: register_to_session ตรวจสมาชิกใน DB (กัน race กับ leave_gang)
-- =============================================================================
-- ปัญหา (QA เจอจาก WO-B2): register_to_session() lock แค่แถว session และเชื่อ role ที่
-- TS ตรวจไว้ก่อนเรียก RPC ⇒ TS ตรวจผ่าน → leave_gang() commit → RPC insert
-- ⇒ คนที่ออกจากก๊วนแล้วยังถือที่ confirmed/waitlist (และมองไม่เห็นใบนั้นอีกเพราะ RLS)
-- ทางลงชื่อแทนของแอดมิน (registration.create.other) เป็น p_user_id เดียวกัน ⇒ ถูกครอบด้วย
--
-- แก้: ก่อน lock แถว session ให้ `SELECT … FOR SHARE` แถว gang_members ของ p_user_id
-- แล้วตรวจว่ายัง active
--   - leave_gang() ถือ FOR UPDATE ทุกแถว gang_members ของก๊วน ⇒ ชนกับ FOR SHARE นี้:
--       · register มาก่อน   ⇒ leave รอ → ได้เห็นใบที่เพิ่ง insert แล้วยกเลิกผ่าน cancel_registration()
--       · leave มาก่อน      ⇒ register รอ → เห็นแถวถูก soft-delete → NOT_GANG_MEMBER
--   - ลำดับ lock เป็น members → session เสมอ (เดียวกับ leave_gang → cancel_registration)
--     ⇒ ไม่ deadlock · FOR SHARE สองคนไม่บล็อกกันเอง (คนละแถวอยู่แล้ว)
--   - gang_id ของ session เปลี่ยนไม่ได้ ⇒ อ่านก่อน lock session ได้อย่างปลอดภัย
--   - guest (p_user_id null) ไม่เกี่ยว — ไม่เปลี่ยนพฤติกรรม
--
-- signature เดิม ⇒ CREATE OR REPLACE คง GRANT เดิม (service_role เท่านั้น)
--
-- ROLLBACK: re-apply ตัวฟังก์ชันจาก 20260811000009_db_functions.sql (ส่วน register_to_session)
-- =============================================================================

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
  v_gang_id   uuid;
  v_member_id uuid;
  v_features  jsonb;
  v_token     public.session_invite_tokens;
  v_occupied  integer;
  v_status    text;
  v_ordering  integer := 0;
  v_reg       public.session_registrations;
begin
  -- 🔴 ผู้ลงชื่อที่เป็นสมาชิก: lock แถว gang_members (FOR SHARE) ก่อนแถว session
  --    ลำดับ members → session ต้องตรงกับ leave_gang() ไม่งั้น deadlock
  if p_user_id is not null then
    select gang_id into v_gang_id
      from public.sessions
     where id = p_session_id
       and deleted_at is null;

    if found then
      select id into v_member_id
        from public.gang_members
       where gang_id    = v_gang_id
         and user_id    = p_user_id
         and deleted_at is null
         for share;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'NOT_GANG_MEMBER',
          detail  = json_build_object('gang_id', v_gang_id, 'user_id', p_user_id)::text;
      end if;
    end if;
    -- ไม่เจอ session ⇒ ปล่อยให้ด้านล่าง raise NOT_FOUND ตามเดิม
  end if;

  -- 🔴 lock แถว session — นี่คือจุดที่กัน overbook
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
  '🔴 lock member (FOR SHARE) → lock session → นับที่ว่าง → confirmed/waitlist. สมาชิกต้อง active (NOT_GANG_MEMBER) กัน race กับ leave_gang. guest ต้องผ่าน features.guests + invite token. ห้าม log plaintext token';
