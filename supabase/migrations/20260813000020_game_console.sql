-- =============================================================================
-- WO-2.7 · 0020 — Game Console: คิวสด + สลับตัวผู้เล่น
-- =============================================================================
-- เติมสองอย่างที่ WO-2.6 ค้างไว้:
--   1. ไม่มีใครคำนวณ `waitingSince` / `gamesPlayed` ให้ Matching Engine
--   2. ผลจัดคู่ยังไม่ถูกบันทึกลง `games`
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 ทำไม `session_console_queue()` เป็น DB function ไม่ใช่ query ฝั่ง TS
--
-- ต้องนับจำนวนเกมของแต่ละคนจาก **4 คอลัมน์** (`player1..player4`) และหาเวลาที่
-- จบเกมล่าสุด ⇒ เขียนฝั่ง TS จะกลายเป็นดึงเกมทั้งหมดมานับเองใน memory (N+1
-- และผิดง่ายเมื่อคนเดียวอยู่หลายเกม) — SQL ทำได้ในคำสั่งเดียวและอ่านง่ายกว่า
--
-- ⚠️ ฟังก์ชันนี้ **ไม่ตัดสินใจอะไร** — คืนข้อมูลดิบให้ `domain/matching` ตัดสิน
--    ห้ามย้าย logic การจัดคู่ลงมาที่นี่ (baseline: engine เป็น pure function)
--
-- Rollback: DROP FUNCTION public.session_console_queue(uuid);
--           DROP FUNCTION public.substitute_game_player(uuid, integer, uuid, uuid, text);
-- =============================================================================

