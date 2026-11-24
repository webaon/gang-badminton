-- =============================================================================
-- 20260818000046 — WO-B5b-1 (N1): credit_ledger.seq — ลำดับรายการเครดิตที่ไม่ขึ้นกับนาฬิกา
-- =============================================================================
-- ปัญหา (QA ใบ 13 · N1): credit_ledger เรียงด้วย created_at (clock_timestamp()) ซึ่งไม่ตรงกับลำดับ
-- ที่ได้ล็อกแถวยอดจริงเสมอ (clock skew ระดับ µs ระหว่าง backend) ⇒ ประวัติเครดิตอาจโชว์
-- balance_after กระโดด · เงินไม่ผิด (cache = Σ ledger) แต่ลำดับแสดงผลเพี้ยน
--
-- แก้: ลำดับที่ "ต่อ (gang, user)" เป็นเลขนับจริงที่ออกใต้ FOR UPDATE ของแถว credit_balances
--   · credit_balances.last_seq  = ตัวนับ (เพิ่มทีละ 1 ในทรานแซกชันเดียวกับการเพิ่มแถว ledger)
--   · credit_ledger.seq         = ลำดับของรายการนี้ · UNIQUE (gang_id, user_id, seq)
--   ⇒ ไม่ซ้ำ (ล็อกเดียวกันออกเลข) และไม่ข้าม (ถ้า txn rollback ตัวนับก็ rollback ด้วย)
--   ⇒ balance_after ของ seq = n ต่อจาก seq = n−1 เสมอ
--
-- ที่เขียน credit_ledger ได้มีสองฟังก์ชัน (record_overpayment / apply_credit) ⇒ แก้สองตัวนี้ที่เดียว
-- · seq ไม่มี DEFAULT โดยตั้งใจ — ใครเขียนแถวใหม่โดยไม่ผ่านฟังก์ชันจะ INSERT ไม่ผ่าน (NOT NULL)
-- · ไม่แตะ type / constraint อื่น (ขยาย type และเพดานโอนเกินเป็นงาน B5b-1 ส่วนถัดไป รอคำตัดสิน)
--
-- Backfill: แถวเดิมเรียง (created_at, id) ต่อ (gang, user) · ตั้ง last_seq = จำนวนแถวของคนนั้น
--   ⚠️ แถวเก่าที่ created_at สลับกับลำดับล็อกจริง (อาการของ N1) จะได้ seq ตาม created_at ⇒ balance_after ของแถวเหล่านั้น
--      ยัง "กระโดด" ในลำดับ seq เหมือนเดิม — ledger แก้ไม่ได้ (append-only) · ข้อมูลหลัง migration นี้ถูกต้องเสมอ
--   · credit_ledger มี trigger กัน UPDATE ⇒ ปิด trigger เฉพาะช่วง backfill ใน migration นี้ แล้วเปิดคืนทันที
--     (migration รันเป็น owner ในทรานแซกชันเดียว — ไม่มีใครเห็นช่วงที่ trigger ปิด)
--
-- ROLLBACK:
--   re-apply record_overpayment / apply_credit จาก 20260818000044
--   ALTER TABLE public.credit_ledger DROP COLUMN seq;
--   ALTER TABLE public.credit_balances DROP COLUMN last_seq;
-- =============================================================================

alter table public.credit_balances
  add column last_seq bigint not null default 0 check (last_seq >= 0);

comment on column public.credit_balances.last_seq is
  '[N1] ตัวนับลำดับรายการเครดิตของ (gang,user) — เพิ่มใต้ FOR UPDATE ของแถวนี้ในทรานแซกชันเดียวกับการเพิ่มแถว credit_ledger';

alter table public.credit_ledger
  add column seq bigint;

alter table public.credit_ledger disable trigger credit_ledger_no_update_delete;

with numbered as (
  select id,
         row_number() over (partition by gang_id, user_id order by created_at, id) as rn
    from public.credit_ledger
)
update public.credit_ledger l
   set seq = n.rn
  from numbered n
 where n.id = l.id;

alter table public.credit_ledger enable trigger credit_ledger_no_update_delete;

update public.credit_balances b
   set last_seq = coalesce((
         select max(l.seq)
           from public.credit_ledger l
          where l.gang_id = b.gang_id
            and l.user_id = b.user_id
       ), 0);

alter table public.credit_ledger
  alter column seq set not null,
  add constraint credit_ledger_seq_positive check (seq > 0);

create unique index credit_ledger_member_seq_key
  on public.credit_ledger (gang_id, user_id, seq);

comment on column public.credit_ledger.seq is
  '[N1] ลำดับรายการต่อ (gang,user) เริ่ม 1 ไม่ซ้ำไม่ข้าม — ใช้เรียงประวัติแทน created_at';


-- =============================================================================
-- record_overpayment / apply_credit — เหมือน 0044 ทุกบรรทัด ยกเว้นการออก seq
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
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
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
      (v_payment.gang_id, v_payment.payer_user_id, v_seq + 1, 'overpayment', p_amount,
       v_balance + p_amount, p_payment_id, v_reason, p_actor_id)
    returning * into v_row;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001', message = 'VALIDATION_ERROR',
        detail  = json_build_object('reason', 'สลิปนี้บันทึกยอดโอนเกินไปแล้ว', 'payment_id', p_payment_id)::text;
  end;

  update public.credit_balances
     set balance = v_balance + p_amount,
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
       'amount',         p_amount,
       'balance_after',  v_balance + p_amount
     ));

  return v_row;
