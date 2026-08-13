-- =============================================================================
-- WO-2.9 · 0022 — transition_payment() + สร้าง payment จาก charges
-- =============================================================================
-- 🔴 ปิดหนี้ที่ค้างมาตั้งแต่ Phase 1
--
-- WO-1.3 ติด BEFORE UPDATE trigger บน `payments` ตามที่ baseline สั่ง
-- (§State Machines [v3.2]: "pattern เดียวกันใช้กับ payments") แต่ลิสต์ 6 ฟังก์ชัน
-- ของ Phase 1 ไม่มีตัวที่ set GUC ให้ payments
-- ⇒ **payment เปลี่ยน status ไม่ได้เลยทุกทาง** ตั้งแต่นั้นมา
--
-- BACKLOG จดไว้ตลอดว่า "ห้ามแก้ด้วยการถอด trigger" — migration นี้คือทางที่ถูก
--
-- ─────────────────────────────────────────────────────────────────────────────
-- State machine ของ payment (baseline §State Machines):
--   pending → submitted → verified | rejected
--   rejected → submitted        (อัปสลิปใหม่ได้)
--
-- ❌ ไม่มีเส้นออกจาก `verified` — แก้ยอดที่ verify แล้วต้องใช้ `payment_adjustments`
--    (ledger append-only) ไม่ใช่ย้อนสถานะ
--
-- Rollback: DROP FUNCTION public.transition_payment(uuid, text, uuid, text, text);
--           DROP FUNCTION public.create_payment_for_charges(uuid, uuid, uuid[], uuid, text);
-- =============================================================================

-- -----------------------------------------------------------------------------
-- is_valid_payment_transition(from, to)
-- -----------------------------------------------------------------------------
create or replace function public.is_valid_payment_transition(p_from text, p_to text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select (p_from, p_to) in (
    ('pending',   'submitted'),
    ('submitted', 'verified'),
    ('submitted', 'rejected'),
    -- อัปสลิปใหม่หลังถูกปฏิเสธ
    ('rejected',  'submitted')
  );
$$;

comment on function public.is_valid_payment_transition(text, text) is
  'แหล่งเดียวของเส้น transition ของ payment — ไม่มีเส้นออกจาก verified โดยตั้งใจ';


-- -----------------------------------------------------------------------------
-- transition_payment(...)
-- -----------------------------------------------------------------------------
-- ใช้ GUC ตัวเดียวกับ sessions (`app.allow_transition`) เพราะ trigger
-- `enforce_status_transition()` เป็นตัวเดียวกัน — เก็บ id ของแถวแล้วเคลียร์ทันที
-- ⇒ ใบอนุญาตเป็น one-shot ต่อแถว ไม่ค้างทั้ง transaction
create or replace function public.transition_payment(
  p_payment_id     uuid,
  p_to_status      text,
  p_actor_id       uuid default null,
  p_reason         text default null,
  p_correlation_id text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_from    text;
begin
  select * into v_payment
    from public.payments
   where id = p_payment_id
     and deleted_at is null
   for update;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'PAYMENT_NOT_FOUND',
      detail  = json_build_object('payment_id', p_payment_id)::text;
  end if;

  v_from := v_payment.status;

  -- แยกเคส verified ออกมาให้ error สื่อความหมายตรง แทนที่จะบอกแค่ "transition ผิด"
  if v_from = 'verified' then
    raise exception using
      errcode = 'P0001', message = 'PAYMENT_ALREADY_VERIFIED',
      detail  = json_build_object(
        'payment_id', p_payment_id,
        'reason', 'ยอดที่ยืนยันแล้วแก้ไม่ได้ — ใช้ payment_adjustments แทน')::text;
  end if;

  if not public.is_valid_payment_transition(v_from, p_to_status) then
    raise exception using
      errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail  = json_build_object(
        'payment_id', p_payment_id, 'from_status', v_from, 'to_status', p_to_status)::text;
  end if;

  perform set_config('app.allow_transition', p_payment_id::text, true);

  update public.payments
     set status        = p_to_status,
         submitted_at  = case when p_to_status = 'submitted' then now() else submitted_at end,
         verified_at   = case when p_to_status = 'verified'  then now() else verified_at end,
         verified_by   = case when p_to_status = 'verified'  then p_actor_id else verified_by end,
         rejected_at   = case when p_to_status = 'rejected'  then now() else rejected_at end,
         reject_reason = case when p_to_status = 'rejected'  then p_reason else reject_reason end,
         updated_by    = coalesce(p_actor_id, updated_by)
   where id = p_payment_id
  returning * into v_payment;

  perform set_config('app.allow_transition', '', true);

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_payment.gang_id, 'payment.transitioned', 'payment', p_payment_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'from_status',    v_from,
       'to_status',      p_to_status,
       'reason',         p_reason
     ));

  return v_payment;
end;
$$;

comment on function public.transition_payment(uuid, text, uuid, text, text) is
  'ทางเดียวที่เปลี่ยน payments.status — ปิดช่องที่ค้างมาตั้งแต่ WO-1.3';


-- -----------------------------------------------------------------------------
-- create_payment_for_charges(...) — ออกใบจ่ายจาก charges ที่ยังไม่ได้จ่าย
-- -----------------------------------------------------------------------------
-- ยอดของ payment = ผลรวมของ charges ที่ระบุ ⇒ **คำนวณจากฐานข้อมูล ไม่เชื่อ client**
-- (ถ้ารับยอดจาก client จะจ่าย 1 บาทแล้วอ้างว่าครบได้)
--
-- ⚠️ ยังไม่ผูก payment กับ charge เป็นรายรายการ — `payment_allocations` เป็นงาน
--    Phase 2.5 (จ่ายแทนเพื่อน) MVP-0 จ่ายของตัวเองทั้งก้อน
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
  v_total   numeric(12, 2);
  v_count   integer;
  v_payment public.payments;
begin
  select coalesce(sum(amount), 0), count(*)
    into v_total, v_count
    from public.session_charges
   where id = any(p_charge_ids)
     and gang_id = p_gang_id;

  if v_count <> coalesce(array_length(p_charge_ids, 1), 0) then
    raise exception using
      errcode = 'P0001', message = 'CHARGE_NOT_FOUND',
      detail  = json_build_object('reason', 'มี charge ที่ไม่มีอยู่จริงหรือไม่ได้อยู่ในก๊วนนี้')::text;
  end if;

  if v_total <= 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ยอดที่ต้องจ่ายเป็น 0 — ไม่ต้องออกใบจ่าย')::text;
  end if;

  insert into public.payments (gang_id, payer_user_id, amount, created_by)
  values (p_gang_id, p_payer_user_id, v_total, p_actor_id)
  returning * into v_payment;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'payment.created', 'payment', v_payment.id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'amount',         v_total,
       'charge_count',   v_count
     ));

  return v_payment;
end;
$$;


revoke execute on function public.transition_payment(uuid, text, uuid, text, text)              from public, anon, authenticated;
revoke execute on function public.create_payment_for_charges(uuid, uuid, uuid[], uuid, text)    from public, anon, authenticated;

grant execute on function public.transition_payment(uuid, text, uuid, text, text)               to service_role;
grant execute on function public.create_payment_for_charges(uuid, uuid, uuid[], uuid, text)     to service_role;
grant execute on function public.is_valid_payment_transition(text, text)                        to anon, authenticated;
