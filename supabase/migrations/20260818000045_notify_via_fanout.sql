-- =============================================================================
-- 20260818000045 — WO-R4: waitlist.promoted + payment.due ส่งถึง LINE (ผ่าน enqueue_notifications ทางเดียว)
-- =============================================================================
-- ที่มา (ADR-014 §1.2): 3 เหตุการณ์ insert `in_app` ตรง ไม่ผ่าน enqueue_notifications()
--   ⇒ LINE ไม่เคยได้ทั้งที่มีข้อความรอใน domain/notifications/line-message.ts
-- คำตัดสินเจ้าของงาน (28 ต.ค.):
--   waitlist.promoted + payment.due ⇒ in_app + line
--   session.opened                  ⇒ in_app เท่านั้น (โควต้า LINE 200/เดือน)
--
-- สิ่งที่ migration นี้ทำ (ทั้งหมด CREATE OR REPLACE — signature เดิม ⇒ GRANT/EXECUTE matrix ไม่เปลี่ยน)
--   1. enqueue_notifications(rows)   เพิ่มคีย์ `channels` (jsonb array) ต่อแถวอินพุต:
--        ไม่ส่ง/null = in_app + line (พฤติกรรมเดิมทุกอย่าง) · ["in_app"] = ไม่ fan-out ไป line
--        ⇒ ผู้เรียกเดิมทุกตัว (reminders, announcement, join request) ไม่เปลี่ยนพฤติกรรม
--   2. enqueue_session_notification  เข้าคิวผ่าน enqueue_notifications() แทน insert ตรง
--        · dedupe_key = '<event_type>:<session_id>:<user_id>' (เดิมไม่มี key ⇒ เรียกซ้ำเกิดแถวซ้ำ)
--        · session.opened ⇒ channels ["in_app"] (บังคับที่ DB ไม่ขึ้นกับผู้เรียก)
--        · 'charged' เฉพาะคนที่ยัง "ค้างจริง" (charge_outstanding > 0) — ADR-010: หนี้ที่เครดิตหักจนเหลือ 0
--          ต้องไม่ถูกบอกว่า "มียอดที่ต้องจ่าย" (เดิมกรองแค่ amount > 0)
--   3. promote_waitlist              insert ตรงของ waitlist.promoted → enqueue_notifications()
--        · dedupe_key = 'waitlist.promoted:<registration_id>' (หนึ่งใบลงชื่อถูกเลื่อนได้ครั้งเดียว)
--        · เพิ่ม session_title ใน payload (ข้อความ LINE "คิวถึงคุณแล้ว: <ชื่อนัด>")
--        · 🔴 ไม่เปลี่ยนผล/transition/ลำดับ lock ใดๆ — แก้เฉพาะบล็อกแจ้งเตือน (ส่วนอื่นคัดลอกจาก 0041 ทุกบรรทัด)
--
-- ⚠️ ค่าที่ enqueue_session_notification คืน = จำนวนแถวใหม่ "รวมทุก channel" (ตามนิยามของ enqueue_notifications)
--    ผู้เรียก (server/actions) ไม่ได้ใช้ค่านี้
-- ⚠️ guest ไม่มีบัญชี ⇒ ไม่มีแจ้งเตือนเหมือนเดิม
--
-- ROLLBACK: re-apply enqueue_notifications จาก 20260816000037 · enqueue_session_notification จาก
--           20260813000023 · promote_waitlist จาก 20260818000041
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. enqueue_notifications — เพิ่ม `channels` ต่อแถว (ที่เหลือเหมือน 0037 ทุกอย่าง)
-- -----------------------------------------------------------------------------
create or replace function public.enqueue_notifications(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'rows', 'reason', 'ต้องเป็น array')::text;
  end if;

  with input as (
    select *
      from jsonb_to_recordset(p_rows)
        as r(gang_id uuid, recipient_id uuid, event_type text, payload jsonb, dedupe_key text,
             channels jsonb)
     where gang_id is not null
       and recipient_id is not null
       and event_type is not null
  ),
  targets as (
    -- ช่องทางพื้นฐานของทุกก๊วน — คีย์เดิมเป๊ะ ห้ามแตะ
    select i.gang_id, i.recipient_id, i.event_type, i.payload,
           'in_app'::text as channel, i.dedupe_key
      from input i

    union all

    -- ช่องทางเสริม: เฉพาะก๊วนที่เปิด LINE + คนที่ผูกบัญชีไว้และไม่ได้บล็อก OA
    -- และเฉพาะตอนที่ยังไม่เกินโควต้าของเดือนนั้น
    -- [WO-R4] และเฉพาะแถวที่ไม่ได้จำกัดช่องทาง (channels ว่าง/null = ทุกช่อง · ["in_app"] = ไม่ส่ง LINE)
    select i.gang_id, i.recipient_id, i.event_type, i.payload,
           'line'::text,
           case when i.dedupe_key is null then null else i.dedupe_key || ':line' end
      from input i
      join public.gang_line_configs c
        on c.gang_id = i.gang_id and c.is_enabled
      join public.member_line_links l
        on l.gang_id = i.gang_id and l.user_id = i.recipient_id and l.blocked_at is null
      where not coalesce((select q.is_over from public.line_quota_status(i.gang_id) q), false)
        and (i.channels is null or jsonb_typeof(i.channels) <> 'array' or i.channels ? 'line')
  ),
  inserted as (
    insert into public.notifications
      (gang_id, recipient_id, channel, event_type, payload, dedupe_key)
    select t.gang_id, t.recipient_id, t.channel, t.event_type,
           coalesce(t.payload, '{}'::jsonb), t.dedupe_key
      from targets t
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1
  )
  select count(*)::integer into v_created from inserted;

  return v_created;
