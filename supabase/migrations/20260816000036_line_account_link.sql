-- =============================================================================
-- WO-4.B · 0036 — ผูกบัญชี LINE เข้ากับสมาชิก + สถานะบล็อก OA
-- =============================================================================
-- baseline §ตาราง: `member_line_links` — (gang_id + line_user_id + user_id)
-- ตารางมีอยู่แล้วตั้งแต่ `0006` ⇒ ใบนี้เพิ่มแค่ **คอลัมน์เดียว** (additive) + ฟังก์ชัน
-- ❌ ไม่เพิ่มตารางใหม่ (กติกา Phase 4: ตารางของ LINE มีครบแล้ว)
--
-- 🔴 ทำไมต้องมี `blocked_at`
--    ผู้ใช้บล็อก/ลบเพื่อน OA เมื่อไหร่ LINE ส่ง event `unfollow` มา และ **ห้ามส่งหาเขาอีก**
--    ถ้าลบแถวทิ้งแทน: ผู้ใช้ที่กด follow กลับมาจะต้องผูกบัญชีใหม่ทั้งที่เขาไม่ได้ตั้งใจเลิกผูก
--    ⇒ เก็บความสัมพันธ์ไว้ แล้วทำเครื่องหมายว่า "ส่งไม่ได้ตอนนี้" แทน (follow อีกครั้ง = ปลดเอง)
--
-- ⚠️ WO-4.C จะกรอง `blocked_at is null` ตอน fan-out — ไม่ใช่ปล่อยให้ส่งแล้ว fail 3 ครั้ง
--
-- Rollback:
--   DROP FUNCTION public.set_line_link_blocked(uuid, text, boolean, text);
--   DROP FUNCTION public.unlink_line_account(uuid, uuid, text);
--   DROP FUNCTION public.link_line_account(uuid, uuid, text, text);
--   ALTER TABLE public.member_line_links DROP COLUMN blocked_at;
-- =============================================================================

alter table public.member_line_links
  add column if not exists blocked_at timestamptz;

comment on column public.member_line_links.blocked_at is
  '[WO-4.B] ผู้ใช้บล็อก/ลบเพื่อน OA (event unfollow) — WO-4.C ต้องข้ามคนที่ค่านี้ไม่ null';

-- worker หยิบ "ผู้รับที่ส่ง LINE ได้จริง" ของก๊วนหนึ่ง ⇒ partial index ตาม query นั้น
create index if not exists member_line_links_active_idx
  on public.member_line_links (gang_id, user_id)
  where blocked_at is null;


-- -----------------------------------------------------------------------------
-- link_line_account(...) — ผูก LINE user เข้ากับสมาชิก
-- -----------------------------------------------------------------------------
-- 🔴 จุดเดียวที่เขียน `member_line_links` (ตารางนี้ `authenticated` มีแค่ `select`)
--
-- กติกา:
--   · ต้องเป็นสมาชิกของก๊วนนั้นจริง
--   · ก๊วนต้องเปิด LINE อยู่ (`gang_line_configs.is_enabled`) — flag ปิด = ไม่มีอะไรให้ผูก
--   · ผูกซ้ำด้วย LINE เดิม = ปลดบล็อก + คืนแถวเดิม (idempotent)
--   · LINE คนนี้ผูกกับสมาชิกคนอื่นในก๊วนเดียวกันอยู่แล้ว = `ALREADY_REGISTERED`
--   · สมาชิกคนเดิมผูก LINE ใบใหม่ = ย้ายไปใบใหม่ (คนเปลี่ยนบัญชี LINE เป็นเรื่องปกติ)
create or replace function public.link_line_account(
  p_gang_id        uuid,
  p_user_id        uuid,
  p_line_user_id   text,
  p_correlation_id text default null
)
returns public.member_line_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.member_line_links;
  v_line text := nullif(btrim(coalesce(p_line_user_id, '')), '');