end;
$$;

comment on function public.record_overpayment(uuid, numeric, text, uuid, text) is
  '[ADR-010] โอนเกิน (แอดมินยืนยัน) → เครดิตเข้าให้ payer · สลิปต้อง verified · หนึ่งสลิปครั้งเดียว · FOR UPDATE credit_balances';


create or replace function public.apply_credit(
  p_gang_id        uuid,
  p_user_id        uuid,
  p_charge_ids     uuid[] default null,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance   numeric(12, 2);
  v_seq       bigint;
  v_remaining numeric(12, 2);
  v_total     numeric(12, 2) := 0;
  v_ids       uuid[] := '{}';
  v_takes     numeric(12, 2)[] := '{}';
  v_owned     integer;
  v_wanted    integer;
  v_c         record;
  v_out       numeric(12, 2);
  v_take      numeric(12, 2);
  v_payment   public.payments;
  i           integer;
begin
  if p_gang_id is null or p_user_id is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'ต้องระบุก๊วนและสมาชิก')::text;
  end if;

  -- charge ที่ระบุมาต้องเป็นของ user นี้ในก๊วนนี้จริง
  if p_charge_ids is not null then
    select count(distinct id) into v_wanted from unnest(p_charge_ids) as t(id);

    select count(*) into v_owned
      from public.session_charges c
      left join public.session_registrations r on r.id = c.registration_id
      left join public.gang_members gm         on gm.id = c.gang_member_id
     where c.id = any(p_charge_ids)
       and c.gang_id = p_gang_id
       and coalesce(r.user_id, gm.user_id) = p_user_id;

    if v_owned <> v_wanted then
      raise exception using
        errcode = 'P0001', message = 'CHARGE_NOT_FOUND',
        detail  = json_build_object('reason', 'มี charge ที่ไม่ใช่ของสมาชิกนี้หรือไม่ได้อยู่ในก๊วนนี้')::text;
    end if;
  end if;

  -- 🔴 ล็อกแถวยอดก่อนอ่านยอด — ไม่มีแถว = ไม่มีเครดิต
  select balance, last_seq into v_balance, v_seq
    from public.credit_balances
   where gang_id = p_gang_id
     and user_id = p_user_id
     for update;

  if not found or v_balance <= 0 then
    return jsonb_build_object(
      'applied', '0.00', 'remaining', coalesce(v_balance, 0)::text,
      'payment_id', null, 'charge_count', 0);
  end if;

  v_remaining := v_balance;

  for v_c in
    select c.id
      from public.session_charges c
      left join public.session_registrations r on r.id = c.registration_id
      left join public.gang_members gm         on gm.id = c.gang_member_id
     where c.gang_id = p_gang_id
       and coalesce(r.user_id, gm.user_id) = p_user_id
       and (p_charge_ids is null or c.id = any(p_charge_ids))
     order by c.id
  loop
    exit when v_remaining <= 0;

    v_out := public.charge_outstanding(v_c.id);
    continue when v_out is null or v_out <= 0;

    v_take := least(v_out, v_remaining);
    v_ids   := v_ids || v_c.id;
    v_takes := v_takes || v_take;
    v_total := v_total + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  if v_total <= 0 then
    return jsonb_build_object(
      'applied', '0.00', 'remaining', v_balance::text,
      'payment_id', null, 'charge_count', 0);
  end if;

  -- payment ของการใช้เครดิต: สร้างเป็น pending แล้วเดินผ่าน transition_payment() เดิม → verified
  insert into public.payments (gang_id, payer_user_id, amount, created_by)
  values (p_gang_id, p_user_id, v_total, p_actor_id)
  returning * into v_payment;

  for i in 1 .. array_length(v_ids, 1) loop
    insert into public.payment_allocations
      (payment_id, session_charge_id, amount, source, created_by)
    values
      (v_payment.id, v_ids[i], v_takes[i], 'credit', p_actor_id);
  end loop;

  perform public.transition_payment(v_payment.id, 'submitted', p_actor_id, null, p_correlation_id);
  perform public.transition_payment(v_payment.id, 'verified',  p_actor_id, null, p_correlation_id);

  insert into public.credit_ledger
    (gang_id, user_id, seq, type, amount, balance_after, payment_id, reason, created_by)
  values
    (p_gang_id, p_user_id, v_seq + 1, 'applied', -v_total, v_balance - v_total, v_payment.id,
     case when p_actor_id is null then 'หักอัตโนมัติเมื่อมีหนี้ใหม่' else 'ใช้เครดิตจ่ายหนี้' end,
     p_actor_id);

  update public.credit_balances
     set balance = v_balance - v_total,
         last_seq = v_seq + 1
   where gang_id = p_gang_id
     and user_id = p_user_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'audit.credit_applied', 'payment', v_payment.id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'user_id',        p_user_id,
       'applied',        v_total,
       'balance_after',  v_balance - v_total,
       'charge_count',   array_length(v_ids, 1),
       'auto',           p_actor_id is null
     ));

  return jsonb_build_object(
    'applied',      v_total::text,
    'remaining',    (v_balance - v_total)::text,
    'payment_id',   v_payment.id,
    'charge_count', array_length(v_ids, 1));
end;
$$;

comment on function public.apply_credit(uuid, uuid, uuid[], uuid, text) is
  '[ADR-010] ทางเดียวที่ใช้เครดิต: FOR UPDATE credit_balances → payment(verified) + payment_allocations source=credit + ledger. ไม่เกินหนี้ ไม่เกินเครดิต';

