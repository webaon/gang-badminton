-- =============================================================================
-- WO-2.5-D · 0026 — payment_allocations + adjustments (ledger)
-- =============================================================================
-- baseline §การตัดสินใจสะสม:
--   ยอดสุทธิต่อคน = charge − allocations + adjustments  (คำนวณสดเสมอ)
--   Allocated / Adjusted / Refunded **ไม่ใช่ state ของ payment**
--
-- 🔴 สิ่งที่ migration นี้ปิด
--   1. ออกใบจ่ายซ้ำ — เดิมกด "ขอ QR" ซ้ำได้ใบใหม่ทุกครั้ง ⇒ ยอดค้างบวม
--      ตอนนี้ถ้ายังมีใบที่ยังไม่ verified ครอบ charge ชุดเดียวกัน จะคืนใบเดิม
--   2. จ่ายแทนเพื่อน — 1 สลิปครอบหลาย charge ข้ามคน ผ่าน payment_allocations
--   3. แก้ยอดหลัง verify — ต้องผ่าน payment_adjustments เท่านั้น
--      มี trigger กันการแก้ `session_charges.amount` ของหนี้ที่จ่ายแล้ว
--
-- Rollback: DROP FUNCTION public.add_payment_adjustment(uuid, text, numeric, text, uuid, uuid, text);
--           DROP TRIGGER session_charges_no_edit_after_paid ON public.session_charges;
--           DROP FUNCTION public.forbid_paid_charge_amount_change();
--           แล้ว restore create_payment_for_charges เวอร์ชัน 0022
-- =============================================================================

-- -----------------------------------------------------------------------------
-- event_logs รับ aggregate_type = 'charge' ได้ (expand — additive ล้วน)
-- -----------------------------------------------------------------------------
-- รายการปรับยอดเกิดกับ **หนี้ก้อนหนึ่ง** ไม่ใช่ payment (สลิปใบเดียวครอบหลายคน)
-- ⇒ ถ้าบันทึกเป็น aggregate_type='payment' จะตามรอยไม่ได้ว่าลดหนี้ของใคร
alter table public.event_logs drop constraint if exists event_logs_aggregate_type_check;
alter table public.event_logs add constraint event_logs_aggregate_type_check
  check (aggregate_type in ('session', 'game', 'payment', 'registration', 'gang', 'member', 'charge'));


