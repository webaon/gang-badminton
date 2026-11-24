-- =============================================================================
-- 20260818000044 — WO-B5a · ADR-010: เครดิตสมาชิก (credit_ledger + apply_credit + หักอัตโนมัติ)
-- =============================================================================
-- เครดิต = เงินที่ก๊วนติดสมาชิก (เช่นโอนเกิน) ที่ถูกหักกับหนี้ใหม่ของคนเดียวกันได้เอง
--
-- ชิ้นส่วน
--   1. payment_allocations.source ('transfer' | 'credit')       — แถวเดิมทั้งหมดเป็น transfer
--   2. credit_ledger     append-only ต่อ (gang, user) · balance_after ≥ 0 · ห้ามแก้/ลบ/truncate
--   3. credit_balances   cache ยอดคงเหลือ = จุด FOR UPDATE (Σ ledger คือความจริง)
--   4. record_overpayment()  ช่องทางเข้า: โอนเกิน (แอดมินยืนยัน) — หนึ่งสลิปบันทึกได้ครั้งเดียว
--   5. apply_credit()        ทางเดียวที่ใช้เครดิต → payment(verified) + allocation source='credit'
--   6. trigger หักอัตโนมัติ  AFTER INSERT statement บน session_charges (ครอบ close_session_with_charges
--                            และ commit_monthly_fees โดยไม่แก้สองฟังก์ชันนั้น — ADR-001 คงเดิม)
--
-- 🔴 charge_outstanding() ไม่ถูกแก้: allocation source='credit' ผูก payment verified จึงหักยอดค้าง
--    เหมือนเงินโอน ⇒ ledger ยอดค้างเดิมยังเป็นความจริงเดียว
-- 🔴 รายงาน "เก็บได้จริง" ต้องนับเฉพาะ allocation source='transfer' (งานฝั่งหน้าจอ — ดู ADR-010)
-- 🔴 ล็อกตามลำดับ: credit_balances ทีละคนเรียง user_id · ไม่ล็อก session/charge ที่อื่นต่อ ⇒ ไม่ deadlock
--
-- ROLLBACK:
--   DROP TRIGGER session_charges_auto_credit ON public.session_charges;
--   DROP FUNCTION public.session_charges_auto_apply_credit();
--   DROP FUNCTION public.apply_credit(uuid, uuid, uuid[], uuid, text);
--   DROP FUNCTION public.record_overpayment(uuid, numeric, text, uuid, text);
--   DROP FUNCTION public.credit_balance_of(uuid, uuid);
--   DROP TABLE public.credit_ledger, public.credit_balances;
--   DROP FUNCTION public.credit_ledger_forbid_change();
--   ALTER TABLE public.payment_allocations DROP COLUMN source;   -- ก่อนอื่นต้องไม่มีแถว source='credit'
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. payment_allocations.source
-- -----------------------------------------------------------------------------
alter table public.payment_allocations
  add column source text not null default 'transfer'
  check (source in ('transfer', 'credit'));

comment on column public.payment_allocations.source is
  '[ADR-010] transfer = เงินโอน/สลิป · credit = หักจากเครดิตสมาชิก — "เก็บได้จริง" นับเฉพาะ transfer';


-- -----------------------------------------------------------------------------
-- 2. credit_balances — cache ยอดคงเหลือ + จุดล็อก
-- -----------------------------------------------------------------------------
create table public.credit_balances (
  gang_id    uuid           not null references public.gangs (id)    on delete restrict,
  user_id    uuid           not null references public.profiles (id) on delete restrict,
  balance    numeric(12, 2) not null default 0 check (balance >= 0),
  created_at timestamptz    not null default now(),
  updated_at timestamptz    not null default now(),
  primary key (gang_id, user_id)
);

comment on table public.credit_balances is
  '[ADR-010] cache ยอดเครดิต + จุด FOR UPDATE ของ apply_credit/record_overpayment — ความจริงคือ Σ credit_ledger.amount (credit_balance_of())';

create trigger credit_balances_set_updated_at
  before update on public.credit_balances
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. credit_ledger — append-only
-- -----------------------------------------------------------------------------
create table public.credit_ledger (
  id            uuid           primary key default public.uuid_generate_v7(),
  gang_id       uuid           not null references public.gangs (id)    on delete restrict,
  user_id       uuid           not null references public.profiles (id) on delete restrict,

  -- B5a: overpayment (เข้า) · applied (ออก: ใช้จ่ายหนี้) — B5b เพิ่ม type ด้วย migration ใหม่
  type          text           not null check (type in ('overpayment', 'applied')),
  -- บวก = เข้า / ลบ = ออก
  amount        numeric(12, 2) not null check (amount <> 0),
  -- ยอดคงเหลือหลังรายการนี้ — CHECK ≥ 0 ⇒ เครดิตติดลบไม่ได้ในระดับ schema
  balance_after numeric(12, 2) not null check (balance_after >= 0),

  -- overpayment → สลิปที่โอนเกิน · applied → payment(source credit) ที่ใช้เครดิตจ่าย
  payment_id    uuid           references public.payments (id) on delete restrict,
  reason        text,

  -- clock_timestamp() (ไม่ใช่ now()) ⇒ เรียงตามลำดับที่ได้ล็อกแถวยอดจริง ไม่ใช่เวลาเริ่ม transaction
  created_at    timestamptz    not null default clock_timestamp(),
  created_by    uuid           references public.profiles (id),

  constraint credit_ledger_sign_matches_type check (
    (type = 'overpayment' and amount > 0)
    or (type = 'applied' and amount < 0)
  ),
  constraint credit_ledger_payment_required check (payment_id is not null),
  constraint credit_ledger_overpayment_reason check (
    type <> 'overpayment' or btrim(coalesce(reason, '')) <> ''
  )
);

