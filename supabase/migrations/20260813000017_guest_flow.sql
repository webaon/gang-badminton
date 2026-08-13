-- =============================================================================
-- WO-2.5 · 0017 — ลิงก์เชิญ + guest access token
-- =============================================================================
-- เติมสิ่งที่ WO-1.3 จงใจไม่ทำ (อยู่ใน BACKLOG มาตั้งแต่ตอนนั้น):
--   "guest_access_token_hash ยังไม่ถูก generate — register_to_session() ไม่สร้างให้
--    ⇒ หน้า guest ดู/ยกเลิกเองยังทำไม่ได้"
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 กติกาเรื่อง secret (baseline §Database Schema [v3.2] · CLAUDE.md §2.5)
--
--   - secret ต้องมาจาก `gen_random_bytes(32)` **ห้ามใช้ UUID ทุกชนิด**
--     (UUIDv7 ฝัง timestamp ⇒ เดาได้จากเวลาที่สร้าง)
--   - เก็บเฉพาะ SHA-256 hash ในฐานข้อมูล
--   - คืน plaintext **ครั้งเดียวตอนสร้าง** แล้วไม่มีทางอ่านย้อนหลังได้อีก
--   - ❌ ห้าม log plaintext ที่ใดทั้งสิ้น รวมถึง `event_logs`
--
-- ⇒ ฟังก์ชันในไฟล์นี้เป็นที่เดียวที่ plaintext มีตัวตน หลังจากคืนค่าไปแล้ว
--   ระบบจะรู้จักแค่ hash
--
-- Rollback: DROP FUNCTION public.create_session_invite(uuid, timestamptz, integer, uuid, text);
--           DROP FUNCTION public.register_guest(uuid, text, text, text, text);
--           DROP FUNCTION public.guest_registration(uuid, text);
--           DROP FUNCTION public.cancel_registration_as_guest(uuid, text, text);
--           DROP FUNCTION public.new_url_safe_secret();
-- =============================================================================

-- -----------------------------------------------------------------------------
-- new_url_safe_secret() — 32 bytes สุ่ม → base64url
-- -----------------------------------------------------------------------------
-- base64 ธรรมดามี `+` `/` `=` ซึ่งต้อง encode ตอนอยู่ใน URL ⇒ ใช้ base64url แทน
-- (`translate` ที่ 'to' สั้นกว่า 'from' จะ **ลบ** อักขระที่เกินออก — จึงตัด `=` ทิ้ง)
create or replace function public.new_url_safe_secret()
returns text
language sql
volatile
set search_path = ''
as $$
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

comment on function public.new_url_safe_secret() is
  'secret 32 bytes แบบ base64url — ใช้กับ invite token และ guest access token';


-- -----------------------------------------------------------------------------
-- create_session_invite(...) — ลิงก์เชิญต่อนัด
-- -----------------------------------------------------------------------------
-- คืน plaintext **ครั้งเดียว** — เก็บเฉพาะ hash
create or replace function public.create_session_invite(
  p_session_id     uuid,
  p_expires_at     timestamptz default null,
  p_max_uses       integer     default 20,
  p_actor_id       uuid        default null,
  p_correlation_id text        default null
)
returns table (id uuid, token text, expires_at timestamptz, max_uses integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token   text := public.new_url_safe_secret();
  v_expires timestamptz := coalesce(p_expires_at, now() + interval '7 days');
  v_row     public.session_invite_tokens;
  v_gang_id uuid;
begin
  select s.gang_id into v_gang_id
    from public.sessions s
   where s.id = p_session_id and s.deleted_at is null;

  if v_gang_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session', 'session_id', p_session_id)::text;
  end if;

  if p_max_uses < 1 then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'max_uses')::text;
  end if;

  insert into public.session_invite_tokens
    (session_id, token_hash, expires_at, max_uses, created_by)
  values
    (p_session_id, extensions.digest(v_token, 'sha256'), v_expires, p_max_uses, p_actor_id)
  returning * into v_row;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_gang_id, p_session_id, 'session.invite_created', 'session', p_session_id, p_actor_id,
     -- 🔴 ไม่มี plaintext ใน payload
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'token_id',       v_row.id,
       'max_uses',       p_max_uses,
       'expires_at',     v_expires
     ));

  return query select v_row.id, v_token, v_row.expires_at, v_row.max_uses;
end;
$$;

comment on function public.create_session_invite(uuid, timestamptz, integer, uuid, text) is
  'สร้างลิงก์เชิญ — คืน plaintext ครั้งเดียว เก็บเฉพาะ hash ห้าม log plaintext';


