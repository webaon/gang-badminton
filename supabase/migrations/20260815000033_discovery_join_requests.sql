-- =============================================================================
-- WO-3.E · 0033 — Discovery (pg_trgm) + คำขอเข้าก๊วน
-- =============================================================================
-- 🔴 ช่องโหว่ที่เจอตอนตรวจ policy ของ `join_requests` (ต่อจากที่ 3.C/3.D เจอใน 0010)
--
--    policy เดิมเปิดกว้างเกินไปสองใบ:
--      · `join_requests_insert_self` — with check แค่ `user_id = auth.uid()`
--        ⇒ ใครก็ยิงคำขอเข้า **ก๊วนส่วนตัว** ได้ (แค่รู้ id) และตั้ง `status` เองได้ด้วย
--           เท่ากับใช้ตารางนี้เป็นช่องทางยืนยันว่า gang id ไหนมีจริง + สแปมแอดมิน
--      · `join_requests_update_admin` — แอดมิน UPDATE ตรงได้ทุกคอลัมน์
--        ⇒ ตั้ง `status = 'approved'` เองได้โดย **ไม่มี `gang_members` เกิดขึ้นจริง**
--           คำขอขึ้นว่า "อนุมัติแล้ว" แต่คนขอไม่ได้เข้าก๊วน = สถานะโกหก
--
--    ⇒ ใบนี้ยึดกติกาเดียวกับ [D-13]: **ตารางนี้เขียนผ่าน DB function เท่านั้น**
--      authenticated เหลือ `select` อย่างเดียว (policy เดิมของ SELECT แคบอยู่แล้ว —
--      เห็นเฉพาะแถวของตัวเอง หรือเป็นแอดมินของก๊วนนั้น — ตรวจแล้วไม่ต้องแก้)
--
-- 🔴 discovery ต้องเคารพ `features.discovery` (ข้อจำกัด Phase 3 ข้อ 4)
--    `gangs_select_public` (0010) ยังปล่อยให้อ่าน metadata ของก๊วน `is_public` ได้เหมือนเดิม
--    **โดยตั้งใจ** — นั่นคือ "ก๊วนเปิดเผยตัวตน" ซึ่งลิงก์ตรงต้องยังเข้าได้
--    ส่วน "โผล่ในผลค้นหา" เป็นคนละเรื่อง ⇒ บังคับที่ `search_public_gangs()` ที่เดียว
--    (หน้าจอเรียกฟังก์ชันนี้เท่านั้น — ยิง action ตรงก็ผ่านด่านเดียวกัน)
--
-- Rollback:
--   DROP FUNCTION public.decide_join_request(uuid, uuid, text, uuid, text);
--   DROP FUNCTION public.cancel_join_request(uuid, uuid, text);
--   DROP FUNCTION public.request_to_join_gang(uuid, uuid, text, text);
--   DROP FUNCTION public.search_public_gangs(text, integer, uuid);
--   GRANT INSERT, UPDATE ON public.join_requests TO authenticated;
--   CREATE POLICY join_requests_insert_self ON public.join_requests
--     FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
--   CREATE POLICY join_requests_update_admin ON public.join_requests
--     FOR UPDATE TO authenticated
--     USING ((SELECT public.is_gang_admin(gang_id)))
--     WITH CHECK ((SELECT public.is_gang_admin(gang_id)));
-- =============================================================================


-- -----------------------------------------------------------------------------
-- ส่วนที่ 1 — ปิดทางเขียนตรง (เหลือ select อย่างเดียว)
-- -----------------------------------------------------------------------------
drop policy if exists join_requests_insert_self  on public.join_requests;
drop policy if exists join_requests_update_admin on public.join_requests;

revoke insert, update on public.join_requests from authenticated;

comment on table public.join_requests is
  '[WO-3.E] ขอเข้าก๊วนจาก discovery — เขียนผ่าน DB function เท่านั้น [D-13]';


