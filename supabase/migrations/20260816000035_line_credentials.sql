-- =============================================================================
-- WO-4.A · 0035 — LINE credentials ผ่าน Supabase Vault
-- =============================================================================
-- baseline §การตัดสินใจสำคัญ: "เข้ารหัส LINE credentials — Supabase Vault เป็นหลัก
-- (fallback: AES-256-GCM ฝั่งแอป, key จาก env — ห้ามอยู่ใน DB); `gang_line_configs`
-- เก็บเฉพาะ secret id, ถอดรหัสเฉพาะ server"
--
-- ✅ ยืนยันของจริงก่อนเขียนใบนี้: `supabase_vault 0.3.1` ติดตั้งอยู่ **ทั้ง local และ cloud**
--    พร้อม `vault.create_secret()` / `vault.update_secret()` / view `vault.decrypted_secrets`
--    ⇒ **ไม่ต้องใช้ fallback AES-256-GCM** (ถ้าวันหนึ่ง Vault หายไป ค่อยทำ deviation ใหม่)
--
-- 🔴 กติกาของไฟล์นี้
--    · ตาราง `gang_line_configs` เก็บได้แค่ **secret id (uuid)** — ห้ามมี plaintext เด็ดขาด
--    · ฟังก์ชันที่คืน plaintext มีตัวเดียว (`get_gang_line_credentials`) และ grant ให้
--      `service_role` เท่านั้น ⇒ ใช้ได้เฉพาะ webhook/worker ฝั่ง server
--    · หน้าจอใช้ `gang_line_status()` ซึ่งคืน **ค่าที่ปิดบังแล้ว** (4 ตัวท้าย) เท่านั้น
--      ⇒ plaintext ไม่มีวันเดินทางออกจากฐานข้อมูลไปหา browser แม้แต่ครั้งเดียว
--
-- ⚠️ `gangs.features.line` = flag ที่ `can()` อ่าน · `gang_line_configs.is_enabled` =
--    "ตั้งค่าครบและเปิดใช้แล้ว" ที่ฝั่ง server ตรวจ — **ตั้งพร้อมกันเสมอผ่าน
--    `set_gang_line_enabled()` เท่านั้น** ห้ามแก้ทีละที่ ไม่งั้นสองค่านี้จะเบี่ยงจากกัน
--
-- Rollback:
--   DROP FUNCTION public.clear_gang_line_credentials(uuid, uuid, text);
--   DROP FUNCTION public.set_gang_line_enabled(uuid, boolean, uuid, text);
--   DROP FUNCTION public.gang_line_status(uuid);
--   DROP FUNCTION public.get_gang_line_credentials(uuid);
--   DROP FUNCTION public.set_gang_line_credentials(uuid, text, text, text, uuid, text);
--   DROP FUNCTION public.line_secret_upsert(text, text);
-- =============================================================================