-- -----------------------------------------------------------------------------
-- session_console_queue(session_id)
-- -----------------------------------------------------------------------------
-- คืนคนที่ "เช็คอินแล้ว" ทุกคน พร้อมตัวเลขที่ engine ต้องใช้
--
-- `waiting_since` = เวลาที่จบเกมล่าสุด ถ้ายังไม่เคยเล่นใช้เวลาเช็คอิน
--   ⇒ เลขน้อย = รอนานกว่า ตรงกับที่ `domain/matching` คาดหวัง
create or replace function public.session_console_queue(p_session_id uuid)
returns table (
  registration_id uuid,
  display_name    text,
  is_guest        boolean,
  skill_rank      integer,
  games_played    integer,
  waiting_since   timestamptz,
  current_game_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with checked_in as (
    select r.id,
           coalesce(p.display_name, r.guest_name) as display_name,
           (r.user_id is null)                    as is_guest,
           sl.rank                                as skill_rank,
           r.checked_in_at
      from public.session_registrations r
      join public.sessions s          on s.id = r.session_id
      left join public.profiles p     on p.id = r.user_id
      left join public.gang_members m on m.gang_id = s.gang_id
                                     and m.user_id = r.user_id
                                     and m.deleted_at is null
      left join public.gang_skill_levels sl on sl.id = m.skill_level_id
     where r.session_id = p_session_id
       and r.deleted_at is null
       and r.status     = 'checked_in'
  ),
  -- แตกผู้เล่นทั้ง 4 คอลัมน์ออกเป็นแถว เพื่อให้นับต่อคนได้
  game_slots as (
    select g.id as game_id, g.ended_at, unnest(array[
             g.player1_registration_id, g.player2_registration_id,
             g.player3_registration_id, g.player4_registration_id
           ]) as registration_id
      from public.games g
     where g.session_id = p_session_id
  )
  select c.id,
         c.display_name,
         c.is_guest,
         c.skill_rank,
         coalesce(count(gs.game_id) filter (where gs.game_id is not null), 0)::integer,
         coalesce(max(gs.ended_at), c.checked_in_at, now()),
         -- เกมที่ยังไม่จบ = กำลังอยู่ในคอร์ท
         -- (ไม่มี max(uuid) ใน Postgres และคนหนึ่งอยู่ในเกมที่ยังไม่จบได้แค่เกมเดียว
         --  อยู่แล้ว จึงหยิบตัวแรกจาก array)
         (array_agg(gs.game_id) filter (where gs.ended_at is null))[1]
    from checked_in c
    left join game_slots gs on gs.registration_id = c.id
   group by c.id, c.display_name, c.is_guest, c.skill_rank, c.checked_in_at
   order by c.display_name;
$$;

comment on function public.session_console_queue(uuid) is
  'คิวของ Game Console — คืนข้อมูลดิบให้ domain/matching ตัดสิน ไม่ตัดสินใจเอง';


-- -----------------------------------------------------------------------------
-- substitute_game_player(...) — แอดมินสลับตัว/ลากสลับ
-- -----------------------------------------------------------------------------
-- 🔴 baseline: "แอดมินลากสลับ override ได้เสมอ"
--
-- ครอบสองเคสด้วย primitive เดียว:
--   - ผู้เล่นใหม่กำลังอยู่ในอีกคอร์ท → **สลับที่กัน**
--   - ผู้เล่นใหม่นั่งพักอยู่           → เข้าแทนที่เฉยๆ
--
-- ⚠️ ต้อง atomic — ถ้าแยกเป็นสอง UPDATE แล้วพังกลางทางจะเหลือคนซ้ำสองคอร์ท
--    ซึ่ง CHECK `games_distinct_players` จะบล็อก แต่ทิ้งสถานะครึ่งๆ กลางๆ ไว้
create or replace function public.substitute_game_player(
  p_game_id         uuid,
  p_slot            integer,
  p_registration_id uuid,
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game       public.games;
  v_session_id uuid;
  v_gang_id    uuid;
  v_outgoing   uuid;
  v_other_game public.games;
  v_other_slot integer;
  v_columns    constant text[] := array[
    'player1_registration_id', 'player2_registration_id',
    'player3_registration_id', 'player4_registration_id'
  ];
begin
  if p_slot not between 1 and 4 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'slot', 'value', p_slot)::text;
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'game', 'id', p_game_id)::text;
  end if;

  v_session_id := v_game.session_id;

  select s.gang_id into v_gang_id from public.sessions s where s.id = v_session_id;

  -- ผู้เล่นที่จะเข้ามาต้องเช็คอินอยู่ในนัดเดียวกัน
  if not exists (
    select 1 from public.session_registrations r
     where r.id = p_registration_id
       and r.session_id = v_session_id
       and r.deleted_at is null
       and r.status = 'checked_in'
  ) then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'reason', 'ผู้เล่นต้องเช็คอินในนัดนี้ก่อนถึงจะลงสนามได้')::text;
  end if;

  v_outgoing := case p_slot
                  when 1 then v_game.player1_registration_id
                  when 2 then v_game.player2_registration_id
                  when 3 then v_game.player3_registration_id
                  else        v_game.player4_registration_id
                end;

  if v_outgoing = p_registration_id then
    return v_game;   -- ไม่มีอะไรเปลี่ยน
  end if;

  -- คนที่จะเข้ามาอยู่ในเกมที่ยังไม่จบเกมอื่นหรือไม่
  select g.* into v_other_game
    from public.games g
   where g.session_id = v_session_id
     and g.ended_at is null
     and g.id <> p_game_id
     and p_registration_id in (
       g.player1_registration_id, g.player2_registration_id,
       g.player3_registration_id, g.player4_registration_id
     )
   for update;

  if found then
    -- สลับที่กัน: หา slot ของเขาในเกมนั้นแล้วเอาคนที่ออกไปใส่แทน
    v_other_slot := case p_registration_id
                      when v_other_game.player1_registration_id then 1
                      when v_other_game.player2_registration_id then 2
                      when v_other_game.player3_registration_id then 3
                      else 4
                    end;

    execute format(
      'update public.games set %I = $1, updated_by = $2 where id = $3',
      v_columns[v_other_slot]
    ) using v_outgoing, p_actor_id, v_other_game.id;
  end if;

  execute format(
    'update public.games set %I = $1, updated_by = $2 where id = $3',
    v_columns[p_slot]
  ) using p_registration_id, p_actor_id, p_game_id;

  select * into v_game from public.games where id = p_game_id;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_gang_id, v_session_id, 'game.player_substituted', 'game', p_game_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'slot',           p_slot,
       'incoming',       p_registration_id,
       'outgoing',       v_outgoing,
       'swapped_with',   v_other_game.id
     ));

  return v_game;
end;
$$;

comment on function public.substitute_game_player(uuid, integer, uuid, uuid, text) is
  'แอดมินสลับตัวในคอร์ท — สลับกับอีกคอร์ทหรือเอาคนพักเข้าแทน ทำใน transaction เดียว';


revoke execute on function public.session_console_queue(uuid)                              from public, anon, authenticated;
revoke execute on function public.substitute_game_player(uuid, integer, uuid, uuid, text)  from public, anon, authenticated;

grant execute on function public.session_console_queue(uuid)                               to service_role;
grant execute on function public.substitute_game_player(uuid, integer, uuid, uuid, text)   to service_role;