begin
  if v_line is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'line_user_id')::text;
  end if;

  if not exists (
    select 1 from public.gang_members
     where gang_id = p_gang_id and user_id = p_user_id and deleted_at is null
  ) then
    raise exception using
      errcode = 'P0001', message = 'NOT_GANG_MEMBER',
      detail  = json_build_object('gang_id', p_gang_id)::text;
  end if;

  if not exists (
    select 1 from public.gang_line_configs where gang_id = p_gang_id and is_enabled
  ) then
    raise exception using
      errcode = 'P0001', message = 'FEATURE_DISABLED',
      detail  = json_build_object('feature', 'line')::text;
  end if;

  -- LINE ใบนี้เป็นของคนอื่นในก๊วนนี้อยู่แล้ว
  if exists (
    select 1 from public.member_line_links
     where gang_id = p_gang_id and line_user_id = v_line and user_id <> p_user_id
  ) then
    raise exception using
      errcode = 'P0001', message = 'ALREADY_REGISTERED',
      detail  = json_build_object('reason', 'บัญชี LINE นี้ถูกผูกกับสมาชิกคนอื่นในก๊วนนี้แล้ว')::text;
  end if;

  insert into public.member_line_links (gang_id, user_id, line_user_id)
  values (p_gang_id, p_user_id, v_line)
  on conflict (gang_id, user_id) do update
    set line_user_id = excluded.line_user_id,
        linked_at    = now(),
        blocked_at   = null
  returning * into v_row;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'line.account_linked', 'member', v_row.id, p_user_id,
     jsonb_build_object('correlation_id', p_correlation_id));
     -- 🔴 ไม่บันทึก line_user_id ลง event_logs — สมาชิกก๊วนอ่าน timeline ได้

  return v_row;
end;
$$;

comment on function public.link_line_account(uuid, uuid, text, text) is
  '[WO-4.B] ผูก LINE user เข้ากับสมาชิก — จุดเดียวที่เขียน member_line_links';

revoke execute on function public.link_line_account(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.link_line_account(uuid, uuid, text, text) to service_role;


-- -----------------------------------------------------------------------------
-- unlink_line_account(...) — สมาชิกเลิกผูกบัญชีของตัวเอง
-- -----------------------------------------------------------------------------
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

  if v_deleted > 0 then
    insert into public.event_logs
      (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
    values
      (p_gang_id, 'line.account_unlinked', 'gang', p_gang_id, p_user_id,
       jsonb_build_object('correlation_id', p_correlation_id));
  end if;

  return v_deleted > 0;
end;
$$;

comment on function public.unlink_line_account(uuid, uuid, text) is
  '[WO-4.B] เลิกผูกบัญชี LINE ของตัวเอง — ลบแถวจริง (ต่างจาก blocked_at ที่เป็นสถานะชั่วคราว)';

revoke execute on function public.unlink_line_account(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.unlink_line_account(uuid, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- set_line_link_blocked(...) — จาก event follow / unfollow ของ webhook
-- -----------------------------------------------------------------------------
-- คืน `false` ถ้าไม่มีแถวนั้น (คนที่ยังไม่เคยผูกบัญชี follow/unfollow ได้ตามปกติ
-- และไม่ใช่ error — webhook ต้องตอบ 200 ให้ LINE อยู่ดี)
create or replace function public.set_line_link_blocked(
  p_gang_id        uuid,
  p_line_user_id   text,
  p_blocked        boolean,
  p_correlation_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.member_line_links;
begin
  update public.member_line_links
     set blocked_at = case when p_blocked then now() else null end
   where gang_id = p_gang_id and line_user_id = p_line_user_id
  returning * into v_row;

  if not found then
    return false;
  end if;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id,
     case when p_blocked then 'line.blocked' else 'line.unblocked' end,
     'member', v_row.id, v_row.user_id,
     jsonb_build_object('correlation_id', p_correlation_id));

  return true;
end;
$$;

comment on function public.set_line_link_blocked(uuid, text, boolean, text) is
  '[WO-4.B] อัปเดตสถานะบล็อกจาก event follow/unfollow — ไม่มีแถวก็ไม่ใช่ error';

revoke execute on function public.set_line_link_blocked(uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_line_link_blocked(uuid, text, boolean, text) to service_role;