-- -----------------------------------------------------------------------------
-- helper — เก็บค่าลง Vault แล้วคืน secret id
-- -----------------------------------------------------------------------------
-- ชื่อ secret ต้องไม่ซ้ำใน Vault ⇒ ผูกกับก๊วน (`line_access_token:<gang_id>`)
-- ถ้ามีชื่อนี้อยู่แล้ว = **หมุนค่าใหม่ทับของเดิม** ไม่ใช่สร้างใบใหม่ทิ้งใบเก่าค้างไว้
create or replace function public.line_secret_upsert(p_name text, p_value text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;

  if v_id is null then
    v_id := vault.create_secret(p_value, p_name, 'LINE credential ของก๊วน (WO-4.A)');
  else
    perform vault.update_secret(v_id, p_value);
  end if;

  return v_id;
end;
$$;

comment on function public.line_secret_upsert(text, text) is
  '[WO-4.A] helper ภายใน — เขียนค่าลง Vault (หมุนทับของเดิมถ้ามีชื่อนั้นแล้ว)';

revoke execute on function public.line_secret_upsert(text, text) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- set_gang_line_credentials(...) — ตั้ง/หมุน credentials ของก๊วน
-- -----------------------------------------------------------------------------
-- ส่ง `null` = **คงค่าเดิมไว้** (หมุนเฉพาะ token โดยไม่ต้องกรอก secret ใหม่)
-- ส่งสตริงว่าง = ตั้งใจล้างค่านั้นทิ้ง
create or replace function public.set_gang_line_credentials(
  p_gang_id        uuid,
  p_access_token   text default null,
  p_channel_secret text default null,
  p_liff_id        text default null,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.gang_line_configs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row         public.gang_line_configs;
  v_token_ref   uuid;
  v_secret_ref  uuid;
  v_token       text := nullif(btrim(coalesce(p_access_token, '')), '');
  v_secret      text := nullif(btrim(coalesce(p_channel_secret, '')), '');
  v_liff        text := btrim(coalesce(p_liff_id, ''));
begin
  if not exists (select 1 from public.gangs where id = p_gang_id and deleted_at is null) then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang', 'id', p_gang_id)::text;
  end if;

  select * into v_row from public.gang_line_configs where gang_id = p_gang_id;

  v_token_ref  := v_row.channel_access_token_ref::uuid;
  v_secret_ref := v_row.channel_secret_ref::uuid;

  -- ⚠️ ตรวจความยาวแบบหลวมๆ พอกันพิมพ์ผิด — ❌ ห้าม raise ข้อความที่มีค่า secret อยู่ในนั้น
  if p_access_token is not null and v_token is not null and length(v_token) < 20 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'access_token', 'reason', 'สั้นเกินกว่าจะเป็น token จริง')::text;
  end if;

  if p_channel_secret is not null and v_secret is not null and length(v_secret) < 16 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'channel_secret', 'reason', 'สั้นเกินกว่าจะเป็น secret จริง')::text;
  end if;

  if v_token is not null then
    v_token_ref := public.line_secret_upsert('line_access_token:' || p_gang_id, v_token);
  elsif p_access_token is not null then
    -- ส่งสตริงว่างมา = ล้างทิ้ง
    delete from vault.secrets where name = 'line_access_token:' || p_gang_id;
    v_token_ref := null;
  end if;

  if v_secret is not null then
    v_secret_ref := public.line_secret_upsert('line_channel_secret:' || p_gang_id, v_secret);
  elsif p_channel_secret is not null then
    delete from vault.secrets where name = 'line_channel_secret:' || p_gang_id;
    v_secret_ref := null;
  end if;

  insert into public.gang_line_configs
    (gang_id, channel_access_token_ref, channel_secret_ref, liff_id, created_by, updated_by)
  values
    (p_gang_id, v_token_ref::text, v_secret_ref::text,
     case when p_liff_id is null then null else nullif(v_liff, '') end,
     p_actor_id, p_actor_id)
  on conflict (gang_id) do update
    set channel_access_token_ref = v_token_ref::text,
        channel_secret_ref       = v_secret_ref::text,
        liff_id                  = case
                                     when p_liff_id is null then public.gang_line_configs.liff_id
                                     else nullif(v_liff, '')
                                   end,
        updated_by               = p_actor_id
  returning * into v_row;

  -- ครบไม่ครบมีผลต่อการส่งจริง ⇒ ถ้า credential หายไป ต้องปิดสวิตช์ให้เองทันที
  if v_row.is_enabled and (v_token_ref is null or v_secret_ref is null) then
    update public.gang_line_configs set is_enabled = false where gang_id = p_gang_id
    returning * into v_row;

    update public.gangs
       set features = features || '{"line": false}'::jsonb
     where id = p_gang_id;
  end if;

  -- 🔴 event นี้ห้ามมีค่า credential อยู่ใน payload — บันทึกแค่ว่า "อะไรถูกแตะ"
  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.line_config_updated', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object(
       'correlation_id',  p_correlation_id,
       'token_changed',   p_access_token is not null,
       'secret_changed',  p_channel_secret is not null,
       'liff_changed',    p_liff_id is not null
     ));

  return v_row;
end;
$$;

comment on function public.set_gang_line_credentials(uuid, text, text, text, uuid, text) is
  '[WO-4.A] เก็บ LINE credentials ลง Vault — ตารางเก็บแค่ secret id · null = คงค่าเดิม';

