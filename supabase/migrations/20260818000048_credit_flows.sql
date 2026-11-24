-- =============================================================================
-- 20260818000048 — WO-B5b-2: ช่องเข้า/ออกของเครดิต (topup · cash_payout · charge_return) + refund cap
-- =============================================================================
-- คำตัดสินเจ้าของงาน (29 ต.ค.): Q2 ก · Q3 ก · Q4 ก (ส่วนรายงานอยู่ใน domain/reports/finance.ts)
--
-- ฟังก์ชันใหม่ (SECURITY DEFINER · EXECUTE เฉพาะ service_role · ตรวจแอดมินใน DB ด้วย actor_is_gang_admin):
--   credit_topup(gang, user, amount, reason, actor, cid)         Q3: "ให้เครดิต" admin_topup (+) · ไม่ใช่เงินสดเข้า
--   credit_cash_payout(gang, user, amount, reason, actor, cid)   cash_payout (−) ≤ ยอดคงเหลือ · เกิน ⇒ INSUFFICIENT_CREDIT
--   credit_return_charge(charge, amount, reason, actor, cid)     Q2: ย้ายยอด "ต้องคืน" ของ charge → เครดิต (charge_return +)
--
-- credit_return_charge ทำงานเป็นขั้นที่ 2 ของ "คืน charge ที่จ่ายแล้ว":
--     ขั้น 1 (แอดมิน · add_payment_adjustment type credit ติดลบ) ยกเลิก/ลดหนี้ ⇒ outstanding ติดลบ = "ก๊วนต้องคืนสมาชิก"
--     ขั้น 2 (ฟังก์ชันนี้) ย้ายยอดต้องคืนนั้นเข้าเครดิต: เขียน payment_adjustments type `credit_return` (+X) ⇒
--             outstanding กลับเป็น 0 + ledger charge_return (+X) ⇒ ไม่ซ้ำซ้อน (ต้องคืนไม่ค้างคู่กับเครดิต)
--   · ครอบทุกกรณีของ Q2: คิดผิด · ยกเลิกทีหลัง · ค่ารายเดือน · charge ที่จ่ายด้วยเครดิต (เงินกลับเข้าเครดิตไม่ใช่เงินสด)
--   · เพดาน X ≤ min(ยอดต้องคืน = −outstanding, เงินที่ charge นี้ได้รับจริงและยังไม่ถูกจ่ายออก)
--       เงินที่ได้รับจริง = Σ allocation(verified, ทุก source) − refund เงินสด − credit_return ที่ย้ายไปแล้ว
--     ⇒ ปรับยอดลดหนี้เกินหนี้ (discount) แล้วมาขอ "คืนเข้าเครดิต" ไม่ได้ (ไม่สร้างเครดิตจากอากาศ)
--   · เรียกซ้ำ/พร้อมกัน ⇒ ครั้งที่สองเห็นยอดต้องคืนเหลือ 0 ⇒ ปฏิเสธ (เครดิตไม่เบิ้ล)
--
-- 🔴 ลำดับล็อก (กัน deadlock กับ apply_credit / trigger หักอัตโนมัติ ซึ่งล็อก credit_balances ก่อนแล้วค่อยแตะ charge):
--     credit_balances (FOR UPDATE) → session_charges (FOR UPDATE)
--   add_payment_adjustment ล็อกเฉพาะ charge ⇒ ไม่เกิดวงจร
--
-- แก้ add_payment_adjustment (signature เดิม):
--   · ล็อก charge FOR UPDATE ก่อนคำนวณ (เรียงคิวกับ credit_return_charge / การปรับยอดซ้อน)
--   · 🔴 เพดาน refund (คืนเงินสด) นับเฉพาะ allocation source = 'transfer' และหัก credit_return ที่ย้ายเข้าเครดิตแล้ว
--     (ADR-010: ส่วนที่จ่ายด้วยเครดิตคืนได้ทางเดียวคือเข้าเครดิต · กันจ่ายซ้ำสองทาง เงินสด + เครดิต)
--     ⚠️ ระมัดระวังฝั่งปลอดภัย: ถ้า charge ถูกจ่ายผสม (โอน+เครดิต) แล้ว credit_return ไปแล้ว เพดานเงินสดลดลงเท่ายอดที่ย้าย
--   · ตรวจแอดมินยังเป็นหน้าที่ของ server action เหมือนเดิม (ไม่เปลี่ยนพฤติกรรมอื่น)
--
-- payment_adjustments: เพิ่ม type `credit_return` (บวกเท่านั้น) — ไม่ใช่ refund ⇒ ไม่นับเป็นเงินสดออก
--   (readers เดิมที่รวม adjustments ทุก type ได้ outstanding ถูกต้องโดยไม่ต้องแก้)
--
-- ROLLBACK: re-apply add_payment_adjustment จาก 20260813000026 · DROP FUNCTION credit_topup/credit_cash_payout/credit_return_charge ·
--           ลบ adjustments type credit_return ก่อนคืน constraint เดิม
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. payment_adjustments — type credit_return
-- -----------------------------------------------------------------------------
alter table public.payment_adjustments
  drop constraint payment_adjustments_type_check;

