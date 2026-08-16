-- =============================================================================
-- WO-4.C · 0037 — fan-out ช่องทาง `line` ในคิวเดิม + โควต้าต่อก๊วนต่อเดือน
-- =============================================================================
-- baseline §การตัดสินใจสำคัญ: "แจ้งเตือนโดยไม่มี LINE = in-app เป็นช่องทางพื้นฐานทุกก๊วน
-- — LINE เป็น channel เสริม **ผ่าน queue เดียวกัน**" · "โควต้า LINE OA: `notification_logs`
-- นับข้อความต่อก๊วนต่อเดือน + usage counter ในหน้าตั้งค่า"
--
-- 🔴 กติกาที่ห้ามพลาดในใบนี้ (ข้อจำกัด Phase 4 ข้อ 2)
--    `notifications.dedupe_key` เป็น **unique ทั้งตาราง** ⇒ แถว `line` ของงานเดียวกัน
--    ต้องมีคีย์คนละใบ · และ **ห้ามเปลี่ยนรูปคีย์ของ `in_app` ที่ส่งไปแล้ว** เด็ดขาด
--    ⇒ วิธีที่เลือก: `in_app` ใช้คีย์เดิมเป๊ะ · `line` = `<คีย์เดิม>:line`
--      (ของเก่าที่เคยกันซ้ำจึงยังกันได้เหมือนเดิมทุกแถว ไม่มีใครโดนยิงซ้ำจาก migration นี้)
--
-- 🔴 ใครได้แถว `line` บ้าง: ก๊วนเปิด `gang_line_configs.is_enabled`
--    **และ** ผู้รับผูกบัญชีไว้ (`member_line_links`) **และ** ไม่ได้บล็อก OA (`blocked_at is null`)
--    **และ** ก๊วนยังไม่เกินโควต้าของเดือนนั้น
--    ⇒ คนที่ไม่เข้าเงื่อนไข **ยังได้ in-app เหมือนเดิมทุกกรณี** (ข้อจำกัด 6)
--
-- Rollback:
--   DROP FUNCTION public.line_delivery_context(uuid, uuid);
--   DROP FUNCTION public.set_gang_line_quota(uuid, integer, uuid);
--   DROP FUNCTION public.line_quota_status(uuid);
--   ALTER TABLE public.gang_line_configs DROP COLUMN monthly_quota;
--   -- แล้ว restore `enqueue_notifications` เวอร์ชันของ 0029 (in_app อย่างเดียว)
-- =============================================================================

alter table public.gang_line_configs
  add column if not exists monthly_quota integer default 200;

comment on column public.gang_line_configs.monthly_quota is
  '[WO-4.C] เพดานข้อความ LINE ต่อเดือนของก๊วนนี้ · null = ไม่จำกัด · default 200 ตาม free tier ของ LINE OA';


-- -----------------------------------------------------------------------------
-- line_quota_status(gang_id) — ใช้แล้วกี่ข้อความในเดือนนี้
-- -----------------------------------------------------------------------------
-- 🔴 นับจาก `notification_logs` **ที่เดียว** (ข้อจำกัด 7) — ❌ ไม่มีตารางสรุปแยก
--    นับเฉพาะ `success = true` ⇒ ส่งไม่สำเร็จไม่กินโควต้า (ตรงกับที่ LINE คิดจริง)
--
-- ⚠️ "เดือน" ใช้นาฬิกาไทย เหมือน `daily_metrics` ของ WO-3.A
create or replace function public.line_quota_status(p_gang_id uuid)
returns table (
  period_start  date,
  used          integer,
  monthly_quota integer,
  is_over       boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with period as (
    select date_trunc('month', (now() at time zone 'Asia/Bangkok'))::date as start_date
  ),
  usage as (
    select count(*)::integer as used
      from public.notification_logs l, period p
     where l.gang_id = p_gang_id
       and l.channel = 'line'
       and l.success
       and (l.sent_at at time zone 'Asia/Bangkok')::date >= p.start_date
  )
  select
    p.start_date,
    u.used,
    c.monthly_quota,
    c.monthly_quota is not null and u.used >= c.monthly_quota
  from period p
  cross join usage u
  left join public.gang_line_configs c on c.gang_id = p_gang_id;
$$;

comment on function public.line_quota_status(uuid) is
  '[WO-4.C] โควต้า LINE ของเดือนนี้ — นับจาก notification_logs (success เท่านั้น)';

revoke execute on function public.line_quota_status(uuid) from public, anon, authenticated;
grant execute on function public.line_quota_status(uuid) to service_role;


create or replace function public.set_gang_line_quota(
  p_gang_id  uuid,
  p_quota    integer,
  p_actor_id uuid default null
)
returns public.gang_line_configs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.gang_line_configs;
begin
  if p_quota is not null and p_quota < 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'monthly_quota', 'reason', 'ติดลบไม่ได้')::text;
  end if;

  update public.gang_line_configs
     set monthly_quota = p_quota, updated_by = p_actor_id
   where gang_id = p_gang_id
  returning * into v_row;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang_line_config', 'gang_id', p_gang_id)::text;
  end if;

  return v_row;
