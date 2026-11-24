-- 0052 / ADR-015 R-roles-2b: migrate session-management permission checks.
-- All policies use uncorrelated InitPlans; existing membership SELECT policies stay unchanged.
-- sessions_with_permission bypasses sessions RLS so org admins retain legacy
-- is_session_admin access even where sessions_select_member hides the parent row.
-- Replaced function bodies are copied verbatim from latest 0043/0045, changing
-- only actor_is_gang_admin to actor_has_permission(action); locks unchanged.
-- Legacy service-only game/checkin functions without role checks stay unchanged.
-- No signature/grant change, no state-machine/billing/snapshot logic change.
-- Rollback: restore policies from 0010 and function bodies from 0043/0045,
-- then DROP FUNCTION public.sessions_with_permission(text).

create function public.sessions_with_permission(p_action text)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s.id), '{}'::uuid[])
  from public.sessions s
  where s.deleted_at is null
    and s.gang_id = any ((select public.gangs_with_permission(p_action))::uuid[]);
$$;
comment on function public.sessions_with_permission(text) is
  '[ADR-015] Nondeleted session IDs where current user has action; InitPlan form preserving legacy is_session_admin semantics.';
revoke execute on function public.sessions_with_permission(text) from public, anon, authenticated, service_role;
grant execute on function public.sessions_with_permission(text) to anon, authenticated, service_role;

drop policy sessions_insert_admin_draft_only on public.sessions;
create policy sessions_insert_admin_draft_only on public.sessions for insert to authenticated
with check (status = 'draft' and gang_id = any ((select public.gangs_with_permission('session.create'))::uuid[]));

drop policy sessions_update_admin on public.sessions;
create policy sessions_update_admin on public.sessions for update to authenticated
using (deleted_at is null and gang_id = any ((select public.gangs_with_permission('session.update'))::uuid[]))
with check (gang_id = any ((select public.gangs_with_permission('session.update'))::uuid[]));

drop policy session_invite_tokens_admin on public.session_invite_tokens;
create policy session_invite_tokens_admin on public.session_invite_tokens for all to authenticated
using (session_id = any ((select public.sessions_with_permission('session.invite.manage'))::uuid[]))
with check (session_id = any ((select public.sessions_with_permission('session.invite.manage'))::uuid[]));

drop policy games_write_admin on public.games;
create policy games_write_admin on public.games for all to authenticated
using (session_id = any ((select public.sessions_with_permission('game.manage'))::uuid[]))
with check (session_id = any ((select public.sessions_with_permission('game.manage'))::uuid[]));

-- Existing actor-checked function definitions follow (only permission predicate changes).

-- Copied from 20260818000045_notify_via_fanout.sql; only actor permission predicate changed.
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
    if not public.actor_has_permission(v_session.gang_id, p_actor_id, 'registration.promote.other') then
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

    -- guest ไม่มีบัญชี ⇒ ไม่มีแจ้งเตือน (แจ้งผ่าน guest link แทน — Phase 2)
    -- [WO-R4] เข้าคิวผ่าน enqueue_notifications() ทางเดียว ⇒ in_app + line · dedupe ต่อใบลงชื่อ
    --   (เดิม insert in_app ตรง ไม่มี dedupe_key และ LINE ไม่เคยได้) · ไม่กระทบผล/transition ของการเลื่อนคิว
    if v_reg.user_id is not null then
      perform public.enqueue_notifications(jsonb_build_array(jsonb_build_object(
        'gang_id',      v_session.gang_id,
        'recipient_id', v_reg.user_id,
        'event_type',   'waitlist.promoted',
        'payload',      jsonb_build_object(
                          'correlation_id',  p_correlation_id,
                          'session_id',      p_session_id,
                          'session_title',   v_session.title,
                          'registration_id', v_reg.id
                        ),
        'dedupe_key',   'waitlist.promoted:' || v_reg.id
      )));
    end if;

    return next v_reg;
  end loop;

  return;
end;
$$;

-- Copied from 20260818000043_preview_cancel_registration.sql; only actor permission predicate changed.
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
  v_d             record;
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
    if not public.actor_has_permission(v_session.gang_id, p_actor_id, 'registration.cancel.other') then
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

  -- 🔴 ตรรกะตัดสินอยู่ที่ cancel_decision() ที่เดียว (ใช้ร่วมกับ preview)
  select * into v_d
    from public.cancel_decision(v_reg, v_session, coalesce(p_waive_penalty, false));

  if v_d.blocked then
    raise exception using
      errcode = 'P0001',
      message = 'CANCEL_CUTOFF_PASSED',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'cutoff_at',       v_d.cutoff_at,
        'starts_at',       v_session.starts_at
      )::text;
  end if;

  update public.session_registrations
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancel_waiver = v_d.waiver,
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
       'is_late_cancel', v_d.is_late,
       'cutoff_at',      v_d.cutoff_at,
       'cancelled_at',   v_reg.cancelled_at,
       'policy',         v_d.policy,
       -- [ADR-011]
       'would_be_late_cancel', v_d.would_be_late,
       'penalty_waived_by',    v_d.waiver,
       'promoted_at',          v_reg.promoted_at,
       'grace_until',          v_d.grace_until
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
         'would_be_late_cancel', v_d.would_be_late
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

-- Copied from 20260818000043_preview_cancel_registration.sql; only actor permission predicate changed.
create or replace function public.preview_cancel_registration(
  p_registration_id uuid,
  p_actor_id        uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reg     public.session_registrations;
  v_session public.sessions;
  v_d       record;
  v_outcome text;
  v_reason  text;
  v_free_until timestamptz;
  v_penalty text;
begin
  select * into v_reg
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
   where id = v_reg.session_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session')::text;
  end if;

  if p_actor_id is null
     or not (
       v_reg.user_id = p_actor_id
       or public.actor_has_permission(v_session.gang_id, p_actor_id, 'registration.cancel.other')
     ) then
    raise exception using
      errcode = 'P0001',
      message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'ดูผลการยกเลิกได้เฉพาะเจ้าของใบลงชื่อหรือแอดมิน')::text;
  end if;

  -- สถานะเดียวกับที่ cancel_registration() รับ — ที่เหลือไม่มีอะไรให้ยกเลิก
  if v_reg.status not in ('confirmed', 'waitlist') then
    raise exception using
      errcode = 'P0001',
      message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_reg.status,
        'to_status',       'cancelled'
      )::text;
  end if;

  select * into v_d from public.cancel_decision(v_reg, v_session, false);

  if v_d.blocked then
    v_outcome := 'blocked';
    v_reason  := 'cutoff_passed';
  elsif v_d.waiver = 'promoted_grace' then
    v_outcome    := 'free_in_grace';
    v_reason     := 'promoted_grace';
    v_free_until := v_d.grace_until;
  elsif v_d.is_late then
    v_outcome := 'penalty';
    v_reason  := 'late_cancel';
    v_penalty := v_d.policy ->> 'penalty_type';
  else
    v_outcome := 'free_before_cutoff';
    if v_reg.status = 'waitlist' then
      v_reason := 'waitlist';
    else
      v_reason     := 'before_cutoff';
      -- ถ้ายังอยู่ใน grace ต่อจาก cutoff ก็ฟรีไปถึงสิ้นสุด grace (ตามจริงที่ cancel จะตัดสิน)
      v_free_until := greatest(v_d.cutoff_at, coalesce(v_d.grace_until, v_d.cutoff_at));
    end if;
  end if;

  return jsonb_build_object(
    'outcome',      v_outcome,
    'free_until',   v_free_until,
    'penalty_type', v_penalty,
    'reason',       v_reason
  );
end;
$$;