-- -----------------------------------------------------------------------------
-- register_guest(...) — guest ลงชื่อผ่านลิงก์เชิญ
-- -----------------------------------------------------------------------------
-- ห่อ register_to_session() แล้วเติม guest access token ให้ในตัว
--
-- ⚠️ **ไม่ทำซ้ำ logic การนับที่ว่าง** — เรียก register_to_session() ซึ่งถือ lock
--    แถว session อยู่แล้ว ถ้าเขียนใหม่จะกลายเป็นทางที่สองที่ overbook ได้
create or replace function public.register_guest(
  p_session_id     uuid,
  p_guest_name     text,
  p_guest_phone    text default null,
  p_invite_token   text default null,
  p_correlation_id text default null
)
returns table (registration_id uuid, status text, guest_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg         public.session_registrations;
  v_guest_token text := public.new_url_safe_secret();
begin
  -- ตรวจ feature flag / invite token / ที่ว่าง ทั้งหมดอยู่ในนี้
  v_reg := public.register_to_session(
    p_session_id,
    null,               -- user_id = null ⇒ guest
    p_guest_name,
    p_guest_phone,
    p_invite_token,
    null,
    p_correlation_id
  );

  update public.session_registrations
     set guest_access_token_hash = extensions.digest(v_guest_token, 'sha256')
   where id = v_reg.id
  returning * into v_reg;

  return query select v_reg.id, v_reg.status, v_guest_token;
end;
$$;

comment on function public.register_guest(uuid, text, text, text, text) is
  'guest ลงชื่อผ่านลิงก์เชิญ + ได้ token ดู/ยกเลิกเอง — คืน plaintext ครั้งเดียว';


-- -----------------------------------------------------------------------------
-- guest_registration(registration_id, guest_token) — guest ดูสถานะตัวเอง
-- -----------------------------------------------------------------------------
-- 🔴 ต้องส่งทั้ง id และ token — ตรวจ token ทุกครั้ง ไม่ใช่แค่รู้ id ก็ดูได้
create or replace function public.guest_registration(
  p_registration_id uuid,
  p_guest_token     text
)
returns table (
  registration_id uuid,
  status          text,
  guest_name      text,
  session_id      uuid,
  session_title   text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  venue           text,
  timezone        text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select r.id, r.status, r.guest_name, s.id, s.title, s.starts_at, s.ends_at, s.venue, g.timezone
      from public.session_registrations r
      join public.sessions s on s.id = r.session_id
      join public.gangs g    on g.id = s.gang_id
     where r.id         = p_registration_id
       and r.deleted_at is null
       and r.guest_access_token_hash is not null
       and r.guest_access_token_hash = extensions.digest(p_guest_token, 'sha256');

  if not found then
    -- ข้อความเดียวกันทั้งเคส "ไม่มี registration" และ "token ผิด"
    -- เพื่อไม่ให้ใช้เดาว่า registration id ไหนมีอยู่จริง
    raise exception using
      errcode = 'P0001',
      message = 'GUEST_ACCESS_DENIED',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- cancel_registration_as_guest(...) — guest ยกเลิกเอง
-- -----------------------------------------------------------------------------
create or replace function public.cancel_registration_as_guest(
  p_registration_id uuid,
  p_guest_token     text,
  p_correlation_id  text default null
)
returns public.session_registrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  select exists (
    select 1
      from public.session_registrations r
     where r.id         = p_registration_id
       and r.deleted_at is null
       and r.guest_access_token_hash is not null
       and r.guest_access_token_hash = extensions.digest(p_guest_token, 'sha256')
  ) into v_ok;

  if not v_ok then
    raise exception using
      errcode = 'P0001',
      message = 'GUEST_ACCESS_DENIED',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  -- ใช้เส้นทางเดิม ⇒ penalty/cutoff/promote ทำงานเหมือนกับที่สมาชิกยกเลิก
  return public.cancel_registration(p_registration_id, null, p_correlation_id);
end;
$$;


-- -----------------------------------------------------------------------------
-- session_by_invite_token(token) — ข้อมูลนัดสำหรับหน้าเชิญ (ก่อนลงชื่อ)
-- -----------------------------------------------------------------------------
-- 🔴 คืนเฉพาะข้อมูลที่จำเป็นต้องโชว์ให้คนถือลิงก์เห็น
--    ไม่คืนรายชื่อผู้เล่น ไม่คืน snapshot (มีราคา/PromptPay) ไม่คืน gang_id
--    คนถือลิงก์ยังไม่ใช่สมาชิกก๊วน จึงไม่ควรเห็นอะไรมากกว่านี้
--
-- ⚠️ ไม่ raise เมื่อ token ผิด แต่คืน 0 แถว ⇒ ผู้เรียกตัดสินใจเองว่าจะแสดงอะไร
--    (หน้าเชิญควรขึ้น "ลิงก์ไม่ถูกต้องหรือหมดอายุ" เหมือนกันหมด ไม่แยกสาเหตุ)
create or replace function public.session_by_invite_token(p_token text)
returns table (
  session_id      uuid,
  title           text,
  venue           text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  timezone        text,
  gang_name       text,
  max_players     integer,
  occupied_seats  integer,
  is_open         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.venue, s.starts_at, s.ends_at, g.timezone, g.name,
         s.max_players,
         public.session_occupied_seats(s.id),
         (s.status = 'open')
    from public.session_invite_tokens t
    join public.sessions s on s.id = t.session_id
    join public.gangs g    on g.id = s.gang_id
   where t.token_hash  = extensions.digest(p_token, 'sha256')
     and t.revoked_at  is null
     and t.expires_at  > now()
     and t.used_count  < t.max_uses
     and s.deleted_at  is null
     and g.deleted_at  is null;
$$;


-- -----------------------------------------------------------------------------
-- grants — เหมือนทุก DB function: server เท่านั้น
-- -----------------------------------------------------------------------------
revoke execute on function public.new_url_safe_secret()                                      from public, anon, authenticated;
revoke execute on function public.create_session_invite(uuid, timestamptz, integer, uuid, text) from public, anon, authenticated;
revoke execute on function public.register_guest(uuid, text, text, text, text)                from public, anon, authenticated;
revoke execute on function public.guest_registration(uuid, text)                              from public, anon, authenticated;
revoke execute on function public.cancel_registration_as_guest(uuid, text, text)              from public, anon, authenticated;
revoke execute on function public.session_by_invite_token(text)                               from public, anon, authenticated;

grant execute on function public.new_url_safe_secret()                                        to service_role;
grant execute on function public.create_session_invite(uuid, timestamptz, integer, uuid, text) to service_role;
grant execute on function public.register_guest(uuid, text, text, text, text)                 to service_role;
grant execute on function public.guest_registration(uuid, text)                               to service_role;
grant execute on function public.cancel_registration_as_guest(uuid, text, text)               to service_role;
grant execute on function public.session_by_invite_token(text)                                to service_role;
