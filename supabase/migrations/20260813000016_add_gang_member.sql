-- =============================================================================
-- WO-2.3 · 0016 — เพิ่มสมาชิกเข้าก๊วนด้วยอีเมล
-- =============================================================================
-- 🔴 ช่องว่างที่เจอตอนทำ WO-2.3 [D-18]
--
-- MVP-0 ไม่มีทางเพิ่มสมาชิกเข้าก๊วนเลย:
--   - `gang_members.user_id` เป็น NOT NULL ⇒ เพิ่มคนที่ยังไม่มีบัญชีไม่ได้
--   - `profiles` **ไม่มีคอลัมน์อีเมล** (อีเมลอยู่ใน `auth.users` ซึ่ง client อ่านไม่ได้)
--   - `join_requests` มีอยู่ในสคีมาแต่เป็นของ Phase 3 (discovery)
--   ⇒ ก๊วนที่สร้างใหม่จะมีแค่เจ้าของคนเดียวตลอดไป = ใช้งานจริงไม่ได้
--
-- ทางเลือกที่พิจารณา:
--   (ก) เพิ่มตาราง gang_invite_tokens — ขัดกติกา "ห้ามเพิ่มตารางนอก baseline"
--   (ข) ให้แอดมินค้นสมาชิกจากรายชื่อผู้ใช้ทั้งหมด — รั่วข้อมูลผู้ใช้ทั้งแพลตฟอร์ม
--       และขัด [D-12] ที่เพิ่งปิดไปใน WO-1.4
--   (ค) แอดมินพิมพ์อีเมลของคนที่ **มีบัญชีอยู่แล้ว** → server หาให้แล้วเพิ่มเข้าก๊วน
--
-- เลือก (ค): ไม่เพิ่มตาราง ไม่รั่วรายชื่อ (ต้องรู้อีเมลที่ถูกต้องอยู่ก่อน)
-- และเป็นพฤติกรรมที่ก๊วนจริงทำอยู่แล้ว (ถามอีเมลกันในไลน์กลุ่ม)
--
-- ⚠️ ข้อจำกัดที่ยอมรับ: เชิญคนที่**ยังไม่มีบัญชี**ไม่ได้ ต้องให้เขาสมัครก่อน
--    ⇒ ลิงก์เชิญเข้าก๊วนเป็นงาน Phase 3 (บันทึกใน BACKLOG)
--
-- 🔴 ฟังก์ชันนี้ **ไม่บอกว่าอีเมลนั้นมีบัญชีอยู่หรือไม่** เมื่อหาไม่เจอ
--    จะ raise `NOT_FOUND` เหมือนกันหมด — ถ้าแยกข้อความจะกลายเป็นเครื่องมือ
--    ตรวจสอบว่าอีเมลไหนสมัครไว้แล้ว (user enumeration) ให้ใครก็ได้ที่เป็นแอดมินก๊วน
--
-- Rollback: DROP FUNCTION public.add_gang_member_by_email(uuid, text, text, uuid, text);
-- =============================================================================

create or replace function public.add_gang_member_by_email(
  p_gang_id        uuid,
  p_email          text,
  p_role           text default 'member',
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.gang_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_member  public.gang_members;
  v_email   text := lower(btrim(coalesce(p_email, '')));
begin
  if p_role not in ('owner', 'admin', 'member') then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'role', 'value', p_role)::text;
  end if;

  if v_email = '' then
    raise exception using
      errcode = 'P0001',
      message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'email', 'reason', 'ต้องระบุอีเมล')::text;
  end if;

  if not exists (select 1 from public.gangs where id = p_gang_id and deleted_at is null) then
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang', 'id', p_gang_id)::text;
  end if;

  select u.id into v_user_id
    from auth.users u
   where lower(u.email) = v_email
   limit 1;

  if v_user_id is null then
    -- ⚠️ ข้อความเดียวกับเคส "ไม่พบก๊วน" โดยตั้งใจ — ห้ามบอกว่าอีเมลนี้ไม่มีบัญชี
    raise exception using
      errcode = 'P0001',
      message = 'NOT_FOUND',
      detail  = json_build_object('reason', 'ไม่พบผู้ใช้ที่ใช้อีเมลนี้ — ต้องสมัครสมาชิกก่อน')::text;
  end if;

  -- เคยอยู่ก๊วนนี้แล้วถูกลบออก → รับกลับเข้ามาแทนที่จะสร้างแถวใหม่
  -- (partial unique index กันเฉพาะแถวที่ deleted_at is null)
  update public.gang_members
     set deleted_at = null,
         deleted_by = null,
         role       = p_role,
         updated_by = p_actor_id
   where gang_id = p_gang_id
     and user_id = v_user_id
     and deleted_at is not null
  returning * into v_member;

  if not found then
    begin
      insert into public.gang_members (gang_id, user_id, role, created_by)
      values (p_gang_id, v_user_id, p_role, p_actor_id)
      returning * into v_member;
    exception
      when unique_violation then
        raise exception using
          errcode = 'P0001',
          message = 'ALREADY_REGISTERED',
          detail  = json_build_object('reason', 'คนนี้อยู่ในก๊วนนี้อยู่แล้ว')::text;
    end;
  end if;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.member_added', 'member', v_member.id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'role',           p_role
       -- 🔴 ไม่บันทึกอีเมลลง event_logs — เป็นข้อมูลส่วนตัวที่สมาชิกก๊วนอ่าน timeline ได้
     ));

  return v_member;
end;
$$;

comment on function public.add_gang_member_by_email(uuid, text, text, uuid, text) is
  '[D-18] เพิ่มสมาชิกด้วยอีเมลของคนที่มีบัญชีแล้ว — ไม่เปิดเผยว่าอีเมลไหนมีบัญชีอยู่';

revoke execute on function public.add_gang_member_by_email(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.add_gang_member_by_email(uuid, text, text, uuid, text)
  to service_role;
