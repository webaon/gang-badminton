-- =============================================================================
-- 20260818000051 — WO-R-roles-2a (ADR-015 · ขั้น MIGRATE กลุ่ม "การเงิน"): is_gang_admin → ตัวตัดสินที่รู้ชุดสิทธิ์
-- =============================================================================
-- ต่อจาก 0050 (EXPAND): ตอนนี้ policy/function การเงินยอมรับ "ผู้ถือชุดสิทธิ์ที่มี action นั้น" ด้วย (เช่น เหรัญญิก)
-- นอกเหนือจาก admin/owner/แอดมินองค์กร — ตัวตัดสินใหม่ ⊇ ตัวเดิมเสมอ ⇒ **ไม่มีใครเสียสิทธิ์**;
-- คนที่ได้สิทธิ์เพิ่มมีได้เฉพาะผู้ถือชุดสิทธิ์ ซึ่งยังไม่มีใครถือจริงจนกว่าจะเปิด R-roles-4
--
-- แมป action ↔ ด่าน (ชื่อเดียวกับ can() ใน domain/permissions):
--   payments select/update · payment_allocations (ตาม payments) · สลิป (storage payment-slips select/update/delete) → payment.verify
--   session_charges · payment_adjustments (select)                                                                  → gang.finance.view
--   gang_expenses / gang_incomes: อ่าน → gang.finance.view · เขียน (insert/update/delete) → gang.finance.manage
--   credit_ledger · credit_balances (select)                                                                        → credit.read.other
--   event_logs (Q6ก): ผู้ถือ gang.finance.view เห็น payment.* และ audit.credit_* เท่านั้น (ไม่รวม audit อื่น/ยอดเงินรายคนอื่น)
--   DB function: set_payment_received_amount → payment.verify · record_overpayment → credit.overpayment.record ·
--                credit_cash_payout → credit.payout.record · credit_return_charge → credit.return_charge · credit_topup → credit.topup
--
-- 🔴 รูปแบบใน policy = "gang_id = any ((select gangs_with_permission('<action>'))::uuid[])" ไม่ใช่ has_gang_permission(gang_id, …) ต่อแถว
--    เหตุผล (วัดจริงบน DB local 20k แถว payments, ผู้ใช้ที่ไม่มีสิทธิ์): is_gang_admin ต่อแถว 0.29 วินาที · has_gang_permission ต่อแถว 5.5 วินาที
--    (19 เท่า — ทำให้ tests/rls/tenant-isolation "infinite recursion" เกิน 30 วิ) · gangs_with_permission เป็น InitPlan คำนวณครั้งเดียวต่อ statement
--    = 3 มิลลิวินาที และ planner ใช้ index ของ gang_id ได้ — ความหมายเท่ากัน (มีเทสต์เทียบ gangs_with_permission กับ has_gang_permission ทุก action)
--    ⇒ R-roles-2b/2c ต้องใช้รูปแบบนี้กับ policy ที่มี gang_id เป็นคอลัมน์ตรง · has_gang_permission/actor_has_permission ไว้ใช้ใน DB function
--    (เรียกครั้งเดียวต่อคำสั่ง)
-- 🔴 payment_allocations_select: เดิมเรียก is_payment_visible(payment_id) ต่อแถว (0.5ms/แถว) → ใช้ "มี payment ที่ RLS ของ payments ให้เห็น"
--    (exists + payments_select) ซึ่งความหมายเท่ากับ is_payment_visible (deleted_at is null และ เจ้าของสลิป/ผู้ตรวจสลิป) · ฟังก์ชัน
--    is_payment_visible ยังอยู่ (อัปเดตให้รู้ชุดสิทธิ์) ไว้เป็นตัวช่วยตรง ๆ
-- 🔴 ฟังก์ชัน DB คัดลอกจากเวอร์ชันล่าสุด (0047/0048/0049) เปลี่ยนเฉพาะบรรทัดตรวจสิทธิ์ (actor_is_gang_admin → actor_has_permission)
-- 🔴 เทสต์ role-matrix golden: ช่องที่เปลี่ยนต้องเป็นคอลัมน์ member (= ผู้ถือ treasurer ใน world) เท่านั้น · payer (สมาชิกธรรมดา) ต้องไม่เปลี่ยน
-- 🔴 ไม่ใช่การเปิดใช้: server action ยังโหลดสิทธิ์ด้วย role อย่างเดียว (R-roles-3) และยังไม่มี UI/endpoint แต่งตั้ง (R-roles-4)
--
-- idempotent: ทุก drop policy ใช้ if exists (รันซ้ำบนฐานที่มีนิยามชุดเก่า/ใหม่ได้)
-- ROLLBACK: re-apply policy จาก 20260811000010 / 20260817000039 / 20260818000044 / 20260811000011 (is_gang_admin(...) แบบเดิม)
--           ฟังก์ชัน: set_payment_received_amount/record_overpayment จาก 0047 · credit_cash_payout/credit_return_charge จาก 0048 · credit_topup จาก 0049
--           is_payment_visible จาก 20260811000010 · DROP FUNCTION public.event_type_is_finance(text), public.gangs_with_permission(text);
--           gang_expenses/gang_incomes: drop policy *_select/*_manage แล้วสร้าง *_admin FOR ALL ด้วย is_gang_admin(gang_id) ตามเดิม
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. gangs_with_permission(action) — ก๊วนทั้งหมดที่ผู้ใช้ปัจจุบันทำ action นี้ได้ (ใช้ใน policy แบบ InitPlan)
-- -----------------------------------------------------------------------------
-- ต้องเท่ากับ { g | has_gang_permission(g, action) } เสมอ:
--   (1) สมาชิก role owner/admin ที่ยังอยู่  (2) แอดมินองค์กรของก๊วน  (3) ผู้ถือชุดสิทธิ์ที่มี action (เฉพาะ delegable, role=member)
create or replace function public.gangs_with_permission(p_action text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct s.g), '{}'::uuid[])
    from (
      select gm.gang_id as g
        from public.gang_members gm
       where gm.user_id    = (select auth.uid())
         and gm.deleted_at is null
         and gm.role       in ('owner', 'admin')
      union
      select ga.id
        from public.gangs ga
        join public.organization_members om on om.org_id = ga.org_id
       where om.user_id    = (select auth.uid())
         and ga.deleted_at is null
      union
      select gm.gang_id
        from public.gang_members gm
        join public.gang_member_roles gmr
          on gmr.gang_member_id = gm.id and gmr.deleted_at is null
        join public.gang_roles r
          on r.id = gmr.role_id and r.deleted_at is null
       where gm.user_id    = (select auth.uid())
         and gm.deleted_at is null
         and gm.role       = 'member'
         and public.is_delegable_action(p_action)
         and p_action      = any (r.permissions)
    ) s;
$$;

comment on function public.gangs_with_permission(text) is
  '[ADR-015] ก๊วนที่ผู้ใช้ปัจจุบันทำ action นี้ได้ = {g | has_gang_permission(g, action)} — ใช้ใน policy เป็น InitPlan: gang_id = any ((select gangs_with_permission(..))::uuid[])';

revoke execute on function public.gangs_with_permission(text) from public;
grant  execute on function public.gangs_with_permission(text) to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. event_type_is_finance — event การเงินที่ผู้ถือ gang.finance.view เห็นได้ (Q6ก) · ⊂ event_type_is_admin_only
-- -----------------------------------------------------------------------------
create or replace function public.event_type_is_finance(p_event_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_event_type like 'payment.%'
      or p_event_type like 'audit.credit\_%';
$$;

comment on function public.event_type_is_finance(text) is
  '[ADR-015 Q6ก] event การเงินที่เหรัญญิกเห็น: payment.* และ audit.credit_* เท่านั้น — ต้องเป็นเซตย่อยของ event_type_is_admin_only (มีเทสต์)';

revoke execute on function public.event_type_is_finance(text) from public;
grant  execute on function public.event_type_is_finance(text) to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. is_payment_visible — เจ้าของสลิป หรือผู้มีสิทธิ์ตรวจสลิป (payment.verify) — ตัวช่วยตรง ๆ (policy ไม่ได้ใช้แล้ว ดูหัวไฟล์)
--    เดิม: p.payer_user_id = auth.uid() or is_gang_admin(p.gang_id)
-- -----------------------------------------------------------------------------
create or replace function public.is_payment_visible(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.payments p
     where p.id         = p_payment_id
       and p.deleted_at is null
       and (
         p.payer_user_id = (select auth.uid())
         or public.has_gang_permission(p.gang_id, 'payment.verify')
       )
  );
$$;


-- -----------------------------------------------------------------------------
-- 4. payments — เดิม: payer_user_id = auth.uid() or is_gang_admin(gang_id)
-- -----------------------------------------------------------------------------
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated
  using (
    deleted_at is null
    and (
      payer_user_id = (select auth.uid())
      or gang_id = any ((select public.gangs_with_permission('payment.verify'))::uuid[])
    )
  );

drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments
  for update to authenticated
  using (
    deleted_at is null
    and (
      payer_user_id = (select auth.uid())
      or gang_id = any ((select public.gangs_with_permission('payment.verify'))::uuid[])
    )
  )
  with check (
    payer_user_id = (select auth.uid())
    or gang_id = any ((select public.gangs_with_permission('payment.verify'))::uuid[])
  );

-- payment_allocations: เห็นได้เมื่อเห็น payment ต้นทางได้ (payments_select ใช้ซ้ำผ่าน RLS) — เดิม: is_payment_visible(payment_id)
drop policy if exists payment_allocations_select on public.payment_allocations;
create policy payment_allocations_select on public.payment_allocations
  for select to authenticated
  using (
    exists (
      select 1 from public.payments p
       where p.id = payment_allocations.payment_id
    )
  );


-- -----------------------------------------------------------------------------
-- 5. session_charges / payment_adjustments (select) — เดิม: is_gang_admin(gang_id) or เจ้าของหนี้
-- -----------------------------------------------------------------------------
drop policy if exists session_charges_select on public.session_charges;
create policy session_charges_select on public.session_charges
  for select to authenticated
  using (
    gang_id = any ((select public.gangs_with_permission('gang.finance.view'))::uuid[])
    or exists (
      select 1 from public.session_registrations r
       where r.id = session_charges.registration_id
         and r.user_id = (select auth.uid())
    )
    or exists (
      select 1 from public.gang_members gm
       where gm.id = session_charges.gang_member_id
         and gm.user_id = (select auth.uid())
    )
  );

drop policy if exists payment_adjustments_select on public.payment_adjustments;
create policy payment_adjustments_select on public.payment_adjustments
  for select to authenticated
  using (
    exists (
      select 1
        from public.session_charges sc
       where sc.id = payment_adjustments.session_charge_id
         and (
           sc.gang_id = any ((select public.gangs_with_permission('gang.finance.view'))::uuid[])
           or exists (
             select 1 from public.session_registrations r
              where r.id = sc.registration_id
                and r.user_id = (select auth.uid())
           )
           or exists (
             select 1 from public.gang_members gm
              where gm.id = sc.gang_member_id
                and gm.user_id = (select auth.uid())
           )
         )
    )
  );


-- -----------------------------------------------------------------------------
-- 6. gang_expenses / gang_incomes — เดิม: FOR ALL ด้วย is_gang_admin(gang_id)
--    ตอนนี้แยก อ่าน (gang.finance.view) กับ เขียน (gang.finance.manage) · policy *_manage เป็น FOR ALL ⇒ ผู้ถือ manage อ่านได้ด้วย
-- -----------------------------------------------------------------------------
drop policy if exists gang_expenses_admin on public.gang_expenses;
drop policy if exists gang_expenses_select on public.gang_expenses;
drop policy if exists gang_expenses_manage on public.gang_expenses;
create policy gang_expenses_select on public.gang_expenses
  for select to authenticated
  using (gang_id = any ((select public.gangs_with_permission('gang.finance.view'))::uuid[]));
create policy gang_expenses_manage on public.gang_expenses
  for all to authenticated
  using (gang_id = any ((select public.gangs_with_permission('gang.finance.manage'))::uuid[]))
  with check (gang_id = any ((select public.gangs_with_permission('gang.finance.manage'))::uuid[]));

drop policy if exists gang_incomes_admin on public.gang_incomes;
drop policy if exists gang_incomes_select on public.gang_incomes;
drop policy if exists gang_incomes_manage on public.gang_incomes;
create policy gang_incomes_select on public.gang_incomes
  for select to authenticated
  using (gang_id = any ((select public.gangs_with_permission('gang.finance.view'))::uuid[]));
create policy gang_incomes_manage on public.gang_incomes
  for all to authenticated
  using (gang_id = any ((select public.gangs_with_permission('gang.finance.manage'))::uuid[]))
  with check (gang_id = any ((select public.gangs_with_permission('gang.finance.manage'))::uuid[]));


-- -----------------------------------------------------------------------------
-- 7. credit_ledger / credit_balances (select) — เดิม: is_gang_admin(gang_id) or ของตัวเอง
-- -----------------------------------------------------------------------------
drop policy if exists credit_ledger_select on public.credit_ledger;
create policy credit_ledger_select on public.credit_ledger
  for select to authenticated
  using (
    gang_id = any ((select public.gangs_with_permission('credit.read.other'))::uuid[])
    or (
      user_id = (select auth.uid())
      and (select public.is_gang_member(gang_id))
    )
  );

drop policy if exists credit_balances_select on public.credit_balances;
create policy credit_balances_select on public.credit_balances
  for select to authenticated
  using (
    gang_id = any ((select public.gangs_with_permission('credit.read.other'))::uuid[])
    or (
      user_id = (select auth.uid())
      and (select public.is_gang_member(gang_id))
    )
  );


-- -----------------------------------------------------------------------------
-- 8. event_logs (select) — Q6ก: เหรัญญิกเห็น payment.* และ audit.credit_* ด้วย
--    เดิม: gang_id not null and (is_gang_admin or (is_gang_member and not event_type_is_admin_only))
-- -----------------------------------------------------------------------------
drop policy if exists event_logs_select_member on public.event_logs;
create policy event_logs_select_member on public.event_logs
  for select to authenticated
  using (
    gang_id is not null
    and (
      (select public.is_gang_admin(gang_id))
      or (
        (select public.is_gang_member(gang_id))
        and not public.event_type_is_admin_only(event_type)
      )
      or (
        public.event_type_is_finance(event_type)
        and gang_id = any ((select public.gangs_with_permission('gang.finance.view'))::uuid[])
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 9. storage payment-slips (select/update/delete) — เดิม: owner = auth.uid() or is_gang_admin(folder[1])
--    insert ไม่เปลี่ยน (สมาชิกอัปของตัวเอง)
-- -----------------------------------------------------------------------------
drop policy if exists payment_slips_select on storage.objects;
create policy payment_slips_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-slips'
    and (
      owner = (select auth.uid())
      or (storage.foldername(name))[1]::uuid = any ((select public.gangs_with_permission('payment.verify'))::uuid[])
    )
  );

drop policy if exists payment_slips_update on storage.objects;
create policy payment_slips_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'payment-slips'
    and (
      owner = (select auth.uid())
      or (storage.foldername(name))[1]::uuid = any ((select public.gangs_with_permission('payment.verify'))::uuid[])
    )
  );

drop policy if exists payment_slips_delete on storage.objects;
create policy payment_slips_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'payment-slips'
    and (
      owner = (select auth.uid())
      or (storage.foldername(name))[1]::uuid = any ((select public.gangs_with_permission('payment.verify'))::uuid[])
    )
  );


-- =============================================================================
-- 10. DB function — คัดลอกจากเวอร์ชันล่าสุด เปลี่ยนเฉพาะบรรทัดตรวจสิทธิ์ (actor_is_gang_admin → actor_has_permission)
-- =============================================================================

-- ---- set_payment_received_amount → payment.verify (คัดลอกจาก 20260818000047_credit_types_received_amount.sql บรรทัด 70–145) ----
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

  if not public.actor_has_permission(v_payment.gang_id, p_actor_id, 'payment.verify') then
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

-- ---- record_overpayment → credit.overpayment.record (คัดลอกจาก 20260818000047_credit_types_received_amount.sql บรรทัด 196–332) ----
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

  if not public.actor_has_permission(v_payment.gang_id, p_actor_id, 'credit.overpayment.record') then
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

-- ---- credit_cash_payout → credit.payout.record (คัดลอกจาก 20260818000048_credit_flows.sql บรรทัด 267–343) ----
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

  if not public.actor_has_permission(p_gang_id, p_actor_id, 'credit.payout.record') then
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

-- ---- credit_return_charge → credit.return_charge (คัดลอกจาก 20260818000048_credit_flows.sql บรรทัด 352–501) ----
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

  if not public.actor_has_permission(v_charge.gang_id, p_actor_id, 'credit.return_charge') then
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

-- ---- credit_topup → credit.topup (คัดลอกจาก 20260818000049_leave_gang_credit.sql บรรทัด 25–112) ----
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

  if not public.actor_has_permission(p_gang_id, p_actor_id, 'credit.topup') then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่ให้เครดิตได้')::text;
  end if;

  -- [B5b-3 · คำตัดสิน planner] ห้ามให้เครดิตตัวเอง ทุกบทบาท (รวม owner) — กันแอดมินสร้างเครดิตให้ตัวเองเงียบๆ
  if p_user_id = p_actor_id then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'ให้เครดิตตัวเองไม่ได้ — ให้แอดมินคนอื่นทำแทน')::text;
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
