-- =============================================================================
-- WO-2.5-A · 0024 — แก้ผลหลังจบเกม + no-show ที่เชื่อถือได้
-- =============================================================================
-- ปลดล็อก blocker ที่ Phase 2 ทิ้งไว้ ก่อนเปิด `court_plus_shuttle` ในใบถัดไป
--
-- 🔴 ทำไมต้องมาก่อน billing strategy
--    `court_plus_shuttle` คิดเงินจาก **จำนวนลูก** ⇒ ตอนนี้กรอกผิดแล้วแก้ไม่ได้เลย
--    จะกลายเป็น "คิดเงินผิดถาวร" ทันทีที่เปิดโมเดลนั้น
--    (ตอนเป็น flat_rate ตัวเลขนี้ไม่เข้าสูตร จึงยังไม่มีใครเดือดร้อน)
--
-- Rollback: DROP FUNCTION public.update_game_shuttles(uuid, numeric, uuid, text);
--           DROP FUNCTION public.mark_no_show(uuid, uuid, text);
--           DROP FUNCTION public.check_in_all(uuid, uuid, text);
-- =============================================================================

-- -----------------------------------------------------------------------------
-- update_game_shuttles(...) — แก้จำนวนลูกย้อนหลัง
-- -----------------------------------------------------------------------------
-- 🔴 แก้ได้เฉพาะตอนนัด **ยังไม่ปิดรอบ**
--    หลัง `billing` แล้ว charges ถูก commit ไปแล้ว (ADR-001) การแก้ตัวเลขต้นทาง
--    จะทำให้ยอดที่เก็บไปแล้วกับข้อมูลที่ใช้คำนวณไม่ตรงกัน โดยไม่มีใครรู้
--    ⇒ ต้อง raise ไม่ใช่ปล่อยผ่านเงียบๆ
create or replace function public.update_game_shuttles(
  p_game_id        uuid,
  p_shuttles       numeric,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game    public.games;
  v_session public.sessions;
  v_before  numeric;
begin
  if p_shuttles is null or p_shuttles < 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'shuttles_used', 'value', p_shuttles)::text;
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'game', 'id', p_game_id)::text;
  end if;

  select * into v_session from public.sessions where id = v_game.session_id;

  if v_session.status not in ('open', 'in_play') then
    raise exception using
      errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail  = json_build_object(
        'session_status', v_session.status,
        'reason', 'แก้จำนวนลูกได้ก่อนปิดรอบเท่านั้น — ปิดรอบแล้วต้องใช้ payment_adjustments'
      )::text;
  end if;

  v_before := v_game.shuttles_used;

  update public.games
     set shuttles_used = p_shuttles, updated_by = p_actor_id
   where id = p_game_id
  returning * into v_game;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_session.gang_id, v_session.id, 'game.shuttles_corrected', 'game', p_game_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'before',         v_before,
       'after',          p_shuttles
     ));

  return v_game;
end;
$$;

comment on function public.update_game_shuttles(uuid, numeric, uuid, text) is
  '[WO-2.5-A] แก้จำนวนลูกก่อนปิดรอบเท่านั้น — บันทึกค่าเดิม/ค่าใหม่ลง event';


-- -----------------------------------------------------------------------------
-- mark_no_show(...) — เดิมเขียนตรงจาก server action ไม่มี event และไม่มี guard
-- -----------------------------------------------------------------------------
create or replace function public.mark_no_show(
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
  v_from    text;
begin
  select * into v_reg
    from public.session_registrations
   where id = p_registration_id and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  v_from := v_reg.status;

  -- ไม่มาได้เฉพาะคนที่เคยได้ที่ — waitlist/cancelled ไม่มีที่ให้ "ไม่มา"
  if v_from not in ('confirmed', 'checked_in') then
    raise exception using
      errcode = 'P0001', message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_from,
        'to_status',       'no_show'
      )::text;
  end if;

  update public.session_registrations
     set status = 'no_show', updated_by = p_actor_id
   where id = p_registration_id
  returning * into v_reg;

  select gang_id into v_gang_id from public.sessions where id = v_reg.session_id;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_gang_id, v_reg.session_id, 'registration.no_show', 'registration',
     p_registration_id, p_actor_id,
     jsonb_build_object('correlation_id', p_correlation_id, 'from_status', v_from));

  return v_reg;
end;
$$;


-- -----------------------------------------------------------------------------
-- check_in_all(...) — เช็คอินทุกคนที่ได้ที่รวดเดียว
-- -----------------------------------------------------------------------------
-- 🔴 เหตุผลที่ต้องมี: `confirmed` ที่ไม่เคยเช็คอินถูกคิดเงินเหมือนไม่มา
--    ⇒ แอดมินที่ลืมเปิดคอนโซลทั้งวันจะทำให้ทุกคนโดนเก็บเงินเต็ม
--    ปุ่มนี้คือทางออกที่เร็วที่สุดหน้างาน
--
-- เรียก `check_in_registration()` ทีละคนเพื่อให้ event/guard เหมือนเช็คอินทีละคนเป๊ะ
create or replace function public.check_in_all(
  p_session_id     uuid,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_count integer := 0;
begin
  for v_id in
    select id from public.session_registrations
     where session_id = p_session_id
       and status     = 'confirmed'
       and deleted_at is null
     order by created_at
  loop
    perform public.check_in_registration(v_id, p_actor_id, p_correlation_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


revoke execute on function public.update_game_shuttles(uuid, numeric, uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_no_show(uuid, uuid, text)                  from public, anon, authenticated;
revoke execute on function public.check_in_all(uuid, uuid, text)                  from public, anon, authenticated;

grant execute on function public.update_game_shuttles(uuid, numeric, uuid, text)  to service_role;
grant execute on function public.mark_no_show(uuid, uuid, text)                   to service_role;
grant execute on function public.check_in_all(uuid, uuid, text)                   to service_role;
