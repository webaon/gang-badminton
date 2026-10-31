-- =============================================================================
-- 20260818000047 — WO-B5b-1: type ใหม่ของ credit_ledger + Q1 payments.received_amount (N2 เพดานโอนเกิน)
-- =============================================================================
-- คำตัดสินเจ้าของงาน (29 ต.ค.): Q1 ก — แอดมินกรอก `received_amount` ตอนยืนยันสลิป ·
--   overpayment = received − amount คำนวณใน DB · record_overpayment ปฏิเสธเกิน/ไม่มี received_amount
--
-- 1. payments.received_amount (nullable) — ยอดที่โอนเข้าจริงตามสลิป (แอดมินกรอก)
--      · เขียนได้ทางเดียว: set_payment_received_amount() (GUC one-shot ต่อแถว + trigger กัน) ⇒
--        สมาชิกที่แก้ payments ของตัวเองผ่าน RLS/PostgREST ตั้งค่านี้เองไม่ได้
--      · กรอกได้เมื่อสลิป submitted/verified · แก้ได้จนกว่าจะมีการบันทึกโอนเกินจากสลิปนี้
-- 2. credit_ledger เพิ่ม type สำหรับ B5b-2: admin_topup · cash_payout · charge_return (ยังไม่มีฟังก์ชันที่เขียน)
--      · payment_id บังคับเฉพาะ overpayment/applied · charge_id บังคับเฉพาะ charge_return · เหตุผลบังคับทุก type ยกเว้น applied
-- 3. record_overpayment(): ยอดคำนวณใน DB = received_amount − amount
--      · p_amount = null ⇒ ใช้ยอดที่คำนวณ · p_amount ที่ส่งมาต้อง "เท่ากับ" ยอดที่คำนวณ (มากกว่า = เกิน ⇒ ปฏิเสธ ·
--        น้อยกว่า = ส่วนที่เหลือจะหลุดเพราะสลิปบันทึกได้ครั้งเดียว ⇒ ปฏิเสธ)
--      · ไม่มี received_amount หรือ received ≤ amount ⇒ ปฏิเสธ
--      · signature เดิม (uuid, numeric, text, uuid, text) ⇒ EXECUTE matrix ไม่เปลี่ยน · ส่วนอื่นเหมือน 0046
--
-- ⚠️ B5a เดิม (แอดมินพิมพ์ยอดเองโดยไม่มีหลักฐาน) ใช้ไม่ได้อีก: ต้องกรอก received_amount ก่อนเสมอ (ตั้งใจ — N2)
--
-- ROLLBACK:
--   re-apply record_overpayment จาก 20260818000046 · ลบ constraint ใหม่ของ credit_ledger แล้วคืน 4 constraint จาก 0044
--   DROP TRIGGER payments_guard_received_amount; DROP FUNCTION set_payment_received_amount;
--   ALTER TABLE payments DROP COLUMN received_amount; ALTER TABLE credit_ledger DROP COLUMN charge_id;
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. payments.received_amount + guard
-- -----------------------------------------------------------------------------
alter table public.payments
  add column received_amount numeric(12, 2)
    constraint payments_received_amount_positive check (received_amount is null or received_amount > 0);

comment on column public.payments.received_amount is
  '[ADR-010 · Q1] ยอดที่โอนเข้าจริงตามสลิป (แอดมินกรอก) — ใช้คำนวณโอนเกิน = received − amount · เขียนผ่าน set_payment_received_amount() เท่านั้น';

create or replace function public.guard_payment_received_amount()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.received_amount is not null then
      raise exception using
        errcode = 'P0001', message = 'FORBIDDEN',
        detail  = json_build_object('reason', 'ตั้ง received_amount ตอนสร้างสลิปไม่ได้')::text;
    end if;
    return new;
  end if;

  if new.received_amount is distinct from old.received_amount
     and coalesce(current_setting('app.allow_received_amount', true), '') <> new.id::text then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'received_amount แก้ได้ผ่าน set_payment_received_amount() เท่านั้น')::text;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_payment_received_amount() from public, anon, authenticated, service_role;

create trigger payments_guard_received_amount
  before insert or update on public.payments
  for each row execute function public.guard_payment_received_amount();