alter table public.payment_adjustments
  add constraint payment_adjustments_type_check
    check (type in ('refund', 'correction', 'credit', 'credit_return')),
  add constraint payment_adjustments_credit_return_positive
    check (type <> 'credit_return' or amount > 0);

comment on constraint payment_adjustments_credit_return_positive on public.payment_adjustments is
  '[ADR-010 · B5b] credit_return = ย้ายยอดต้องคืนของ charge เข้าเครดิตสมาชิก (บวก = ล้างยอดติดลบ) · เขียนผ่าน credit_return_charge() เท่านั้น';


-- -----------------------------------------------------------------------------
-- 2. add_payment_adjustment — ล็อก charge + เพดาน refund นับเฉพาะ transfer
-- -----------------------------------------------------------------------------
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
  v_returned   numeric(12, 2);
  v_adjustment public.payment_adjustments;
begin
  -- [B5b-2] FOR UPDATE: เรียงคิวกับ credit_return_charge และการปรับยอดซ้อนบน charge เดียวกัน
  select * into v_charge from public.session_charges where id = p_charge_id for update;
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

  -- 🔴 คืนเงินสดเกินกว่าที่โอนเข้ามาจริงไม่ได้ [B5b-2]
  --    นับเฉพาะ allocation source='transfer' — ส่วนที่จ่ายด้วยเครดิตคืนได้ทางเดียวคือเข้าเครดิต (credit_return_charge)
  --    และหักส่วนที่ย้ายเข้าเครดิตไปแล้ว (กันคืนซ้ำสองทาง)
  if p_type = 'refund' then
    select coalesce(sum(a.amount), 0) into v_allocated
      from public.payment_allocations a
      join public.payments p on p.id = a.payment_id
     where a.session_charge_id = p_charge_id
       and a.source = 'transfer'
       and p.status = 'verified'
       and p.deleted_at is null;

    select coalesce(-sum(j.amount), 0) into v_refunded
      from public.payment_adjustments j
     where j.session_charge_id = p_charge_id
       and j.type = 'refund';

    select coalesce(sum(j.amount), 0) into v_returned
      from public.payment_adjustments j
     where j.session_charge_id = p_charge_id
       and j.type = 'credit_return';

    if v_refunded + v_returned + (-p_amount) > v_allocated then
      raise exception using
        errcode = 'P0001', message = 'VALIDATION_ERROR',
        detail  = json_build_object(
          'reason', 'คืนเงินสดเกินยอดที่โอนเข้ามาจริง (ส่วนที่จ่ายด้วยเครดิตหรือย้ายเข้าเครดิตแล้วคืนเป็นเงินสดไม่ได้)',
          'allocated', v_allocated,
          'refunded', v_refunded,
          'returned_to_credit', v_returned
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
-- 3. credit_topup — แอดมิน/โอเนอร์ "ให้เครดิต" (ไม่ใช่เงินสดเข้า)
-- -----------------------------------------------------------------------------
create or replace function public.credit_topup(
  p_gang_id        uuid,
  p_user_id        uuid,
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

  if not public.actor_is_gang_admin(p_gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่ให้เครดิตได้')::text;
  end if;

  if not exists (
    select 1 from public.gang_members gm
     where gm.gang_id = p_gang_id and gm.user_id = p_user_id and gm.deleted_at is null
  ) then
    raise exception using
      errcode = 'P0001', message = 'NOT_GANG_MEMBER',
      detail  = json_build_object('reason', 'ให้เครดิตได้เฉพาะสมาชิกที่ยังอยู่ในก๊วน')::text;
  end if;

  insert into public.credit_balances (gang_id, user_id)
  values (p_gang_id, p_user_id)
  on conflict (gang_id, user_id) do nothing;

  select balance, last_seq into v_balance, v_seq
    from public.credit_balances
   where gang_id = p_gang_id and user_id = p_user_id
     for update;

  insert into public.credit_ledger
    (gang_id, user_id, seq, type, amount, balance_after, reason, created_by)
  values
    (p_gang_id, p_user_id, v_seq + 1, 'admin_topup', p_amount, v_balance + p_amount, v_reason, p_actor_id)
  returning * into v_row;

  update public.credit_balances
     set balance = v_balance + p_amount, last_seq = v_seq + 1
   where gang_id = p_gang_id and user_id = p_user_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'audit.credit_topup', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object(
       'entry_id',       v_row.id,
       'correlation_id', p_correlation_id,
       'user_id',        p_user_id,
       'amount',         p_amount,
       'reason',         v_reason,
       'balance_after',  v_balance + p_amount
     ));

  return v_row;
end;
$$;

comment on function public.credit_topup(uuid, uuid, numeric, text, uuid, text) is
  '[ADR-010 · Q3] แอดมิน/โอเนอร์ให้เครดิตแก่สมาชิก (ไม่ใช่เงินสดเข้า) · เหตุผลบังคับ · audit · FOR UPDATE credit_balances';


-- -----------------------------------------------------------------------------
-- 4. credit_cash_payout — จ่ายคืนเงินสดจากเครดิต (ลดเครดิต)
-- -----------------------------------------------------------------------------
create or replace function public.credit_cash_payout(
  p_gang_id        uuid,
  p_user_id        uuid,
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

  if not public.actor_is_gang_admin(p_gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่จ่ายคืนเครดิตเป็นเงินสดได้')::text;
  end if;

  -- สมาชิกที่ออกจากก๊วนแล้วยังรับคืนได้ (นี่คือทางเดียวที่เครดิตของคนที่ออกไปแล้วออกจากระบบ) ⇒ ไม่ตรวจ membership

  -- 🔴 ล็อกแถวยอดก่อนอ่านยอด — ไม่มีแถว = ไม่มีเครดิต
  select balance, last_seq into v_balance, v_seq
    from public.credit_balances
   where gang_id = p_gang_id and user_id = p_user_id
     for update;

  if not found or v_balance < p_amount then
    raise exception using
      errcode = 'P0001', message = 'INSUFFICIENT_CREDIT',
      detail  = json_build_object('balance', coalesce(v_balance, 0), 'requested', p_amount)::text;
  end if;

  insert into public.credit_ledger
    (gang_id, user_id, seq, type, amount, balance_after, reason, created_by)
  values
    (p_gang_id, p_user_id, v_seq + 1, 'cash_payout', -p_amount, v_balance - p_amount, v_reason, p_actor_id)
  returning * into v_row;

  update public.credit_balances
     set balance = v_balance - p_amount, last_seq = v_seq + 1
   where gang_id = p_gang_id and user_id = p_user_id;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'audit.credit_cash_payout', 'gang', p_gang_id, p_actor_id,
     jsonb_build_object(
       'entry_id',       v_row.id,
       'correlation_id', p_correlation_id,
       'user_id',        p_user_id,
       'amount',         p_amount,
       'reason',         v_reason,
       'balance_after',  v_balance - p_amount
     ));

  return v_row;
end;
$$;

comment on function public.credit_cash_payout(uuid, uuid, numeric, text, uuid, text) is
  '[ADR-010 · Q4] จ่ายคืนเครดิตเป็นเงินสด (เงินออกจริง) · ≤ ยอดคงเหลือ ไม่งั้น INSUFFICIENT_CREDIT · FOR UPDATE credit_balances';


-- -----------------------------------------------------------------------------
-- 5. credit_return_charge — ย้ายยอด "ต้องคืน" ของ charge เข้าเครดิต
-- -----------------------------------------------------------------------------
create or replace function public.credit_return_charge(
  p_charge_id      uuid,
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
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_charge    public.session_charges;
  v_owner     uuid;
  v_balance   numeric(12, 2);
  v_seq       bigint;
  v_out       numeric(12, 2);
  v_owed      numeric(12, 2);
  v_received  numeric(12, 2);
  v_cap       numeric(12, 2);
  v_amount    numeric(12, 2);
  v_row       public.credit_ledger;
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

  -- อ่านเจ้าของหนี้โดยยังไม่ล็อก (ใช้หาแถวยอดที่ต้องล็อกก่อน — เจ้าของหนี้เปลี่ยนไม่ได้)
  select * into v_charge from public.session_charges where id = p_charge_id;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'CHARGE_NOT_FOUND',
      detail  = json_build_object('charge_id', p_charge_id)::text;
  end if;

  select coalesce(r.user_id, gm.user_id)
    into v_owner
    from public.session_charges c
    left join public.session_registrations r on r.id = c.registration_id
    left join public.gang_members gm         on gm.id = c.gang_member_id
   where c.id = p_charge_id;

  if not public.actor_is_gang_admin(v_charge.gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่ย้ายยอดเข้าเครดิตได้')::text;
  end if;

  if v_owner is null then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('reason', 'หนี้ของ guest ไม่มีบัญชี ย้ายเข้าเครดิตไม่ได้')::text;
  end if;

  -- 🔴 ลำดับล็อก: credit_balances → session_charges (เหมือน apply_credit ที่ล็อกยอดก่อนแตะ charge)
  insert into public.credit_balances (gang_id, user_id)
  values (v_charge.gang_id, v_owner)
  on conflict (gang_id, user_id) do nothing;

  select balance, last_seq into v_balance, v_seq
    from public.credit_balances
   where gang_id = v_charge.gang_id and user_id = v_owner
     for update;

  perform 1 from public.session_charges where id = p_charge_id for update;

  v_out  := public.charge_outstanding(p_charge_id);
  v_owed := greatest(-v_out, 0);

  select coalesce((
           select sum(a.amount)
             from public.payment_allocations a
             join public.payments p on p.id = a.payment_id
            where a.session_charge_id = p_charge_id
              and p.status = 'verified'
              and p.deleted_at is null
         ), 0)
       - coalesce((
           select -sum(j.amount) from public.payment_adjustments j
            where j.session_charge_id = p_charge_id and j.type = 'refund'
         ), 0)
       - coalesce((
           select sum(j.amount) from public.payment_adjustments j
            where j.session_charge_id = p_charge_id and j.type = 'credit_return'
         ), 0)
    into v_received;

  v_cap := least(v_owed, greatest(v_received, 0));

  v_amount := coalesce(p_amount, v_cap);

  if v_amount <= 0 then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'reason', 'ไม่มียอดต้องคืนที่ย้ายเข้าเครดิตได้ (ต้องลดหนี้ของ charge นี้ให้ติดลบก่อน และต้องมีเงินที่ได้รับจริง)',
        'owed', v_owed, 'received_net', v_received)::text;
  end if;

  if v_amount > v_cap then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object(
        'field', 'amount', 'reason', 'เกินยอดที่ย้ายเข้าเครดิตได้',
        'max', v_cap, 'owed', v_owed, 'received_net', v_received)::text;
  end if;

  insert into public.payment_adjustments
    (session_charge_id, type, amount, reason, created_by)
  values
    (p_charge_id, 'credit_return', v_amount, 'ย้ายเข้าเครดิตสมาชิก: ' || v_reason, p_actor_id);

  insert into public.credit_ledger
    (gang_id, user_id, seq, type, amount, balance_after, charge_id, reason, created_by)
  values
    (v_charge.gang_id, v_owner, v_seq + 1, 'charge_return', v_amount, v_balance + v_amount,
     p_charge_id, v_reason, p_actor_id)
  returning * into v_row;

  update public.credit_balances
     set balance = v_balance + v_amount, last_seq = v_seq + 1
   where gang_id = v_charge.gang_id and user_id = v_owner;

  insert into public.event_logs
    (gang_id, session_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (v_charge.gang_id, v_charge.session_id, 'audit.credit_charge_returned', 'charge', p_charge_id, p_actor_id,
     jsonb_build_object(
       'correlation_id',    p_correlation_id,
       'user_id',           v_owner,
       'amount',            v_amount,
       'reason',            v_reason,
       'balance_after',     v_balance + v_amount,
       'outstanding_after', public.charge_outstanding(p_charge_id)
     ));

  return v_row;
end;
$$;

comment on function public.credit_return_charge(uuid, numeric, text, uuid, text) is
  '[ADR-010 · Q2] ย้ายยอด "ต้องคืน" (outstanding ติดลบ) ของ charge เข้าเครดิตสมาชิก · ≤ min(ต้องคืน, เงินที่ได้รับจริง) · ล็อก balance → charge · เรียกซ้ำไม่เบิ้ล';


-- -----------------------------------------------------------------------------
-- 6. EXECUTE — service_role เท่านั้น
-- -----------------------------------------------------------------------------
revoke all on function public.credit_topup(uuid, uuid, numeric, text, uuid, text)          from public, anon, authenticated;
revoke all on function public.credit_cash_payout(uuid, uuid, numeric, text, uuid, text)    from public, anon, authenticated;
revoke all on function public.credit_return_charge(uuid, numeric, text, uuid, text)        from public, anon, authenticated;

grant execute on function public.credit_topup(uuid, uuid, numeric, text, uuid, text)       to service_role;
grant execute on function public.credit_cash_payout(uuid, uuid, numeric, text, uuid, text) to service_role;
grant execute on function public.credit_return_charge(uuid, numeric, text, uuid, text)     to service_role;