comment on table public.credit_ledger is
  '[ADR-010] append-only — เครดิตสมาชิกต่อ (gang, user). ห้าม UPDATE/DELETE/TRUNCATE. ยอดคงเหลือ = Σ amount';

create index credit_ledger_member_idx  on public.credit_ledger (gang_id, user_id, created_at);
create index credit_ledger_payment_idx on public.credit_ledger (payment_id);

-- 🔴 กดบันทึกส่วนเกินของสลิปเดียวซ้ำ/พร้อมกัน ⇒ เครดิตต้องไม่เบิ้ล
create unique index credit_ledger_overpayment_once
  on public.credit_ledger (payment_id)
  where type = 'overpayment';

create or replace function public.credit_ledger_forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'FORBIDDEN',
    detail  = json_build_object('reason', 'credit_ledger เป็น append-only — แก้/ลบ/ล้างไม่ได้')::text;
end;
$$;

create trigger credit_ledger_no_update_delete
  before update or delete on public.credit_ledger
  for each row execute function public.credit_ledger_forbid_change();

create trigger credit_ledger_no_truncate
  before truncate on public.credit_ledger
  for each statement execute function public.credit_ledger_forbid_change();


-- -----------------------------------------------------------------------------
-- RLS + grants — สมาชิกเห็นของตัวเอง · แอดมินเห็นทั้งก๊วน · เขียนตรงไม่ได้ทุก role
-- -----------------------------------------------------------------------------
alter table public.credit_ledger   enable row level security;
alter table public.credit_balances enable row level security;

revoke all on public.credit_ledger   from public, anon, authenticated;
revoke all on public.credit_balances from public, anon, authenticated;
grant select on public.credit_ledger   to authenticated;
grant select on public.credit_balances to authenticated;
-- service_role อ่านได้ (server action/รายงาน) แต่ไม่ให้เขียนตรง — เขียนผ่าน DB function (security definer) เท่านั้น
revoke all on public.credit_ledger   from service_role;
revoke all on public.credit_balances from service_role;
grant select on public.credit_ledger   to service_role;
grant select on public.credit_balances to service_role;

create policy credit_ledger_select on public.credit_ledger
  for select to authenticated
  using (
    (select public.is_gang_admin(gang_id))
    or (
      user_id = (select auth.uid())
      and (select public.is_gang_member(gang_id))
    )
  );

create policy credit_balances_select on public.credit_balances
  for select to authenticated
  using (
    (select public.is_gang_admin(gang_id))
    or (
      user_id = (select auth.uid())
      and (select public.is_gang_member(gang_id))
    )
  );

comment on policy credit_ledger_select on public.credit_ledger is
  '[ADR-010] แอดมินเห็นทั้งก๊วน · สมาชิกเห็นเฉพาะของตัวเอง (ออกจากก๊วนแล้วอ่านไม่ได้ เหมือน session_charges)';
comment on policy credit_balances_select on public.credit_balances is
  '[ADR-010] เหมือน credit_ledger_select';


-- -----------------------------------------------------------------------------
-- credit_balance_of(gang, user) — ยอดคงเหลือที่ derive จาก Σ ledger (ความจริง)
-- -----------------------------------------------------------------------------
create or replace function public.credit_balance_of(p_gang_id uuid, p_user_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(amount), 0)::numeric(12, 2)
    from public.credit_ledger
   where gang_id = p_gang_id
     and user_id = p_user_id;
$$;

comment on function public.credit_balance_of(uuid, uuid) is
  '[ADR-010] ยอดเครดิต = Σ credit_ledger.amount — credit_balances เป็นแค่ cache ที่ต้องเท่ากับค่านี้เสมอ';