create or replace function public.set_payment_received_amount(
  p_payment_id     uuid,
  p_received       numeric,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  if p_received is null or p_received <= 0 or p_received <> round(p_received, 2) then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'received_amount', 'reason', 'ต้องเป็นยอดบวก ทศนิยมไม่เกิน 2 ตำแหน่ง')::text;
  end if;

  -- FOR UPDATE: เรียงคิวกับ record_overpayment (FOR SHARE บนแถวเดียวกัน) และ transition_payment
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

  if not public.actor_is_gang_admin(v_payment.gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่กรอกยอดที่โอนจริงได้')::text;
  end if;

  if v_payment.status not in ('submitted', 'verified') then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'กรอกยอดที่โอนจริงได้เฉพาะสลิปที่ส่งแล้วหรือยืนยันแล้ว', 'status', v_payment.status)::text;
  end if;

  -- บันทึกโอนเกินจากสลิปนี้แล้ว = ยอดเครดิตผูกกับ received เดิม ⇒ ห้ามแก้ (ledger เป็น append-only)
  if exists (
    select 1 from public.credit_ledger l
     where l.payment_id = p_payment_id and l.type = 'overpayment'
  ) then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'สลิปนี้บันทึกยอดโอนเกินเป็นเครดิตไปแล้ว แก้ยอดที่โอนจริงไม่ได้', 'payment_id', p_payment_id)::text;
  end if;

  perform set_config('app.allow_received_amount', p_payment_id::text, true);
  update public.payments
     set received_amount = p_received,
         updated_by      = p_actor_id
   where id = p_payment_id
  returning * into v_payment;
  perform set_config('app.allow_received_amount', '', true);

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_payment.gang_id, 'audit.payment_received_amount_set', 'payment', p_payment_id, p_actor_id,
     jsonb_build_object(
       'correlation_id',  p_correlation_id,
       'amount',          v_payment.amount,
       'received_amount', p_received
     ));

  return v_payment;
end;
$$;

comment on function public.set_payment_received_amount(uuid, numeric, uuid, text) is
  '[ADR-010 · Q1] แอดมินกรอกยอดที่โอนจริง (สลิป submitted/verified) · แก้ได้จนกว่าจะบันทึกโอนเกินเป็นเครดิต · FOR UPDATE payments';

