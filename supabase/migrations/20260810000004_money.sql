-- =============================================================================
-- WO-1.2 · 0004 — เงิน (charges / payments / allocations / adjustments / ledger)
-- =============================================================================
-- Baseline: §Database Schema → ตาราง → "เงิน" + ADR-001
--
-- 🔴 หลักการที่ schema นี้บังคับ:
--   1. เงินทุกคอลัมน์เป็น DECIMAL (numeric) — ห้าม float เด็ดขาด
--   2. Ledger append-only — refund/correction ไม่แก้ record เดิม แต่เพิ่มแถวใน
--      payment_adjustments ที่อ้าง session_charge_id (ระดับหนี้ต่อคน ไม่ใช่ payment ทั้งก้อน)
--      → refund บางส่วนของการจ่ายแทนเพื่อนรู้ว่าลดหนี้ใคร
--   3. ยอดสุทธิต่อคน = charge − allocations + adjustments (คำนวณสดเสมอ ไม่อ่านจาก status)
--   4. invariant: sum(allocations ของ payment) ≤ payment.amount  → บังคับด้วย trigger
--   5. Allocated/Adjusted/Refunded ไม่ใช่ state ของ payment (baseline §ADR "ไม่รับ")
--
-- 🔴 ADR-001: charges ประเภท 'session' commit ผ่าน close_session_with_charges() เท่านั้น
--             charges ประเภท 'monthly_fee' ผ่านฟังก์ชันของ MembershipBilling (idempotent)
--             ทั้งสองฟังก์ชันอยู่ใน WO-1.3 — migration นี้เตรียมแค่โครงตาราง
--
-- Rollback: DROP TABLE payment_adjustments, payment_allocations, payments,
--           session_charges, coupons, gang_expenses, gang_incomes CASCADE;
--           DROP FUNCTION check_allocation_within_payment();
-- =============================================================================

-- -----------------------------------------------------------------------------
-- session_charges — หนี้ต่อคน
-- -----------------------------------------------------------------------------
create table public.session_charges (
  id              uuid        primary key default public.uuid_generate_v7(),
  gang_id         uuid        not null references public.gangs (id) on delete cascade,

  type            text        not null check (type in ('session', 'monthly_fee')),

  -- type='session'     → session_id + registration_id ต้องมี
  -- type='monthly_fee' → gang_member_id + billing_month ต้องมี (ไม่ผูก session)
  session_id      uuid        references public.sessions (id)              on delete cascade,
  registration_id uuid        references public.session_registrations (id) on delete cascade,
  gang_member_id  uuid        references public.gang_members (id)          on delete cascade,
  billing_month   date,

  amount          numeric(12, 2) not null check (amount >= 0),

  -- breakdown จาก Billing Engine (domain/billing — pure TS)
  -- { court_fee, shuttle_fee, penalty, discount, rounding_surplus, ... }
  breakdown       jsonb       not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id),
  updated_by      uuid references public.profiles (id),

  constraint session_charges_session_shape check (
    type <> 'session'
    or (session_id is not null and registration_id is not null)
  ),
  constraint session_charges_monthly_shape check (
    type <> 'monthly_fee'
    or (gang_member_id is not null and billing_month is not null and session_id is null)
  )
);

comment on table public.session_charges is
  '🔴 ADR-001: type=session insert ผ่าน close_session_with_charges() เท่านั้น / type=monthly_fee ผ่าน MembershipBilling';
comment on column public.session_charges.breakdown is
  'รวม rounding_surplus เพื่อให้รายงาน reconcile ได้: sum(charges) − ต้นทุนจริง = surplus ตาม policy';

-- idempotency ของ MembershipBilling: สมาชิก + เดือน ต้องไม่ซ้ำ (baseline §Verification)
create unique index session_charges_monthly_member_month_key
  on public.session_charges (gang_member_id, billing_month)
  where type = 'monthly_fee';

-- หนึ่ง registration มี charge ประเภท session ได้ใบเดียว — กัน commit ซ้ำ
create unique index session_charges_session_registration_key
  on public.session_charges (registration_id)
  where type = 'session';

create index session_charges_session_idx on public.session_charges (session_id);
create index session_charges_member_idx  on public.session_charges (gang_member_id);
-- รายงานรายรับต่อก๊วนตามช่วงเวลา (รายงานนับจาก ledger เสมอ ไม่อิง session status)
create index session_charges_gang_type_created_idx
  on public.session_charges (gang_id, type, created_at);

