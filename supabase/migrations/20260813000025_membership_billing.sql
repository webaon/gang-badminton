-- =============================================================================
-- WO-2.5-C · 0025 — MembershipBilling: commit ค่าสมาชิกรายเดือน
-- =============================================================================
-- 🔴 ADR-001 บังคับว่า charges ประเภท `monthly_fee` ต้อง commit ผ่าน
--    **ฟังก์ชันของ MembershipBilling เอง** ไม่ใช่ `close_session_with_charges()`
--    เพราะไม่มี session ให้ transition (`session_id` ต้องเป็น null ตาม constraint)
--
-- 🔴 idempotent ต่อสมาชิก+เดือน — baseline §Verification
--    บังคับด้วย partial unique index `session_charges_monthly_member_month_key`
--    ที่มีอยู่แล้วตั้งแต่ 0004 ⇒ ที่นี่ใช้ `on conflict ... do nothing`
--    ❌ ห้ามเช็ค "มีอยู่แล้วหรือยัง" ด้วย SELECT ก่อน INSERT — cron สองตัวรันพร้อมกัน
--       จะผ่าน check ทั้งคู่แล้วชนกันที่ INSERT (check-then-act, CLAUDE.md §2.1)
--
-- Rollback: DROP FUNCTION public.commit_monthly_fees(uuid, date, jsonb, uuid, text);
-- =============================================================================

create or replace function public.commit_monthly_fees(
  p_gang_id        uuid,
  p_billing_month  date,
  p_charges        jsonb,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns table (created integer, skipped integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested integer;
  v_owned     integer;
  v_created   integer;
begin
  if p_billing_month is null or p_billing_month <> date_trunc('month', p_billing_month)::date then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field', 'billing_month',
        'reason', 'ต้องเป็นวันแรกของเดือน'
      )::text;
  end if;

  if p_charges is null or jsonb_typeof(p_charges) <> 'array' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'charges', 'reason', 'ต้องเป็น array')::text;
  end if;

  create temporary table _monthly_fees (
    gang_member_id uuid           not null,
    amount         numeric(12, 2) not null,
    breakdown      jsonb          not null
  ) on commit drop;

  insert into _monthly_fees (gang_member_id, amount, breakdown)
  select c.gang_member_id, c.amount, coalesce(c.breakdown, '{}'::jsonb)
    from jsonb_to_recordset(p_charges)
      as c(gang_member_id uuid, amount numeric(12, 2), breakdown jsonb);

  select count(*) into v_requested from _monthly_fees;

  if v_requested = 0 then
    return query select 0, 0;
    return;
  end if;

  -- 🔴 กันข้ามก๊วน: ทุก gang_member ที่ส่งมาต้องอยู่ในก๊วนนี้จริงและยังไม่ถูกลบ
  --    ถ้าไม่ตรงแปลว่า caller คำนวณมาจากข้อมูลผิดก๊วน ⇒ ต้องหยุด ไม่ใช่เก็บเงินคนอื่น
  select count(*) into v_owned
    from _monthly_fees f
    join public.gang_members m
      on m.id = f.gang_member_id
     and m.gang_id = p_gang_id
     and m.deleted_at is null;

  if v_owned <> v_requested then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'reason', 'มีสมาชิกที่ไม่ได้อยู่ในก๊วนนี้อยู่ในรายการเรียกเก็บ',
        'requested', v_requested,
        'owned', v_owned
      )::text;
  end if;

  insert into public.session_charges
    (gang_id, type, gang_member_id, billing_month, amount, breakdown, created_by)
  select p_gang_id, 'monthly_fee', f.gang_member_id, p_billing_month,
         f.amount, f.breakdown, p_actor_id
    from _monthly_fees f
  -- ชนกับใบที่ออกไปแล้ว = ไม่ต้องทำอะไร (นี่คือ idempotency ที่ DoD ต้องการ)
  on conflict (gang_member_id, billing_month) where type = 'monthly_fee'
  do nothing;

  get diagnostics v_created = row_count;

  -- บันทึกเฉพาะรอบที่สร้างของใหม่จริง — รันซ้ำแล้วไม่มีอะไรเกิด ไม่ต้องรก event log
  if v_created > 0 then
    insert into public.event_logs
      (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
    values
      (p_gang_id, 'membership.fees_generated', 'gang', p_gang_id, p_actor_id,
       jsonb_build_object(
         'correlation_id', p_correlation_id,
         'billing_month',  p_billing_month,
         'created',        v_created,
         'requested',      v_requested
       ));
  end if;

  return query select v_created, v_requested - v_created;
end;
$$;

comment on function public.commit_monthly_fees(uuid, date, jsonb, uuid, text) is
  '[WO-2.5-C][ADR-001] จุด commit เดียวของ session_charges type=monthly_fee — idempotent ต่อสมาชิก+เดือน';

revoke execute on function public.commit_monthly_fees(uuid, date, jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function public.commit_monthly_fees(uuid, date, jsonb, uuid, text)
  to service_role;
