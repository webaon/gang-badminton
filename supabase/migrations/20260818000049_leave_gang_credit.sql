-- =============================================================================
-- 20260818000049 — WO-B5b-3: leave_gang หักเครดิตกับหนี้ค้างก่อนออก + กันให้เครดิตตัวเอง
-- =============================================================================
-- คำตัดสินเจ้าของงาน (29 ต.ค.): Q5 ข — ออกจากก๊วนแล้วเครดิตไม่ลอยค้าง:
--   leave_gang() เรียก apply_credit() ใน "ทรานแซกชันเดียวกับการออก" หักเครดิตกับหนี้ค้างของผู้ออกอัตโนมัติ (เก่าก่อน)
--   แล้วคืนยอดสุทธิทั้งสองใน result: credit_applied (หักไปเท่าไร) · credit_balance (เครดิตที่เหลือ) ·
--   outstanding_charges/outstanding_amount (หนี้ค้างสุทธิหลังหัก — คำนวณหลัง apply)
--   · เครดิตเหลือหลังออก ⇒ แอดมินจ่ายคืนเองด้วย credit_cash_payout (ทำได้แม้สมาชิกออกแล้ว — 0048)
--
-- 🔴 ไม่เปลี่ยนสัญญาเดิมของ leave_gang (ADR-012 "ออกได้เสมอ"): ขั้นหักเครดิตไม่มีเงื่อนไขล้มเหลวเชิงธุรกิจ
--    (apply_credit ที่ไม่มีเครดิต/ไม่มีหนี้คืนค่าเงียบๆ) · ลำดับ lock: gang_members (ทั้งก๊วน) → session/registration
--    (cancel_registration) → credit_balances → payments/allocations (apply_credit) — ไม่มีฟังก์ชันอื่นล็อกย้อนจาก
--    credit_balances ไป gang_members แบบ FOR UPDATE (credit_topup ใช้ SELECT ธรรมดา) ⇒ ไม่เกิดวงจร
-- 🔴 event 'gang.member_left' (สมาชิกอ่านได้) ยังไม่บันทึกยอดเงิน — ยอดอยู่ใน audit.credit_applied (แอดมินเท่านั้น)
--
-- กันให้เครดิตตัวเอง (คำตัดสิน planner ตาม Q3): credit_topup ปฏิเสธเมื่อ actor = ผู้รับ ทุกบทบาท (owner ก็ไม่ได้)
--
-- ROLLBACK: re-apply leave_gang จาก 20260818000040 · credit_topup จาก 20260818000048
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. credit_topup — actor ≠ recipient
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

comment on function public.credit_topup(uuid, uuid, numeric, text, uuid, text) is
  '[ADR-010 · Q3] แอดมิน/โอเนอร์ให้เครดิตแก่สมาชิก (ไม่ใช่เงินสดเข้า) · ห้ามให้ตัวเอง · เหตุผลบังคับ · audit · FOR UPDATE credit_balances';


-- -----------------------------------------------------------------------------
-- 2. leave_gang — หักเครดิตกับหนี้ก่อนออก
-- -----------------------------------------------------------------------------
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
  v_credit_before numeric(12, 2);
  v_credit_after  numeric(12, 2);
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

  -- [B5b-3 · Q5 ข] หักเครดิตกับหนี้ค้างของผู้ออกอัตโนมัติ (เก่าก่อน · ทรานแซกชันเดียวกับการออก)
  --   apply_credit ไม่มีเครดิต/ไม่มีหนี้ = คืนค่าเงียบๆ (ไม่ล้ม) ⇒ "ออกได้เสมอ" (ADR-012) ไม่เปลี่ยน
  --   ทำก่อนอ่านยอดค้างด้านล่าง ⇒ outstanding_* ใน result คือยอดสุทธิหลังหัก
  v_credit_before := public.credit_balance_of(p_gang_id, p_actor_id);
  if v_credit_before > 0 then
    perform public.apply_credit(p_gang_id, p_actor_id, null, p_actor_id, p_correlation_id);
  end if;
  v_credit_after := public.credit_balance_of(p_gang_id, p_actor_id);

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
    'outstanding_amount',      v_owed_amount::text,
    -- [B5b-3] เครดิตที่หักไปกับหนี้ตอนออก / เครดิตที่เหลือ (แอดมินจ่ายคืนเงินสดเองด้วย credit_cash_payout)
    'credit_applied',          (v_credit_before - v_credit_after)::text,
    'credit_balance',          v_credit_after::text
  );
end;
$$;

comment on function public.leave_gang(uuid, uuid, text) is
  '[ADR-012][B5b-3] ออกจากก๊วนเอง — lock สมาชิก · owner คนสุดท้ายออกไม่ได้ · ยกเลิก registration อนาคตผ่าน cancel_registration() · หักเครดิตกับหนี้ค้างก่อนออก (apply_credit) · คืนยอดสุทธิ';

-- signature เดิมทั้งสองฟังก์ชัน ⇒ grant เดิมคงอยู่ · ย้ำซ้ำให้ชัด
revoke execute on function public.leave_gang(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.leave_gang(uuid, uuid, text) to service_role;
revoke all on function public.credit_topup(uuid, uuid, numeric, text, uuid, text) from public, anon, authenticated;
grant execute on function public.credit_topup(uuid, uuid, numeric, text, uuid, text) to service_role;