-- -----------------------------------------------------------------------------
-- record_overpayment(payment_id, amount, reason, actor, correlation) — โอนเกิน (แอดมินยืนยัน)
-- -----------------------------------------------------------------------------
-- เครดิตเข้าให้ payer ของสลิป · สลิปต้อง verified แล้ว · หนึ่งสลิปบันทึกได้ครั้งเดียว
-- ตรวจสิทธิ์แอดมินใน DB (actor_is_gang_admin) เพราะ can() อยู่ฝั่ง TS อย่างเดียวไม่พอ
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

  select balance into v_balance
    from public.credit_balances
   where gang_id = v_payment.gang_id
     and user_id = v_payment.payer_user_id
     for update;

  begin
    insert into public.credit_ledger
      (gang_id, user_id, type, amount, balance_after, payment_id, reason, created_by)
    values
      (v_payment.gang_id, v_payment.payer_user_id, 'overpayment', p_amount,
       v_balance + p_amount, p_payment_id, v_reason, p_actor_id)
    returning * into v_row;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001', message = 'VALIDATION_ERROR',
        detail  = json_build_object('reason', 'สลิปนี้บันทึกยอดโอนเกินไปแล้ว', 'payment_id', p_payment_id)::text;
  end;

  update public.credit_balances
     set balance = v_balance + p_amount
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


-- -----------------------------------------------------------------------------
-- apply_credit(gang, user, charge_ids?, actor, correlation) — ทางเดียวที่ใช้เครดิต
-- -----------------------------------------------------------------------------
-- p_charge_ids = null ⇒ ทุก charge ของ user ที่ยังค้าง เรียงเก่า→ใหม่
-- take = least(ยอดค้างจริง, เครดิตที่เหลือ) ต่อ charge ⇒ ไม่เกินหนี้ ไม่เกินเครดิต
-- ใช้กับ charge ของ user เองเท่านั้น (ไม่จ่ายแทนเพื่อนด้วยเครดิต)
-- คืน jsonb (เงินเป็น string ตรง numeric(12,2))
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
  select balance into v_balance
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
    (gang_id, user_id, type, amount, balance_after, payment_id, reason, created_by)
  values
    (p_gang_id, p_user_id, 'applied', -v_total, v_balance - v_total, v_payment.id,
     case when p_actor_id is null then 'หักอัตโนมัติเมื่อมีหนี้ใหม่' else 'ใช้เครดิตจ่ายหนี้' end,
     p_actor_id);

  update public.credit_balances
     set balance = v_balance - v_total
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


-- -----------------------------------------------------------------------------
-- หักอัตโนมัติ — AFTER INSERT statement บน session_charges
-- -----------------------------------------------------------------------------
-- ครอบทุกทางที่สร้างหนี้ (close_session_with_charges / commit_monthly_fees) โดยไม่แก้สองฟังก์ชันนั้น
-- หักเฉพาะ charge ที่เพิ่งเกิดในคำสั่งนั้น · เรียงตาม user_id (ลำดับล็อกคงที่ ไม่ deadlock)
-- guest (ไม่มี user) ถูกข้าม · คนที่ไม่มีเครดิตไม่ถูกล็อกเลย
create or replace function public.session_charges_auto_apply_credit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select n.gang_id,
           u.user_id,
           array_agg(n.id order by n.id) as charge_ids
      from new_charges n
      left join public.session_registrations r on r.id = n.registration_id
      left join public.gang_members gm         on gm.id = n.gang_member_id
      cross join lateral (select coalesce(r.user_id, gm.user_id) as user_id) u
     where u.user_id is not null
       and exists (
         select 1 from public.credit_balances b
          where b.gang_id = n.gang_id
            and b.user_id = u.user_id
            and b.balance > 0
       )
     group by n.gang_id, u.user_id
     order by u.user_id, n.gang_id
  loop
    perform public.apply_credit(v_row.gang_id, v_row.user_id, v_row.charge_ids, null, null);
  end loop;

  return null;
end;
$$;

comment on function public.session_charges_auto_apply_credit() is
  '[ADR-010] หักเครดิตอัตโนมัติกับ charge ที่เพิ่งเกิด — ไม่แก้ close_session_with_charges/commit_monthly_fees (ADR-001)';

create trigger session_charges_auto_credit
  after insert on public.session_charges
  referencing new table as new_charges
  for each statement
  execute function public.session_charges_auto_apply_credit();


-- -----------------------------------------------------------------------------
-- EXECUTE — service_role เท่านั้น
-- -----------------------------------------------------------------------------
revoke execute on function public.credit_balance_of(uuid, uuid)                           from public, anon, authenticated;
revoke execute on function public.record_overpayment(uuid, numeric, text, uuid, text)     from public, anon, authenticated;
revoke execute on function public.apply_credit(uuid, uuid, uuid[], uuid, text)            from public, anon, authenticated;
revoke execute on function public.session_charges_auto_apply_credit()                     from public, anon, authenticated;
revoke execute on function public.credit_ledger_forbid_change()                           from public, anon, authenticated;

grant execute on function public.credit_balance_of(uuid, uuid)                            to service_role;
grant execute on function public.record_overpayment(uuid, numeric, text, uuid, text)      to service_role;
grant execute on function public.apply_credit(uuid, uuid, uuid[], uuid, text)             to service_role;