-- -----------------------------------------------------------------------------
-- charge_outstanding(charge_id) — ยอดค้างของหนี้ก้อนเดียว
-- -----------------------------------------------------------------------------
-- ⚠️ นี่คือการรวม **ledger** ไม่ใช่การคิดราคา ⇒ ไม่ขัด ADR-001
--    (ADR-001 ห้ามย้าย "สูตรคิดเงิน" ลง SQL — ยอดต่อคนยังคิดใน domain/billing เหมือนเดิม)
--
-- 🔴 นับเฉพาะ allocation ของสลิปที่ **verified** แล้ว
--    ถ้านับสลิปที่ยังไม่ยืนยันด้วย คนอัปสลิปปลอมจะทำให้หนี้หายทันที
create or replace function public.charge_outstanding(p_charge_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select c.amount
       - coalesce((
           select sum(a.amount)
             from public.payment_allocations a
             join public.payments p on p.id = a.payment_id
            where a.session_charge_id = c.id
              and p.status = 'verified'
              and p.deleted_at is null
         ), 0)
       + coalesce((
           select sum(j.amount)
             from public.payment_adjustments j
            where j.session_charge_id = c.id
         ), 0)
    from public.session_charges c
   where c.id = p_charge_id;
$$;

comment on function public.charge_outstanding(uuid) is
  '[WO-2.5-D] ยอดค้างของ charge = amount − allocations(verified) + adjustments';


-- -----------------------------------------------------------------------------
-- create_payment_for_charges(...) — v2: allocations + ไม่ออกใบซ้ำ
-- -----------------------------------------------------------------------------
-- แทนที่เวอร์ชันของ 0022 (ซึ่งยังไม่มี allocations และออกใบใหม่ทุกครั้ง)
create or replace function public.create_payment_for_charges(
  p_gang_id        uuid,
  p_payer_user_id  uuid,
  p_charge_ids     uuid[],
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested integer := coalesce(array_length(p_charge_ids, 1), 0);
  v_found     integer;
  v_total     numeric(12, 2);
  v_payment   public.payments;
  v_existing  uuid;
  v_payable   uuid[];
begin
  if v_requested = 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ไม่ได้ระบุรายการที่จะจ่าย')::text;
  end if;

  select count(*) into v_found
    from public.session_charges
   where id = any(p_charge_ids)
     and gang_id = p_gang_id;

  if v_found <> v_requested then
    raise exception using
      errcode = 'P0001', message = 'CHARGE_NOT_FOUND',
      detail  = json_build_object('reason', 'มี charge ที่ไม่มีอยู่จริงหรือไม่ได้อยู่ในก๊วนนี้')::text;
  end if;

  -- ยอดค้างจริงของแต่ละก้อน (หักที่จ่ายไปแล้ว + รายการปรับยอด)
  -- ⚠️ ใช้ array ไม่ใช่ temporary table — ฟังก์ชันนี้อาจถูกเรียกสองครั้งใน
  --    transaction เดียว (จ่ายให้ตัวเองแล้วจ่ายแทนเพื่อนต่อ) แล้ว temp table จะชนกันเอง
  select array_agg(t.id order by t.id), coalesce(sum(t.outstanding), 0)
    into v_payable, v_total
    from (
      select c.id, public.charge_outstanding(c.id) as outstanding
        from public.session_charges c
       where c.id = any(p_charge_ids)
    ) t
   where t.outstanding > 0;

  if v_total <= 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ไม่มียอดค้างสำหรับรายการที่เลือก')::text;
  end if;

  -- 🔴 ไม่ออกใบซ้ำ: ถ้ามีใบที่ยังไม่ verified ครอบ charge **ชุดเดียวกันเป๊ะ** อยู่แล้ว ใช้ใบเดิม
  --    (กด "ขอ QR" ซ้ำจากหน้าจอค้าง / กดสองครั้ง / เปิดสองแท็บ)
  select p.id into v_existing
    from public.payments p
   where p.gang_id = p_gang_id
     and p.payer_user_id = p_payer_user_id
     and p.deleted_at is null
     and p.status in ('pending', 'submitted', 'rejected')
     and (
       select array_agg(a.session_charge_id order by a.session_charge_id)
         from public.payment_allocations a
        where a.payment_id = p.id
     ) = v_payable
   order by p.created_at desc
   limit 1;

  if v_existing is not null then
    select * into v_payment from public.payments where id = v_existing;
    return v_payment;
  end if;

  insert into public.payments (gang_id, payer_user_id, amount, created_by)
  values (p_gang_id, p_payer_user_id, v_total, p_actor_id)
  returning * into v_payment;

  insert into public.payment_allocations (payment_id, session_charge_id, amount, created_by)
  select v_payment.id, c.id, public.charge_outstanding(c.id), p_actor_id
    from public.session_charges c
   where c.id = any(v_payable);

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'payment.created', 'payment', v_payment.id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'amount',         v_total,
       'charge_count',   coalesce(array_length(v_payable, 1), 0)
     ));

  return v_payment;
end;
$$;