create trigger session_charges_set_updated_at
  before update on public.session_charges
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- payments
-- -----------------------------------------------------------------------------
-- Payment state machine (baseline §State Machines):
--   pending → submitted → verified | rejected  และ  rejected → submitted
--   enforce ด้วย trigger + GUC เดียวกับ sessions (WO-1.3)
create table public.payments (
  id            uuid        primary key default public.uuid_generate_v7(),
  gang_id       uuid        not null references public.gangs (id)    on delete cascade,
  payer_user_id uuid        references public.profiles (id)          on delete set null,

  amount        numeric(12, 2) not null check (amount > 0),

  qr_payload    text,
  slip_url      text,

  status        text        not null default 'pending'
                            check (status in ('pending', 'submitted', 'verified', 'rejected')),

  submitted_at  timestamptz,
  verified_at   timestamptz,
  verified_by   uuid        references public.profiles (id) on delete set null,
  rejected_at   timestamptz,
  reject_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid references public.profiles (id),
  updated_by    uuid references public.profiles (id),
  deleted_by    uuid references public.profiles (id)
);

comment on table public.payments is
  'การจ่ายเงิน 1 ครั้ง (1 สลิป) — จ่ายแทนเพื่อนได้ผ่าน payment_allocations หลายแถว';
comment on column public.payments.status is
  'Allocated/Adjusted/Refunded ไม่ใช่ state ของ payment — เป็นแถวใน allocations/adjustments';

create index payments_payer_idx      on public.payments (payer_user_id) where deleted_at is null;
create index payments_verified_by_idx on public.payments (verified_by);
-- dashboard ค้างจ่าย / รอ verify ต่อก๊วน
create index payments_gang_status_created_idx
  on public.payments (gang_id, status, created_at) where deleted_at is null;

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- payment_allocations — 1 payment → หลาย charges
-- -----------------------------------------------------------------------------
create table public.payment_allocations (
  id                uuid        primary key default public.uuid_generate_v7(),
  payment_id        uuid        not null references public.payments (id)        on delete cascade,
  session_charge_id uuid        not null references public.session_charges (id) on delete restrict,
  amount            numeric(12, 2) not null check (amount > 0),
  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles (id),

  constraint payment_allocations_payment_charge_key unique (payment_id, session_charge_id)
);

comment on table public.payment_allocations is
  'จ่ายแทนเพื่อน: 1 สลิป → หลาย charge. invariant sum(allocations) ≤ payment.amount บังคับด้วย trigger';

-- 📌 on delete restrict บน session_charge_id เป็น "การกันโดยตั้งใจ" ไม่ใช่ความพลาด:
--    hard delete session ที่มีเงินผูกอยู่แล้วจะถูกบล็อกที่จุดนี้ (ledger ต้องไม่หายเงียบ)
--    ทางปกติของการลบคือ soft delete (deleted_at) ตาม baseline อยู่แล้ว

create index payment_allocations_payment_idx on public.payment_allocations (payment_id);
create index payment_allocations_charge_idx  on public.payment_allocations (session_charge_id);


-- invariant [v3]: sum(allocations ของ payment) ≤ payment.amount
-- CHECK constraint ทำ aggregate ไม่ได้ → ต้องเป็น trigger
create or replace function public.check_allocation_within_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_total   numeric(12, 2);
  v_payment numeric(12, 2);
begin
  select coalesce(sum(amount), 0) into v_total
    from public.payment_allocations
   where payment_id = new.payment_id;

  select amount into v_payment
    from public.payments
   where id = new.payment_id;

  if v_total > v_payment then
    raise exception using
      errcode = 'P0001',
      message = 'ALLOCATION_EXCEEDS_PAYMENT',
      detail  = json_build_object(
                  'payment_id',        new.payment_id,
                  'payment_amount',    v_payment,
                  'allocated_total',   v_total
                )::text;
  end if;

  return null;
end;
$$;

comment on function public.check_allocation_within_payment() is
  'invariant: sum(allocations) ≤ payment.amount — error code ตาม docs/errors.md';

-- CONSTRAINT TRIGGER + DEFERRABLE: เช็คตอน commit ทั้งชุด ไม่ใช่ทีละแถว
-- → insert allocations หลายแถวใน transaction เดียวไม่ false-positive จากลำดับแถว
create constraint trigger payment_allocations_within_payment
  after insert or update on public.payment_allocations
  deferrable initially deferred
  for each row execute function public.check_allocation_within_payment();