revoke execute on function public.set_gang_line_credentials(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_gang_line_credentials(uuid, text, text, text, uuid, text)
  to service_role;


-- -----------------------------------------------------------------------------
-- get_gang_line_credentials(gang_id) — 🔴 ทางเดียวที่ plaintext ออกจาก Vault
-- -----------------------------------------------------------------------------
-- ใช้ได้เฉพาะฝั่ง server: verify signature ของ webhook (WO-4.B) · ยิง Messaging API (WO-4.C)
-- ❌ ห้ามส่งผลลัพธ์ของฟังก์ชันนี้กลับไปที่ browser ไม่ว่ากรณีใด
create or replace function public.get_gang_line_credentials(p_gang_id uuid)
returns table (
  access_token   text,
  channel_secret text,
  liff_id        text,
  is_enabled     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select s.decrypted_secret from vault.decrypted_secrets s
      where s.id = c.channel_access_token_ref::uuid),
    (select s.decrypted_secret from vault.decrypted_secrets s
      where s.id = c.channel_secret_ref::uuid),
    c.liff_id,
    c.is_enabled
  from public.gang_line_configs c
  where c.gang_id = p_gang_id;
$$;

comment on function public.get_gang_line_credentials(uuid) is
  '[WO-4.A] 🔴 คืน plaintext — service_role เท่านั้น ❌ ห้ามส่งต่อไปที่ browser';

revoke execute on function public.get_gang_line_credentials(uuid) from public, anon, authenticated;
grant execute on function public.get_gang_line_credentials(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- gang_line_status(gang_id) — สิ่งที่หน้าจอได้เห็น (ปิดบังแล้ว)
-- -----------------------------------------------------------------------------
-- คืนแค่ "ตั้งค่าแล้วหรือยัง" + **4 ตัวท้าย** ⇒ แอดมินตรวจได้ว่าใส่ใบไหนไว้
-- โดยไม่มีทางประกอบค่าเต็มกลับมาได้
create or replace function public.gang_line_status(p_gang_id uuid)
returns table (
  has_access_token  boolean,
  token_last4       text,
  has_channel_secret boolean,
  secret_last4      text,
  liff_id           text,
  is_enabled        boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.channel_access_token_ref is not null,
    right((select s.decrypted_secret from vault.decrypted_secrets s
            where s.id = c.channel_access_token_ref::uuid), 4),
    c.channel_secret_ref is not null,
    right((select s.decrypted_secret from vault.decrypted_secrets s
            where s.id = c.channel_secret_ref::uuid), 4),
    c.liff_id,
    c.is_enabled
  from public.gang_line_configs c
  where c.gang_id = p_gang_id;
$$;

comment on function public.gang_line_status(uuid) is
  '[WO-4.A] สถานะสำหรับหน้าจอ — มี/ไม่มี + 4 ตัวท้ายเท่านั้น';

revoke execute on function public.gang_line_status(uuid) from public, anon, authenticated;
grant execute on function public.gang_line_status(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- set_gang_line_enabled(...) — เปิด/ปิดใช้งาน LINE ของก๊วน
-- -----------------------------------------------------------------------------
-- 🔴 เปิดไม่ได้ถ้า credentials ยังไม่ครบ — ต้องดังตั้งแต่ตอนกด ไม่ใช่ไปเงียบตอนส่งไม่ออก
--    (CLAUDE.md §3 "feature flag ต้อง enforce ฝั่ง server")
create or replace function public.set_gang_line_enabled(
  p_gang_id        uuid,
  p_enabled        boolean,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.gang_line_configs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.gang_line_configs;
begin
  select * into v_row from public.gang_line_configs where gang_id = p_gang_id;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang_line_config', 'gang_id', p_gang_id)::text;
  end if;

  if p_enabled and (v_row.channel_access_token_ref is null or v_row.channel_secret_ref is null) then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ต้องตั้ง channel access token และ channel secret ให้ครบก่อน')::text;
  end if;

  update public.gang_line_configs
     set is_enabled = p_enabled, updated_by = p_actor_id
   where gang_id = p_gang_id
  returning * into v_row;

  -- flag ที่ `can()` อ่าน ต้องตรงกับสวิตช์นี้เสมอ ⇒ เขียนพร้อมกันในธุรกรรมเดียว
  update public.gangs
     set features = features || jsonb_build_object('line', p_enabled)
   where id = p_gang_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.line_toggled', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object('correlation_id', p_correlation_id, 'enabled', p_enabled));

  return v_row;
end;
$$;

comment on function public.set_gang_line_enabled(uuid, boolean, uuid, text) is
  '[WO-4.A] เปิด/ปิด LINE ของก๊วน — ตั้ง gangs.features.line พร้อมกันในธุรกรรมเดียว';

revoke execute on function public.set_gang_line_enabled(uuid, boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_gang_line_enabled(uuid, boolean, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- clear_gang_line_credentials(...) — ถอด LINE ออกจากก๊วน
-- -----------------------------------------------------------------------------
-- ลบ secret ออกจาก Vault ด้วย ไม่ใช่แค่ลืม id ทิ้งไว้ (ของที่ไม่มีใครอ้างถึงแล้ว
-- แต่ยังถอดรหัสได้ = ขยะที่เป็นความลับ)
create or replace function public.clear_gang_line_credentials(
  p_gang_id        uuid,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets
   where name in ('line_access_token:' || p_gang_id, 'line_channel_secret:' || p_gang_id);

  update public.gang_line_configs
     set channel_access_token_ref = null,
         channel_secret_ref       = null,
         is_enabled               = false,
         updated_by               = p_actor_id
   where gang_id = p_gang_id;

  update public.gangs
     set features = features || '{"line": false}'::jsonb
   where id = p_gang_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.line_config_cleared', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object('correlation_id', p_correlation_id));
end;
$$;

comment on function public.clear_gang_line_credentials(uuid, uuid, text) is
  '[WO-4.A] ถอด LINE ออกจากก๊วน — ลบ secret ใน Vault ด้วย ไม่ทิ้งขยะที่ถอดรหัสได้';

revoke execute on function public.clear_gang_line_credentials(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.clear_gang_line_credentials(uuid, uuid, text) to service_role;
