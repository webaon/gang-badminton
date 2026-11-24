-- =============================================================================
-- WO-B2 · 0040 — ออกจากก๊วนเอง + โอนความเป็นเจ้าของ (ADR-012)
-- =============================================================================
-- ปัญหา: สมาชิกออกจากก๊วนเองไม่ได้ · owner ส่งต่อก๊วนไม่ได้ · และกติกา
--        "ห้ามก๊วนไร้ owner" เดิมเป็น check-then-act ใน TS (race ได้)
--
-- แก้ด้วยฟังก์ชันสองตัวที่ `SELECT … FOR UPDATE` แถว `gang_members` ของก๊วนนั้น
-- (เรียงตาม id ⇒ สองฟังก์ชันที่ชนกันจะ serialize ไม่ deadlock) แล้วค่อยตรวจใหม่
--
-- 🔴 กติกาที่ต้องไม่ถูกละเมิด
--   - registration ที่ยกเลิก ต้องผ่าน `cancel_registration()` เดิมเท่านั้น (penalty /
--     is_late_cancel / promote waitlist เหมือนยกเลิกเอง) — ห้ามเขียน status ตรง
--   - ไม่แตะ session_charges / payments / payment_allocations / payment_adjustments
--     (หนี้ไม่หายเมื่อออก — ledger คำนวณจาก charge ไม่ผูกกับสถานะสมาชิก)
--   - EXECUTE เฉพาะ service_role · server action ยืนยันตัวตนแล้วส่ง p_actor_id
--   - ไม่เพิ่ม error.code ใหม่ (ใช้ NOT_GANG_MEMBER / FORBIDDEN / VALIDATION_ERROR /
--     NOT_FOUND ที่มีใน docs/errors.md · เหตุผลอยู่ใน detail.reason)
--
-- Rollback:
--   DROP FUNCTION public.leave_gang(uuid, uuid, text);
--   DROP FUNCTION public.transfer_gang_ownership(uuid, uuid, uuid, text);
-- =============================================================================


-- -----------------------------------------------------------------------------
-- leave_gang(gang_id, actor_id, correlation_id)
-- -----------------------------------------------------------------------------
-- คืน jsonb { member_id, cancelled_registrations, outstanding_charges, outstanding_amount(text) }
create or replace function public.leave_gang(
  p_gang_id        uuid,
  p_actor_id       uuid,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member       public.gang_members;
  v_other_owners integer;
  v_reg_id       uuid;
  v_cancelled    integer := 0;
  v_owed_count   integer;
  v_owed_amount  numeric(12, 2);
begin
  if p_gang_id is null or p_actor_id is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ต้องระบุก๊วนและผู้ใช้')::text;
  end if;

  if not exists (select 1 from public.gangs where id = p_gang_id and deleted_at is null) then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang', 'id', p_gang_id)::text;
  end if;

  -- 🔴 lock แถวสมาชิก active ทั้งก๊วน (เรียง id) — leave/transfer ที่ชนกันจะต่อคิวที่นี่
  --    จุดนับ owner ด้านล่างจึงเห็นสถานะจริงเสมอ ไม่ใช่ snapshot ก่อนมีคนโอน
  perform 1
     from public.gang_members
    where gang_id    = p_gang_id
      and deleted_at is null
    order by id
      for update;

  select * into v_member
    from public.gang_members
   where gang_id    = p_gang_id
     and user_id    = p_actor_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_GANG_MEMBER',
      detail  = json_build_object('gang_id', p_gang_id)::text;
  end if;

  -- owner คนสุดท้ายออกไม่ได้ — ต้องโอนให้คนอื่นก่อน (ก๊วนที่มี owner หลายคนอยู่แล้วออกได้)
  if v_member.role = 'owner' then
    select count(*) into v_other_owners
      from public.gang_members
     where gang_id    = p_gang_id
       and role       = 'owner'
       and deleted_at is null
       and id        <> v_member.id;

    if v_other_owners = 0 then
      raise exception using
        errcode = 'P0001', message = 'VALIDATION_ERROR',
        detail  = json_build_object(
          'field',  'role',
          'reason', 'เจ้าของก๊วนคนสุดท้ายออกไม่ได้ — ต้องโอนความเป็นเจ้าของก่อน'
        )::text;
    end if;
  end if;

  -- ยกเลิก registration อนาคตทีละใบด้วย cancel_registration() เดิม (lock session → registration
  -- → promote waitlist ในตัว) · ถ้าใบไหนยกเลิกไม่ได้ (เช่น CANCEL_CUTOFF_PASSED) ทั้งก้อน rollback
  -- ⇒ ไม่มีสถานะ "ออกแล้วแต่ยังถือที่ค้าง"
  -- นัดที่เริ่ม/ปิดแล้ว และ registration ที่ checked_in ไม่แตะ — ปิดรอบ/คิดเงินตามปกติ
  for v_reg_id in
    select r.id
      from public.session_registrations r
      join public.sessions s on s.id = r.session_id
     where s.gang_id    = p_gang_id
       and s.deleted_at is null
       and s.status     in ('draft', 'open')
       and s.starts_at  > now()
       and r.user_id    = p_actor_id
       and r.status     in ('confirmed', 'waitlist')
       and r.deleted_at is null
     order by s.starts_at, r.id
  loop
    perform public.cancel_registration(v_reg_id, p_actor_id, p_correlation_id);
    v_cancelled := v_cancelled + 1;
  end loop;

  -- ยอดค้างจ่าย "ณ ตอนออก" — อ่านอย่างเดียวจาก ledger (charge_outstanding) ไม่แก้อะไร
  -- ⚠️ RLS ของ session_charges ผูกกับการเป็นสมาชิกต่อ (ผ่าน registration/gang_member) ⇒ ออกแล้ว
  --    ผู้ออกอ่านรายการหนี้ของตัวเองเองไม่ได้อีก · ต้องแจ้งยอดตรงนี้เป็นครั้งสุดท้าย (ADR-012)
  --    นับเฉพาะยอดที่ค้างจริง (> 0) — ยอดที่จ่ายเกินไม่หักกลบกับหนี้อื่น (กติกาเดิม)
  select count(*)::integer,
         coalesce(sum(o.outstanding), 0)::numeric(12, 2)
    into v_owed_count, v_owed_amount
    from (
      select public.charge_outstanding(c.id) as outstanding
        from public.session_charges c
       where c.gang_id = p_gang_id
         and (
           c.gang_member_id = v_member.id
           or exists (
             select 1 from public.session_registrations r
              where r.id = c.registration_id and r.user_id = p_actor_id
           )
         )
    ) o
   where o.outstanding > 0;

  update public.gang_members
     set deleted_at = now(),
         deleted_by = p_actor_id,
         updated_by = p_actor_id
   where id = v_member.id;

  -- ออกแล้วไม่ควรได้ LINE ของก๊วนนี้อีก (ผูกใหม่ได้เมื่อกลับเข้ามา)
  delete from public.member_line_links
   where gang_id = p_gang_id
     and user_id = p_actor_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.member_left', 'member', v_member.id, p_actor_id,
     jsonb_build_object(
       'correlation_id',          p_correlation_id,
       'role',                    v_member.role,
       'cancelled_registrations', v_cancelled
       -- 🔴 ไม่บันทึกยอดค้าง — event นี้สมาชิกก๊วนอ่าน timeline ได้
     ));

  -- ยอดเงินคืนเป็น string (ไม่ใช่ JSON number) — domain/billing/money.ts ไม่รับ number
  return jsonb_build_object(
    'member_id',               v_member.id,
    'cancelled_registrations', v_cancelled,
    'outstanding_charges',     v_owed_count,
    'outstanding_amount',      v_owed_amount::text
  );