-- -----------------------------------------------------------------------------
-- ส่วนที่ 2 — ค้นหาก๊วนสาธารณะด้วย pg_trgm
-- -----------------------------------------------------------------------------
-- ใช้ทั้งตัวดำเนินการ `%` (similarity ตาม threshold) **และ** `ilike '%…%'`
-- ทั้งคู่วิ่งบน gin_trgm_ops index ที่มีอยู่แล้วใน 0002 (`gangs_name_trgm_idx`,
-- `gangs_area_trgm_idx`) — ไม่ใช่ `LIKE` เปล่าที่ต้อง seq scan
--
-- ทำไมต้องมีทั้งสองอย่าง: คำค้นไทยสั้นๆ ที่เป็น "ส่วนหนึ่ง" ของชื่อยาว
-- (เช่น 'บางแค' ใน 'ก๊วนแบดบางแคยามเย็น') ได้ similarity ต่ำกว่า threshold
-- ⇒ `%` อย่างเดียวจะหาไม่เจอ ทั้งที่เป็นเคสหลักของผู้ใช้จริง
--
-- ⚠️ `%` และ `_` ที่ผู้ใช้พิมพ์ต้อง escape ก่อนต่อเป็น pattern
--    ไม่งั้นค้นด้วย `%` ตัวเดียว = ได้ก๊วนทั้งแพลตฟอร์ม
create or replace function public.search_public_gangs(
  p_query     text    default null,
  p_limit     integer default 20,
  p_viewer_id uuid    default null
)
returns table (
  id            uuid,
  name          text,
  description   text,
  area          text,
  member_count  integer,
  -- 'member' = อยู่ก๊วนนี้แล้ว · 'pending' = ขอไปแล้วรออยู่ · null = ขอได้
  viewer_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select
      nullif(btrim(coalesce(p_query, '')), '') as term,
      '%' || replace(replace(replace(
               nullif(btrim(coalesce(p_query, '')), ''),
               '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select
    g.id,
    g.name,
    g.description,
    g.area,
    (select count(*)::integer
       from public.gang_members m
      where m.gang_id = g.id and m.deleted_at is null) as member_count,
    case
      when p_viewer_id is null then null
      when exists (select 1 from public.gang_members m
                    where m.gang_id = g.id
                      and m.user_id = p_viewer_id
                      and m.deleted_at is null)                       then 'member'
      when exists (select 1 from public.join_requests r
                    where r.gang_id = g.id
                      and r.user_id = p_viewer_id
                      and r.status = 'pending')                       then 'pending'
      else null
    end as viewer_status
  from public.gangs g, q
  where g.deleted_at is null
    -- 🔴 สองด่านนี้ห้ามหายไปไหน: ก๊วนส่วนตัว และก๊วนที่ปิด discovery ต้องไม่โผล่เลย
    and g.is_public = true
    and coalesce((g.features ->> 'discovery')::boolean, false) = true
    and (
      q.term is null
      or g.name operator(extensions.%) q.term
      or g.area operator(extensions.%) q.term
      or g.name ilike q.pattern
      or coalesce(g.area, '') ilike q.pattern
    )
  order by
    case
      when q.term is null then 0
      else greatest(
             extensions.similarity(g.name, q.term),
             extensions.similarity(coalesce(g.area, ''), q.term)
           )
    end desc,
    g.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

comment on function public.search_public_gangs(text, integer, uuid) is
  '[WO-3.E] ค้นก๊วนสาธารณะด้วย pg_trgm — กรอง is_public + features.discovery ที่นี่ที่เดียว';

revoke execute on function public.search_public_gangs(text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.search_public_gangs(text, integer, uuid) to service_role;


-- -----------------------------------------------------------------------------
-- ส่วนที่ 3 — ขอเข้าก๊วน
-- -----------------------------------------------------------------------------
-- idempotent: ขอซ้ำระหว่างที่ใบเดิมยังรออยู่ = คืนใบเดิม ไม่สร้างใหม่ ไม่ยิงเตือนซ้ำ
-- (partial unique index `join_requests_gang_user_pending_key` เป็นด่านจริงตอนชนกัน)
create or replace function public.request_to_join_gang(
  p_gang_id        uuid,
  p_user_id        uuid,
  p_message        text default null,
  p_correlation_id text default null
)
returns public.join_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gang    public.gangs;
  v_row     public.join_requests;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_queued  integer;
begin
  select * into v_gang
    from public.gangs
   where id = p_gang_id and deleted_at is null;

  -- ⚠️ ก๊วนส่วนตัวตอบเหมือน "ไม่พบก๊วน" โดยตั้งใจ — ถ้าแยกข้อความจะกลายเป็น
  --    เครื่องมือยืนยันว่า gang id ไหนมีอยู่จริง (แบบเดียวกับ [D-18])
  if not found or not v_gang.is_public then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang', 'id', p_gang_id)::text;
  end if;

  if coalesce((v_gang.features ->> 'discovery')::boolean, false) is not true then
    raise exception using
      errcode = 'P0001', message = 'FEATURE_DISABLED',
      detail  = json_build_object('feature', 'discovery')::text;
  end if;

  if length(coalesce(v_message, '')) > 500 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'message', 'reason', 'ข้อความยาวเกิน 500 ตัวอักษร')::text;
  end if;

  if exists (select 1 from public.gang_members
              where gang_id = p_gang_id and user_id = p_user_id and deleted_at is null) then
    raise exception using
      errcode = 'P0001', message = 'ALREADY_REGISTERED',
      detail  = json_build_object('reason', 'คุณอยู่ในก๊วนนี้อยู่แล้ว')::text;
  end if;

  select * into v_row
    from public.join_requests
   where gang_id = p_gang_id and user_id = p_user_id and status = 'pending';

  if found then
    return v_row;   -- ใบเดิมยังรออยู่ — ไม่สร้างใบใหม่และไม่ยิงเตือนซ้ำ
  end if;

  begin
    insert into public.join_requests (gang_id, user_id, message, status)
    values (p_gang_id, p_user_id, v_message, 'pending')
    returning * into v_row;
  exception
    when unique_violation then
      -- ยิงพร้อมกันสองครั้ง — อีกฝั่งสร้างไปแล้ว คืนใบนั้น
      select * into v_row
        from public.join_requests
       where gang_id = p_gang_id and user_id = p_user_id and status = 'pending';
      return v_row;
  end;

  -- แจ้งแอดมินของก๊วน — dedupe ต่อ (คำขอ, แอดมิน) ⇒ ใบเดิมยิงได้ครั้งเดียว
  select public.enqueue_notifications(
    coalesce(
      (select jsonb_agg(jsonb_build_object(
                'gang_id',      p_gang_id,
                'recipient_id', m.user_id,
                'event_type',   'gang.join_requested',
                'payload',      jsonb_build_object(
                                  'correlation_id',  p_correlation_id,
                                  'join_request_id', v_row.id
                                ),
                'dedupe_key',   'join_request:' || v_row.id || ':' || m.user_id
              ))
         from public.gang_members m
        where m.gang_id = p_gang_id
          and m.deleted_at is null
          and m.role in ('owner', 'admin')),
      '[]'::jsonb
    )
  ) into v_queued;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.join_requested', 'gang', p_gang_id, p_user_id,
     jsonb_build_object(
       'correlation_id',  p_correlation_id,
       'join_request_id', v_row.id,
       'notified',        v_queued
       -- 🔴 ไม่บันทึกข้อความที่ผู้ขอพิมพ์ลง event_logs — สมาชิกก๊วนอ่าน timeline ได้
     ));

  return v_row;
end;
$$;

comment on function public.request_to_join_gang(uuid, uuid, text, text) is
  '[WO-3.E] ขอเข้าก๊วน — ตรวจ is_public + features.discovery + เป็นสมาชิกอยู่แล้วหรือยัง';

revoke execute on function public.request_to_join_gang(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.request_to_join_gang(uuid, uuid, text, text) to service_role;


-- -----------------------------------------------------------------------------
-- ส่วนที่ 4 — คนขอยกเลิกคำขอของตัวเอง
-- -----------------------------------------------------------------------------
create or replace function public.cancel_join_request(
  p_request_id     uuid,
  p_actor_id       uuid,
  p_correlation_id text default null
)
returns public.join_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.join_requests;
begin
  select * into v_row
    from public.join_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'join_request', 'id', p_request_id)::text;
  end if;

  if v_row.user_id is distinct from p_actor_id then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'ยกเลิกได้เฉพาะคำขอของตัวเอง')::text;
  end if;

  if v_row.status <> 'pending' then
    raise exception using
      errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail  = json_build_object('from', v_row.status, 'to', 'cancelled')::text;
  end if;

  update public.join_requests
     set status = 'cancelled', decided_at = now(), decided_by = p_actor_id
   where id = p_request_id
  returning * into v_row;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_row.gang_id, 'gang.join_cancelled', 'gang', v_row.gang_id, p_actor_id,
     jsonb_build_object('correlation_id', p_correlation_id, 'join_request_id', v_row.id));

  return v_row;
end;
$$;

comment on function public.cancel_join_request(uuid, uuid, text) is
  '[WO-3.E] คนขอยกเลิกคำขอของตัวเอง — ใบที่ตัดสินไปแล้วยกเลิกไม่ได้';

revoke execute on function public.cancel_join_request(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_join_request(uuid, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- ส่วนที่ 5 — แอดมินอนุมัติ / ปฏิเสธ
-- -----------------------------------------------------------------------------
-- 🔴 จุดเดียวที่คำขอกลายเป็นสมาชิก — สร้าง `gang_members` + ปิดคำขอ + เขียน event
--    ในธุรกรรมเดียว ⇒ ❌ ห้าม `insert into gang_members` จาก server action
--
-- กดอนุมัติสองครั้งพร้อมกัน: `for update` ทำให้ตัวที่สองรอ แล้วเห็น status ที่เปลี่ยนแล้ว
-- ⇒ ตอบ `INVALID_TRANSITION` และ **ไม่มีสมาชิกซ้ำ** (partial unique index เป็นด่านสุดท้าย)
--
-- ⚠️ `p_gang_id` ไม่ใช่ของประดับ — server action รู้ว่าคนยิงเป็นแอดมินของ **ก๊วนไหน**
--    แต่ id ของคำขอมาจาก client ⇒ ถ้าไม่ผูกสองอย่างนี้ในธุรกรรมเดียวกัน แอดมินก๊วน ก.
--    จะอนุมัติคำขอของก๊วน ข. ได้ (ตรวจทีหลังใน TS ไม่ทัน — สมาชิกถูกสร้างไปแล้ว)
create or replace function public.decide_join_request(
  p_request_id     uuid,
  p_gang_id        uuid,
  p_decision       text,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.join_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.join_requests;
  v_member public.gang_members;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'decision', 'value', p_decision)::text;
  end if;

  select * into v_row
    from public.join_requests
   where id = p_request_id
   for update;

  if not found or v_row.gang_id is distinct from p_gang_id then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'join_request', 'id', p_request_id)::text;
  end if;

  if v_row.status <> 'pending' then
    raise exception using
      errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail  = json_build_object('from', v_row.status, 'to', p_decision)::text;
  end if;

  if p_decision = 'approved' then
    -- เคยอยู่ก๊วนนี้แล้วถูกลบออก → รับกลับแถวเดิม (เหมือน `add_gang_member_by_email`)
    update public.gang_members
       set deleted_at = null,
           deleted_by = null,
           updated_by = p_actor_id
     where gang_id = v_row.gang_id
       and user_id = v_row.user_id
       and deleted_at is not null
    returning * into v_member;

    if not found then
      begin
        insert into public.gang_members (gang_id, user_id, role, created_by)
        values (v_row.gang_id, v_row.user_id, 'member', p_actor_id)
        returning * into v_member;
      exception
        when unique_violation then
          -- เข้าก๊วนไปแล้วทางอื่น (แอดมินเพิ่มด้วยอีเมลระหว่างรอ) — ถือว่าอนุมัติสำเร็จ
          select * into v_member
            from public.gang_members
           where gang_id = v_row.gang_id
             and user_id = v_row.user_id
             and deleted_at is null;
      end;
    end if;
  end if;

  update public.join_requests
     set status      = p_decision,
         decided_at  = now(),
         decided_by  = p_actor_id
   where id = p_request_id
  returning * into v_row;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_row.gang_id,
     case when p_decision = 'approved' then 'gang.join_approved' else 'gang.join_rejected' end,
     'member', coalesce(v_member.id, v_row.gang_id), p_actor_id,
     jsonb_build_object(
       'correlation_id',  p_correlation_id,
       'join_request_id', v_row.id
     ));

  -- แจ้งคนขอ — dedupe ต่อ (คำขอ, การตัดสิน) ⇒ ใบหนึ่งได้ผลลัพธ์ครั้งเดียว
  perform public.enqueue_notifications(
    jsonb_build_array(jsonb_build_object(
      'gang_id',      v_row.gang_id,
      'recipient_id', v_row.user_id,
      'event_type',   'gang.join_decided',
      'payload',      jsonb_build_object(
                        'correlation_id',  p_correlation_id,
                        'join_request_id', v_row.id,
                        'status',          v_row.status
                      ),
      'dedupe_key',   'join_request:' || v_row.id || ':decision'
    ))
  );

  return v_row;
end;
$$;

comment on function public.decide_join_request(uuid, uuid, text, uuid, text) is
  '[WO-3.E] อนุมัติ/ปฏิเสธคำขอ — จุดเดียวที่สร้าง gang_members จากคำขอ (atomic)';

revoke execute on function public.decide_join_request(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.decide_join_request(uuid, uuid, text, uuid, text) to service_role;