revoke all on function public.set_payment_received_amount(uuid, numeric, uuid, text) from public, anon, authenticated;
grant execute on function public.set_payment_received_amount(uuid, numeric, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- 2. credit_ledger — type ใหม่ + charge_id + constraint ใหม่
-- -----------------------------------------------------------------------------
alter table public.credit_ledger
  add column charge_id uuid references public.session_charges (id) on delete restrict;

comment on column public.credit_ledger.charge_id is
  '[B5b] charge ที่ถูกคืนเข้าเครดิต (เฉพาะ type = charge_return)';

create index credit_ledger_charge_idx on public.credit_ledger (charge_id) where charge_id is not null;

alter table public.credit_ledger
  drop constraint credit_ledger_type_check,
  drop constraint credit_ledger_sign_matches_type,
  drop constraint credit_ledger_payment_required,
  drop constraint credit_ledger_overpayment_reason;

alter table public.credit_ledger
  add constraint credit_ledger_type_check check (
    type in ('overpayment', 'applied', 'admin_topup', 'cash_payout', 'charge_return')
  ),
  -- เข้า (บวก): overpayment · admin_topup · charge_return / ออก (ลบ): applied · cash_payout
  add constraint credit_ledger_sign_matches_type check (
    (type in ('overpayment', 'admin_topup', 'charge_return') and amount > 0)
    or (type in ('applied', 'cash_payout') and amount < 0)
  ),
  -- สลิปบังคับเฉพาะรายการที่เกิดจากสลิป · type อื่นห้ามอ้างสลิป (กันแถวที่อ้างผิดที่)
  add constraint credit_ledger_payment_required check (
    (type in ('overpayment', 'applied')) = (payment_id is not null)
  ),
  add constraint credit_ledger_charge_required check (
    (type = 'charge_return') = (charge_id is not null)
  ),
  -- เหตุผลบังคับทุก type ยกเว้น applied (หักอัตโนมัติมีข้อความระบบอยู่แล้ว)
  add constraint credit_ledger_reason_required check (
    type = 'applied' or btrim(coalesce(reason, '')) <> ''
  );


-- =============================================================================
-- 3. record_overpayment — ยอดคำนวณใน DB จาก received_amount (ที่เหลือเหมือน 0046)
-- =============================================================================
create or replace function public.record_overpayment(
  p_payment_id     uuid,
  p_amount         numeric,
  p_reason         text,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.credit_ledger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_balance numeric(12, 2);
  v_seq     bigint;
  v_row     public.credit_ledger;
  v_amount  numeric(12, 2);
begin
  if p_amount is not null and (p_amount <= 0 or p_amount <> round(p_amount, 2)) then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'amount', 'reason', 'ต้องเป็นยอดบวก ทศนิยมไม่เกิน 2 ตำแหน่ง')::text;
  end if;

  if v_reason is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'reason', 'reason', 'ต้องระบุเหตุผล')::text;
  end if;

  select * into v_payment
    from public.payments
   where id = p_payment_id
     and deleted_at is null
     for share;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'PAYMENT_NOT_FOUND',
      detail  = json_build_object('payment_id', p_payment_id)::text;
  end if;

  if not public.actor_is_gang_admin(v_payment.gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่บันทึกยอดโอนเกินได้')::text;
  end if;

  if v_payment.status <> 'verified' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'บันทึกยอดโอนเกินได้เฉพาะสลิปที่ยืนยันแล้ว', 'status', v_payment.status)::text;
  end if;

  -- 🔴 [N2] ยอดโอนเกินคำนวณใน DB จากยอดที่โอนจริง (แอดมินกรอก) — ไม่เชื่อตัวเลขที่ผู้เรียกพิมพ์มา
  -- (for share ของ payments ข้างบนเรียงคิวกับ set_payment_received_amount ที่ for update ⇒ อ่านค่าสุดท้ายเสมอ)
  if v_payment.received_amount is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'received_amount', 'reason', 'ต้องกรอกยอดที่โอนจริงของสลิปนี้ก่อน', 'payment_id', p_payment_id)::text;
  end if;

  v_amount := v_payment.received_amount - v_payment.amount;

  if v_amount <= 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'amount', 'reason', 'ยอดที่โอนจริงไม่เกินยอดสลิป ไม่มีส่วนเกินให้เป็นเครดิต',
                                  'amount', v_payment.amount, 'received_amount', v_payment.received_amount)::text;
  end if;

  if p_amount is not null and p_amount <> v_amount then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'amount', 'reason', 'ต้องเท่ากับยอดโอนเกินจริง (ยอดที่โอน − ยอดสลิป)',
                                  'expected', v_amount, 'given', p_amount)::text;
  end if;

  if v_payment.payer_user_id is null
     or not exists (
       select 1 from public.gang_members gm
        where gm.gang_id = v_payment.gang_id
          and gm.user_id = v_payment.payer_user_id
          and gm.deleted_at is null
     ) then
    raise exception using
      errcode = 'P0001', message = 'NOT_GANG_MEMBER',
      detail  = json_build_object('reason', 'ผู้โอนไม่ได้เป็นสมาชิกก๊วนนี้แล้ว')::text;
  end if;

  -- 🔴 ล็อกแถวยอด (สร้างถ้ายังไม่มี) ก่อนเขียน ledger
  insert into public.credit_balances (gang_id, user_id)
  values (v_payment.gang_id, v_payment.payer_user_id)
  on conflict (gang_id, user_id) do nothing;

  select balance, last_seq into v_balance, v_seq
    from public.credit_balances
   where gang_id = v_payment.gang_id
     and user_id = v_payment.payer_user_id
     for update;

  begin
    insert into public.credit_ledger
      (gang_id, user_id, seq, type, amount, balance_after, payment_id, reason, created_by)
    values
      (v_payment.gang_id, v_payment.payer_user_id, v_seq + 1, 'overpayment', v_amount,
       v_balance + v_amount, p_payment_id, v_reason, p_actor_id)
    returning * into v_row;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001', message = 'VALIDATION_ERROR',
        detail  = json_build_object('reason', 'สลิปนี้บันทึกยอดโอนเกินไปแล้ว', 'payment_id', p_payment_id)::text;
  end;

  update public.credit_balances
     set balance = v_balance + v_amount,
         last_seq = v_seq + 1
   where gang_id = v_payment.gang_id
     and user_id = v_payment.payer_user_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_payment.gang_id, 'audit.credit_overpayment_recorded', 'payment', p_payment_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'user_id',        v_payment.payer_user_id,
       'amount',         v_amount,
       'balance_after',  v_balance + v_amount
     ));

  return v_row;
end;
$$;

comment on function public.record_overpayment(uuid, numeric, text, uuid, text) is
  '[ADR-010] โอนเกิน (แอดมินยืนยัน) → เครดิตเข้าให้ payer · สลิปต้อง verified · หนึ่งสลิปครั้งเดียว · FOR UPDATE credit_balances';