end;
$$;

comment on function public.leave_gang(uuid, uuid, text) is
  '[ADR-012] ออกจากก๊วนเอง — lock สมาชิก · owner คนสุดท้ายออกไม่ได้ · ยกเลิก registration อนาคตผ่าน cancel_registration() · หนี้ไม่แตะ';

revoke execute on function public.leave_gang(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.leave_gang(uuid, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- transfer_gang_ownership(gang_id, actor_id, to_user_id, correlation_id)
-- -----------------------------------------------------------------------------
-- owner → admin และผู้รับ → owner ใน transaction เดียว · คืนแถวของผู้รับ
create or replace function public.transfer_gang_ownership(
  p_gang_id        uuid,
  p_actor_id       uuid,
  p_to_user_id     uuid,
  p_correlation_id text default null
)
returns public.gang_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from public.gang_members;
  v_to   public.gang_members;
begin
  if p_gang_id is null or p_actor_id is null or p_to_user_id is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ต้องระบุก๊วน ผู้โอน และผู้รับ')::text;
  end if;

  if p_to_user_id = p_actor_id then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'to_user_id', 'reason', 'โอนให้ตัวเองไม่ได้')::text;
  end if;

  if not exists (select 1 from public.gangs where id = p_gang_id and deleted_at is null) then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang', 'id', p_gang_id)::text;
  end if;

  -- 🔴 lock เหมือน leave_gang() ทุกประการ (ลำดับ id เดียวกัน) — โอนสองทางพร้อมกัน
  --    คนที่สองจะเห็นว่าตัวเองไม่ใช่ owner แล้ว และถูกปฏิเสธ
  perform 1
     from public.gang_members
    where gang_id    = p_gang_id
      and deleted_at is null
    order by id
      for update;

  select * into v_from
    from public.gang_members
   where gang_id    = p_gang_id
     and user_id    = p_actor_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_GANG_MEMBER',
      detail  = json_build_object('gang_id', p_gang_id)::text;
  end if;

  if v_from.role <> 'owner' then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะเจ้าของก๊วนที่โอนความเป็นเจ้าของได้')::text;
  end if;

  select * into v_to
    from public.gang_members
   where gang_id    = p_gang_id
     and user_id    = p_to_user_id
     and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field',  'to_user_id',
        'reason', 'โอนให้ได้เฉพาะสมาชิกของก๊วนนี้'
      )::text;
  end if;

  if v_to.role = 'owner' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field',  'to_user_id',
        'reason', 'คนนี้เป็นเจ้าของก๊วนอยู่แล้ว'
      )::text;
  end if;

  update public.gang_members
     set role = 'admin', updated_by = p_actor_id
   where id = v_from.id;

  update public.gang_members
     set role = 'owner', updated_by = p_actor_id
   where id = v_to.id
  returning * into v_to;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'gang.ownership_transferred', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'from_user_id',   p_actor_id,
       'to_user_id',     p_to_user_id,
       'from_role_after', 'admin'
     ));

  return v_to;
end;
$$;

comment on function public.transfer_gang_ownership(uuid, uuid, uuid, text) is
  '[ADR-012] โอนความเป็นเจ้าของ — lock สมาชิก · เฉพาะ owner · ผู้รับต้องเป็นสมาชิก active · owner เดิมเป็น admin';

revoke execute on function public.transfer_gang_ownership(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.transfer_gang_ownership(uuid, uuid, uuid, text) to service_role;
