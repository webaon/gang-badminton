-- =============================================================================
-- WO-4.D · 0038 — LINE Login: credentials ของ Login channel + ยกเลิกผูกให้สะอาด
-- =============================================================================
-- ⚠️ **LINE Login channel เป็นคนละ channel กับ Messaging API** (คนละ id/secret)
--    แต่ถ้าอยู่ **provider เดียวกัน** `userId` ที่ได้จะเป็นตัวเดียวกัน ⇒ ผูกข้ามกันได้
--    (ถ้าคนละ provider จะได้ id คนละใบและผูกแล้วส่งข้อความไม่ถึง — เขียนเตือนไว้ในหน้าตั้งค่า)
--
-- ❌ ไม่เพิ่มตารางใหม่ — เพิ่ม **สองคอลัมน์** ใน `gang_line_configs` (additive)
--    และ secret ยังลง Vault เหมือนเดิมทุกประการ (WO-4.A)
--
-- 🔴 `unlink_line_account()` เวอร์ชันใหม่: ยกเลิกผูกแล้วต้อง **หยุดส่งทันที**
--    ⇒ แถว `line` ที่ยังค้างอยู่ในคิวถูกปิดทิ้งพร้อมเหตุผล ไม่ใช่ปล่อยให้ worker
--      ไปลองส่งแล้ว fail สามรอบ (ซึ่ง "ไม่ถูกส่ง" เหมือนกันแต่รกและอ่าน log ยาก)
--
-- Rollback:
--   DROP FUNCTION public.gang_line_login_status(uuid);
--   DROP FUNCTION public.get_gang_line_login(uuid);
--   DROP FUNCTION public.set_gang_line_login(uuid, text, text, uuid);
--   ALTER TABLE public.gang_line_configs
--     DROP COLUMN login_channel_id, DROP COLUMN login_channel_secret_ref;
--   -- แล้ว restore `unlink_line_account` เวอร์ชันของ 0036
-- =============================================================================

alter table public.gang_line_configs
  add column if not exists login_channel_id        text,
  add column if not exists login_channel_secret_ref text;

comment on column public.gang_line_configs.login_channel_id is
  '[WO-4.D] Channel ID ของ **LINE Login channel** (คนละใบกับ Messaging API — ต้องอยู่ provider เดียวกัน)';
comment on column public.gang_line_configs.login_channel_secret_ref is
  '⚠️ Vault secret id เท่านั้น — ห้ามเก็บ plaintext';


-- -----------------------------------------------------------------------------
-- set_gang_line_login(...) — ตั้ง/หมุน credentials ของ Login channel
-- -----------------------------------------------------------------------------
-- null = คงค่าเดิม · สตริงว่าง = ล้างทิ้ง (กติกาเดียวกับ `set_gang_line_credentials`)
create or replace function public.set_gang_line_login(
  p_gang_id       uuid,
  p_channel_id    text default null,
  p_channel_secret text default null,
  p_actor_id      uuid default null
)
returns public.gang_line_configs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row        public.gang_line_configs;
  v_secret_ref uuid;
  v_secret     text := nullif(btrim(coalesce(p_channel_secret, '')), '');
  v_channel    text := btrim(coalesce(p_channel_id, ''));
begin
  select * into v_row from public.gang_line_configs where gang_id = p_gang_id;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang_line_config', 'gang_id', p_gang_id)::text;
  end if;

  v_secret_ref := v_row.login_channel_secret_ref::uuid;

  if v_secret is not null then
    v_secret_ref := public.line_secret_upsert('line_login_secret:' || p_gang_id, v_secret);
  elsif p_channel_secret is not null then
    delete from vault.secrets where name = 'line_login_secret:' || p_gang_id;
    v_secret_ref := null;
  end if;

  update public.gang_line_configs
     set login_channel_id = case
                              when p_channel_id is null then login_channel_id
                              else nullif(v_channel, '')
                            end,
         login_channel_secret_ref = v_secret_ref::text,
         updated_by = p_actor_id
   where gang_id = p_gang_id
  returning * into v_row;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.line_login_updated', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object(
       'channel_changed', p_channel_id is not null,
       'secret_changed',  p_channel_secret is not null
     ));

  return v_row;