-- -----------------------------------------------------------------------------
-- add_payment_adjustment(...) — refund / correction / credit ระดับ charge
-- -----------------------------------------------------------------------------
-- append-only: ❌ ไม่แก้ `session_charges` และ ❌ ไม่แก้ `payments` ที่ verify แล้ว
create or replace function public.add_payment_adjustment(
  p_charge_id      uuid,
  p_type           text,
  p_amount         numeric,
  p_reason         text,
  p_payment_id     uuid default null,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.payment_adjustments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_charge     public.session_charges;
  v_allocated  numeric(12, 2);
  v_refunded   numeric(12, 2);
  v_adjustment public.payment_adjustments;
begin
  select * into v_charge from public.session_charges where id = p_charge_id;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'CHARGE_NOT_FOUND',
      detail  = json_build_object('charge_id', p_charge_id)::text;
  end if;

  if p_type not in ('refund', 'correction', 'credit') then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'type', 'value', p_type)::text;
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'amount', 'reason', 'ต้องไม่เป็น 0')::text;
  end if;

  -- 🔴 refund/credit = ลดหนี้ ⇒ ต้องติดลบ
  --    ส่งค่าบวกมาแล้วปล่อยผ่าน = ตั้งใจคืนเงินแต่หนี้เพิ่ม (เสียหายเงียบ)
  if p_type in ('refund', 'credit') and p_amount > 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field', 'amount',
        'reason', 'refund/credit ต้องเป็นยอดติดลบ'
      )::text;
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'reason', 'reason', 'ต้องระบุเหตุผล')::text;
  end if;

  -- 🔴 คืนเงินเกินกว่าที่เก็บมาจริงไม่ได้
  if p_type = 'refund' then
    select coalesce(sum(a.amount), 0) into v_allocated
      from public.payment_allocations a
      join public.payments p on p.id = a.payment_id
     where a.session_charge_id = p_charge_id
       and p.status = 'verified'
       and p.deleted_at is null;

    select coalesce(-sum(j.amount), 0) into v_refunded
      from public.payment_adjustments j
     where j.session_charge_id = p_charge_id
       and j.type = 'refund';

    if v_refunded + (-p_amount) > v_allocated then
      raise exception using
        errcode = 'P0001', message = 'VALIDATION_ERROR',
        detail  = json_build_object(
          'reason', 'คืนเงินเกินยอดที่จ่ายมาแล้ว',
          'allocated', v_allocated,
          'refunded', v_refunded
        )::text;
    end if;
  end if;

  insert into public.payment_adjustments
    (session_charge_id, payment_id, type, amount, reason, created_by)
  values
    (p_charge_id, p_payment_id, p_type, p_amount, btrim(p_reason), p_actor_id)
  returning * into v_adjustment;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_charge.gang_id, v_charge.session_id, 'payment.adjusted', 'charge',
     p_charge_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'type',           p_type,
       'amount',         p_amount,
       'reason',         btrim(p_reason),
       'outstanding_after', public.charge_outstanding(p_charge_id)
     ));

  return v_adjustment;
end;
$$;


-- -----------------------------------------------------------------------------
-- 🔴 ห้ามแก้ยอดหนี้ที่จ่ายแล้ว — ต้องผ่าน ledger เท่านั้น
-- -----------------------------------------------------------------------------
create or replace function public.forbid_paid_charge_amount_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.amount is distinct from old.amount
     and exists (
       select 1
         from public.payment_allocations a
         join public.payments p on p.id = a.payment_id
        where a.session_charge_id = old.id
          and p.status = 'verified'
          and p.deleted_at is null
     )
  then
    raise exception using
      errcode = 'P0001', message = 'PAYMENT_ALREADY_VERIFIED',
      detail  = json_build_object(
        'charge_id', old.id,
        'reason', 'หนี้ก้อนนี้ถูกจ่ายและยืนยันแล้ว — แก้ยอดต้องผ่าน payment_adjustments'
      )::text;
  end if;

  return new;
end;
$$;

create trigger session_charges_no_edit_after_paid
  before update on public.session_charges
  for each row execute function public.forbid_paid_charge_amount_change();


revoke execute on function public.add_payment_adjustment(uuid, text, numeric, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.add_payment_adjustment(uuid, text, numeric, text, uuid, uuid, text)
  to service_role;

revoke execute on function public.charge_outstanding(uuid) from public, anon;
-- อ่านยอดค้างของตัวเองได้จากฝั่ง client (RLS ของ session_charges กรองแถวอยู่แล้ว)
grant execute on function public.charge_outstanding(uuid) to authenticated, service_role;