-- -----------------------------------------------------------------------------
-- payment_adjustments — [v3] อ้าง session_charge_id (ระดับหนี้ต่อคน)
-- -----------------------------------------------------------------------------
create table public.payment_adjustments (
  id                uuid        primary key default public.uuid_generate_v7(),
  session_charge_id uuid        not null references public.session_charges (id) on delete restrict,
  -- payment_id เป็นข้อมูลประกอบ (refund อ้างอิงกลับไปที่สลิปไหน) ไม่ใช่ตัวกำหนดยอด
  payment_id        uuid        references public.payments (id) on delete set null,

  type              text        not null check (type in ('refund', 'correction', 'credit')),
  -- บวก = เพิ่มหนี้ (correction ขึ้น) / ลบ = ลดหนี้ (refund, credit)
  amount            numeric(12, 2) not null,
  reason            text        not null,

  created_at        timestamptz not null default now(),
  created_by        uuid references public.profiles (id)
);

comment on table public.payment_adjustments is
  '[v3] append-only — ไม่แก้ record เดิม. อ้าง session_charge_id เพื่อให้รู้ว่าลดหนี้ใคร';

create index payment_adjustments_charge_idx  on public.payment_adjustments (session_charge_id);
create index payment_adjustments_payment_idx on public.payment_adjustments (payment_id);


-- -----------------------------------------------------------------------------
-- coupons — phase หลัง MVP (schema ลงไว้ ยังไม่มี logic)
-- -----------------------------------------------------------------------------
create table public.coupons (
  id            uuid        primary key default public.uuid_generate_v7(),
  gang_id       uuid        not null references public.gangs (id) on delete cascade,
  code          text        not null,
  discount_type text        not null check (discount_type in ('fixed', 'percent')),
  discount_value numeric(12, 2) not null check (discount_value > 0),
  valid_from    timestamptz,
  valid_until   timestamptz,
  max_uses      integer     check (max_uses is null or max_uses > 0),
  used_count    integer     not null default 0 check (used_count >= 0),
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id),
  updated_by    uuid references public.profiles (id),

  constraint coupons_gang_code_key unique (gang_id, code)
);

comment on table public.coupons is 'Phase หลัง MVP — schema ลงไว้ก่อนตาม baseline §ตาราง';

create index coupons_gang_active_idx on public.coupons (gang_id, is_active);

create trigger coupons_set_updated_at
  before update on public.coupons
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- gang_expenses / gang_incomes — รายงานรายรับ-รายจ่าย
-- -----------------------------------------------------------------------------
create table public.gang_expenses (
  id           uuid        primary key default public.uuid_generate_v7(),
  gang_id      uuid        not null references public.gangs (id)    on delete cascade,
  session_id   uuid        references public.sessions (id)          on delete set null,
  category     text        not null,
  amount       numeric(12, 2) not null check (amount >= 0),
  note         text,
  occurred_on  date        not null default current_date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id),
  updated_by   uuid references public.profiles (id)
);

create index gang_expenses_gang_occurred_idx on public.gang_expenses (gang_id, occurred_on);
create index gang_expenses_session_idx       on public.gang_expenses (session_id);

create trigger gang_expenses_set_updated_at
  before update on public.gang_expenses
  for each row execute function public.set_updated_at();


create table public.gang_incomes (
  id           uuid        primary key default public.uuid_generate_v7(),
  gang_id      uuid        not null references public.gangs (id)    on delete cascade,
  session_id   uuid        references public.sessions (id)          on delete set null,
  category     text        not null,
  amount       numeric(12, 2) not null check (amount >= 0),
  note         text,
  occurred_on  date        not null default current_date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id),
  updated_by   uuid references public.profiles (id)
);

comment on table public.gang_incomes is
  'รายรับนอกเหนือจาก session_charges (เช่น สปอนเซอร์) — รายงานหลักยังนับจาก ledger ของ charges';

create index gang_incomes_gang_occurred_idx on public.gang_incomes (gang_id, occurred_on);
create index gang_incomes_session_idx       on public.gang_incomes (session_id);

create trigger gang_incomes_set_updated_at
  before update on public.gang_incomes
  for each row execute function public.set_updated_at();