end;
$$;

comment on function public.set_gang_line_login(uuid, text, text, uuid) is
  '[WO-4.D] credentials ของ LINE Login channel — secret ลง Vault เหมือน Messaging API';

revoke execute on function public.set_gang_line_login(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.set_gang_line_login(uuid, text, text, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- get_gang_line_login(gang_id) — 🔴 คืน plaintext (service_role เท่านั้น)
-- -----------------------------------------------------------------------------
create or replace function public.get_gang_line_login(p_gang_id uuid)
returns table (
  login_channel_id     text,
  login_channel_secret text,
  is_enabled           boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.login_channel_id,
    (select s.decrypted_secret from vault.decrypted_secrets s
      where s.id = c.login_channel_secret_ref::uuid),
    c.is_enabled
  from public.gang_line_configs c
  where c.gang_id = p_gang_id;
$$;

comment on function public.get_gang_line_login(uuid) is
  '[WO-4.D] 🔴 คืน plaintext ของ Login channel — service_role เท่านั้น';

revoke execute on function public.get_gang_line_login(uuid) from public, anon, authenticated;
grant execute on function public.get_gang_line_login(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- gang_line_login_status(gang_id) — สิ่งที่หน้าจอเห็น (ปิดบังแล้ว)
-- -----------------------------------------------------------------------------
create or replace function public.gang_line_login_status(p_gang_id uuid)
returns table (
  has_login_channel boolean,
  login_channel_id  text,
  secret_last4      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.login_channel_id is not null and c.login_channel_secret_ref is not null,
    -- Channel ID ไม่ใช่ความลับ (อยู่ใน URL ที่ผู้ใช้เห็นอยู่แล้ว) จึงแสดงได้เต็ม
    c.login_channel_id,
    right((select s.decrypted_secret from vault.decrypted_secrets s
            where s.id = c.login_channel_secret_ref::uuid), 4)
  from public.gang_line_configs c
  where c.gang_id = p_gang_id;
$$;

comment on function public.gang_line_login_status(uuid) is
  '[WO-4.D] สถานะ Login channel สำหรับหน้าจอ — secret แสดงแค่ 4 ตัวท้าย';

revoke execute on function public.gang_line_login_status(uuid) from public, anon, authenticated;
grant execute on function public.gang_line_login_status(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- unlink_line_account(...) — เวอร์ชันที่ปิดงานค้างในคิวให้ด้วย
-- -----------------------------------------------------------------------------
-- 🔴 DoD ของ WO-4.D: "ยกเลิกผูกแล้วต้องหยุดได้รับ LINE **ทันที**"
--    ⇒ แถว `line` ที่ยัง `pending`/`processing` ของคนนั้นในก๊วนนั้นถูกปิดเป็น `failed`
--      พร้อมเหตุผล — ไม่ปล่อยให้ worker ไปลองส่งแล้วค่อยล้มเอง
create or replace function public.unlink_line_account(
  p_gang_id        uuid,
  p_user_id        uuid,
  p_correlation_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.member_line_links
   where gang_id = p_gang_id and user_id = p_user_id;

  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return false;
  end if;

  update public.notifications
     set status     = 'failed',
         last_error = 'เลิกผูกบัญชี LINE แล้ว',
         claimed_at = null
   where gang_id      = p_gang_id
     and recipient_id = p_user_id
     and channel      = 'line'
     and status in ('pending', 'processing');

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'line.account_unlinked', 'gang', p_gang_id, p_user_id,
     jsonb_build_object('correlation_id', p_correlation_id));

  return true;
end;
$$;

comment on function public.unlink_line_account(uuid, uuid, text) is
  '[WO-4.D] เลิกผูกบัญชี + ปิดงาน LINE ที่ค้างในคิวของคนนั้นทันที';

revoke execute on function public.unlink_line_account(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.unlink_line_account(uuid, uuid, text) to service_role;