end;
$$;

comment on function public.enqueue_notifications(jsonb) is
  '[WO-4.C][WO-R4] เข้าคิว in_app เสมอ + fan-out `line` ให้คนที่ผูกบัญชีไว้ (คีย์ line = "<คีย์เดิม>:line") · แถวอินพุตใส่ channels:["in_app"] เพื่อไม่ส่ง LINE';


-- -----------------------------------------------------------------------------
-- 2. enqueue_session_notification — ผ่าน enqueue_notifications ทางเดียว
-- -----------------------------------------------------------------------------
create or replace function public.enqueue_session_notification(
  p_session_id     uuid,
  p_event_type     text,
  p_audience       text default 'gang_members',
  p_correlation_id text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gang_id  uuid;
  v_title    text;
  v_channels jsonb;
  v_rows     jsonb;
begin
  select s.gang_id, s.title into v_gang_id, v_title
    from public.sessions s
   where s.id = p_session_id and s.deleted_at is null;

  if v_gang_id is null then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session', 'id', p_session_id)::text;
  end if;

  if p_audience not in ('gang_members', 'charged') then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'audience', 'value', p_audience)::text;
  end if;

  -- เจ้าของงานตัดสิน: เปิดรับสมัครนัดใหม่ = in_app เท่านั้น (ประหยัดโควต้า LINE) · อย่างอื่นได้ทุกช่อง
  v_channels := case when p_event_type = 'session.opened' then '["in_app"]'::jsonb else null end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'gang_id',      v_gang_id,
           'recipient_id', rc.user_id,
           'event_type',   p_event_type,
           'payload',      jsonb_build_object(
                             'correlation_id', p_correlation_id,
                             'session_id',     p_session_id,
                             'session_title',  v_title
                           ),
           'dedupe_key',   p_event_type || ':' || p_session_id || ':' || rc.user_id,
           'channels',     v_channels
         )), '[]'::jsonb)
    into v_rows
    from (
      select gm.user_id
        from public.gang_members gm
       where p_audience = 'gang_members'
         and gm.gang_id = v_gang_id
         and gm.deleted_at is null

      union

      select r.user_id
        from public.session_charges sc
        join public.session_registrations r on r.id = sc.registration_id
       where p_audience = 'charged'
         and sc.session_id = p_session_id
         and sc.type = 'session'
         and sc.amount > 0
         -- [WO-R4 · ADR-010] หนี้ที่เครดิตหักจนเหลือ 0 ไม่ต้องบอกว่า "มียอดที่ต้องจ่าย"
         and public.charge_outstanding(sc.id) > 0
         and r.user_id is not null
    ) rc
   where rc.user_id is not null;

  return public.enqueue_notifications(v_rows);
end;
$$;

comment on function public.enqueue_session_notification(uuid, text, text, text) is
  '[WO-2.10][WO-R4] เข้าคิวผ่าน enqueue_notifications() (in_app + line) · session.opened = in_app เท่านั้น · dedupe_key ต่อ event+นัด+คน · charged = เฉพาะคนที่ยังค้างจริง';


-- -----------------------------------------------------------------------------
-- 3. promote_waitlist — เหมือน 0041 ทุกบรรทัด ยกเว้นบล็อกแจ้งเตือน
-- -----------------------------------------------------------------------------
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

comment on function public.promote_waitlist(uuid, integer, uuid, text, uuid) is

  '[D-8][ADR-011][WO-R4] ทางเดียวที่ waitlist → confirmed · p_registration_id = แอดมินเลือกคนเอง · เขียน promoted_at · แจ้งเตือน waitlist.promoted ผ่าน enqueue_notifications (in_app + line, dedupe ต่อใบลงชื่อ)';
