-- =============================================================================
-- WO-2.5-F · 0028 — QR เช็คอินต่อการลงชื่อ
-- =============================================================================
-- 🔴 CLAUDE.md §2.5: secret token = `gen_random_bytes(32)` → เก็บเฉพาะ SHA-256 hash
--    ❌ ห้ามใช้ PK (uuidv7 ฝัง timestamp ⇒ เดาได้) เป็น token ของ QR
--    ⇒ ใช้ `new_url_safe_secret()` ตัวเดียวกับ invite/guest token
--
-- 🔴 DoD: "QR ของนัดหนึ่งใช้เช็คอินอีกนัดไม่ได้"
--    บังคับด้วยการรับ `p_session_id` เข้ามาเทียบเสมอ ไม่ใช่หา registration จาก token ล้วน
--
-- Rollback: DROP FUNCTION public.check_in_by_token(uuid, text, uuid, text);
--           DROP FUNCTION public.issue_checkin_token(uuid, uuid, text);
--           DROP INDEX public.session_registrations_checkin_token_key;
--           ALTER TABLE public.session_registrations DROP COLUMN checkin_token_hash;
-- =============================================================================

alter table public.session_registrations
  add column if not exists checkin_token_hash bytea;

comment on column public.session_registrations.checkin_token_hash is
  '[WO-2.5-F] SHA-256 ของ QR เช็คอิน — plaintext คืนครั้งเดียวตอน issue เท่านั้น';

-- ค้นด้วย hash ตอนสแกน + กันชนกันเอง (ความน่าจะเป็นแทบเป็นศูนย์ แต่ index ต้องมีอยู่ดี)
create unique index if not exists session_registrations_checkin_token_key
  on public.session_registrations (checkin_token_hash)
  where checkin_token_hash is not null;


-- -----------------------------------------------------------------------------
-- issue_checkin_token(...) — ออก/ออกใหม่ QR ของการลงชื่อหนึ่งรายการ
-- -----------------------------------------------------------------------------
-- คืน plaintext **ครั้งเดียว** — เรียกซ้ำ = ออกอันใหม่ (อันเก่าใช้ไม่ได้ทันที)
-- ⚠️ ห้าม log ค่าที่คืนไป และห้ามใส่ลง event_logs (CLAUDE.md §2.5)
create or replace function public.issue_checkin_token(
  p_registration_id uuid,
  p_actor_id        uuid default null,
  p_correlation_id  text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg    public.session_registrations;
  v_token  text;
  v_gang   uuid;
begin
  select * into v_reg
    from public.session_registrations
   where id = p_registration_id and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'REGISTRATION_NOT_FOUND',
      detail  = json_build_object('registration_id', p_registration_id)::text;
  end if;

  -- 🔴 ห้ามออก QR ให้คนที่ยังไม่ได้ที่ — ไม่งั้นสแกนแล้วจะเป็นการลัดคิว
  --    (waitlist → checked_in ตรงๆ ผิด state machine ของ baseline)
  if v_reg.status not in ('confirmed', 'checked_in') then
    raise exception using
      errcode = 'P0001', message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', p_registration_id,
        'from_status',     v_reg.status,
        'reason',          'ออก QR เช็คอินได้เฉพาะคนที่ได้ที่แล้ว'
      )::text;
  end if;

  v_token := public.new_url_safe_secret();

  update public.session_registrations
     set checkin_token_hash = extensions.digest(v_token, 'sha256'),
         updated_by = p_actor_id
   where id = p_registration_id;

  select gang_id into v_gang from public.sessions where id = v_reg.session_id;

  -- ⚠️ payload มีแต่ metadata — **ไม่มี plaintext token**
  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_gang, v_reg.session_id, 'registration.checkin_token_issued', 'registration',
     p_registration_id, p_actor_id,
     jsonb_build_object('correlation_id', p_correlation_id));

  return v_token;
end;
$$;


-- -----------------------------------------------------------------------------
-- check_in_by_token(...) — แอดมินสแกน QR แล้วเช็คอินให้
-- -----------------------------------------------------------------------------
create or replace function public.check_in_by_token(
  p_session_id     uuid,
  p_token          text,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns table (registration_id uuid, display_name text, status text, already boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg     public.session_registrations;
  v_session public.sessions;
  v_name    text;
begin
  select * into v_session from public.sessions
   where id = p_session_id and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'session', 'id', p_session_id)::text;
  end if;

  -- 🔴 QR หมดอายุตามนัด — ปิดรอบ/ยกเลิก/เก็บเข้าคลังแล้วสแกนไม่ได้อีก
  if v_session.status not in ('open', 'in_play') then
    raise exception using
      errcode = 'P0001', message = 'SESSION_NOT_OPEN',
      detail  = json_build_object('session_status', v_session.status)::text;
  end if;

  -- 🔴 ผูกกับนัดเสมอ: QR ของนัดอื่นหาไม่เจอในนัดนี้ ⇒ ใช้ข้ามนัดไม่ได้
  select * into v_reg
    from public.session_registrations
   where session_id = p_session_id
     and checkin_token_hash = extensions.digest(p_token, 'sha256')
     and deleted_at is null;

  if not found then
    -- ❌ ห้ามบอกว่า "token นี้เป็นของนัดอื่น" — เท่ากับยืนยันว่า token มีจริง
    raise exception using
      errcode = 'P0001', message = 'CHECKIN_TOKEN_INVALID',
      detail  = json_build_object('session_id', p_session_id)::text;
  end if;

  select coalesce(p.display_name, v_reg.guest_name, 'ไม่ทราบชื่อ') into v_name
    from public.session_registrations r
    left join public.profiles p on p.id = r.user_id
   where r.id = v_reg.id;

  -- สแกนซ้ำ = ไม่เปลี่ยนอะไร ไม่ใช่ error (หน้างานสแกนซ้ำเป็นเรื่องปกติ)
  if v_reg.status = 'checked_in' then
    return query select v_reg.id, v_name, v_reg.status, true;
    return;
  end if;

  if v_reg.status <> 'confirmed' then
    raise exception using
      errcode = 'P0001', message = 'INVALID_REGISTRATION_TRANSITION',
      detail  = json_build_object(
        'registration_id', v_reg.id,
        'from_status',     v_reg.status,
        'to_status',       'checked_in'
      )::text;
  end if;

  -- ใช้ฟังก์ชันเดิม ⇒ event/guard เหมือนกดเช็คอินจากคอนโซลเป๊ะ
  perform public.check_in_registration(v_reg.id, p_actor_id, p_correlation_id);

  return query select v_reg.id, v_name, 'checked_in'::text, false;
end;
$$;


revoke execute on function public.issue_checkin_token(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.check_in_by_token(uuid, text, uuid, text) from public, anon, authenticated;

grant execute on function public.issue_checkin_token(uuid, uuid, text)      to service_role;
grant execute on function public.check_in_by_token(uuid, text, uuid, text)  to service_role;