end;
$$;

comment on function public.set_gang_line_quota(uuid, integer, uuid) is
  '[WO-4.C] ตั้งเพดานข้อความ LINE ต่อเดือน — null = ไม่จำกัด';

revoke execute on function public.set_gang_line_quota(uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.set_gang_line_quota(uuid, integer, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- line_delivery_context(gang_id, user_id) — ทุกอย่างที่ worker ต้องใช้ในครั้งเดียว
-- -----------------------------------------------------------------------------
-- 🔴 คืน access token (plaintext จาก Vault) ⇒ `service_role` เท่านั้น
--    ❌ ห้ามส่งผลลัพธ์ของฟังก์ชันนี้กลับไปที่ browser
create or replace function public.line_delivery_context(p_gang_id uuid, p_user_id uuid)
returns table (
  line_user_id text,
  access_token text,
  is_enabled   boolean,
  is_blocked   boolean,
  is_over_quota boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    l.line_user_id,
    (select s.decrypted_secret from vault.decrypted_secrets s
      where s.id = c.channel_access_token_ref::uuid),
    coalesce(c.is_enabled, false),
    l.blocked_at is not null,
    coalesce((select q.is_over from public.line_quota_status(p_gang_id) q), false)
  from public.member_line_links l
  left join public.gang_line_configs c on c.gang_id = l.gang_id
  where l.gang_id = p_gang_id and l.user_id = p_user_id;
$$;

comment on function public.line_delivery_context(uuid, uuid) is
  '[WO-4.C] 🔴 คืน access token — service_role เท่านั้น · ใช้โดย worker ตอนส่ง LINE';

revoke execute on function public.line_delivery_context(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.line_delivery_context(uuid, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- enqueue_notifications(rows) — เวอร์ชันที่ fan-out ไป `line` ด้วย
-- -----------------------------------------------------------------------------
-- ⚠️ แทนที่เวอร์ชันของ `0029` แบบ **เพิ่มความสามารถ** — พฤติกรรมของ `in_app` เหมือนเดิมทุกอย่าง
--    (คีย์เดิม · ข้ามอันที่เคยส่งแล้ว · คืนจำนวนแถวที่ **สร้างใหม่จริง**)
--
-- คืนค่า = จำนวนแถวใหม่ **รวมทุก channel** ⇒ ก๊วนที่เปิด LINE ตัวเลขนี้จะมากกว่าจำนวนผู้รับ
--   (ผู้เรียกที่เอาไปบันทึกเป็น "notified" ตีความว่า "กี่ข้อความที่เข้าคิว" ไม่ใช่ "กี่คน")
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
        as r(gang_id uuid, recipient_id uuid, event_type text, payload jsonb, dedupe_key text)
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
    select i.gang_id, i.recipient_id, i.event_type, i.payload,
           'line'::text,
           case when i.dedupe_key is null then null else i.dedupe_key || ':line' end
      from input i
      join public.gang_line_configs c
        on c.gang_id = i.gang_id and c.is_enabled
      join public.member_line_links l
        on l.gang_id = i.gang_id and l.user_id = i.recipient_id and l.blocked_at is null
      where not coalesce((select q.is_over from public.line_quota_status(i.gang_id) q), false)
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
  '[WO-4.C] เข้าคิว in_app เสมอ + fan-out `line` ให้คนที่ผูกบัญชีไว้ (คีย์ line = "<คีย์เดิม>:line")';

revoke execute on function public.enqueue_notifications(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_notifications(jsonb) to service_role;
