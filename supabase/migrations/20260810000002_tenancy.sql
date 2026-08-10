-- =============================================================================
-- WO-1.2 · 0002 — Tenancy & คน
-- =============================================================================
-- Baseline: §Database Schema → ตาราง → "Tenancy & คน"
-- โครงสร้างชั้นข้อมูล: Organization → Gang → Session
--   auto-create personal org ตอนสร้างก๊วนแรก (logic อยู่ใน app — WO ถัดไป)
--
-- หมายเหตุการออกแบบ (ไม่ขัด baseline — baseline ไม่ได้ระบุ):
--   ใช้ text + CHECK constraint แทน enum type สำหรับคอลัมน์ประเภท/สถานะ
--   เหตุผล: เพิ่มค่าใหม่ = migration ธรรมดา ไม่ต้อง ALTER TYPE ADD VALUE
--   ซึ่งเข้ากับกติกา expand → migrate → contract ใน §Engineering Practices ได้ดีกว่า
--
-- Rollback: DROP TABLE gang_members, gang_skill_levels, gangs,
--           organization_members, organizations, profiles CASCADE;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles — ต่อจาก auth.users
-- -----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text        not null,
  phone         text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is 'ข้อมูลผู้ใช้ต่อจาก auth.users — id ตรงกับ auth.users.id';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default public.uuid_generate_v7(),
  name        text        not null,
  owner_id    uuid        not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id),
  updated_by  uuid references public.profiles (id)
);

comment on table public.organizations is
  'องค์กร — auto-create personal org ตอนผู้ใช้สร้างก๊วนแรก ผู้ใช้ไม่รับรู้จนมีก๊วนที่ 2';

create index organizations_owner_id_idx on public.organizations (owner_id);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- organization_members
-- -----------------------------------------------------------------------------
create table public.organization_members (
  id          uuid primary key default public.uuid_generate_v7(),
  org_id      uuid        not null references public.organizations (id) on delete cascade,
  user_id     uuid        not null references public.profiles (id)      on delete cascade,
  role        text        not null check (role in ('owner', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id),
  updated_by  uuid references public.profiles (id),

  -- ไม่มี soft delete บนตารางนี้ (ไม่อยู่ในลิสต์ baseline) → unique ธรรมดาพอ
  constraint organization_members_org_user_key unique (org_id, user_id)
);

comment on table public.organization_members is 'สมาชิกระดับองค์กร (owner/admin)';

create index organization_members_user_id_idx on public.organization_members (user_id);
-- composite นำหน้าด้วย tenant key ตาม query จริง: "สมาชิก role X ในองค์กรนี้"
create index organization_members_org_role_idx on public.organization_members (org_id, role);

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- gangs — tenant หลักของระบบ
-- -----------------------------------------------------------------------------
create table public.gangs (
  id                  uuid        primary key default public.uuid_generate_v7(),
  org_id              uuid        not null references public.organizations (id) on delete restrict,
  name                text        not null,
  description         text,
  area                text,
  is_public           boolean     not null default false,
  promptpay_id        text,
  timezone            text        not null default 'Asia/Bangkok',

  -- cancellation policy ปัจจุบันของก๊วน — snapshot ลง sessions ตอนสร้างนัด
  cancellation_policy jsonb       not null default '{}'::jsonb,

  -- การตั้งค่าทั่วไปของก๊วน
  settings            jsonb       not null default '{}'::jsonb,

  -- [v3.1] feature flags ต่อก๊วน: line, discovery, guests, coupons, statistics
  -- ⚠️ ต้อง enforce ฝั่ง server (can() + DB function) — ซ่อนปุ่มอย่างเดียว = flag ปลอม
  features            jsonb       not null default
    '{"line": false, "discovery": false, "guests": true, "coupons": false, "statistics": true}'::jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  created_by          uuid references public.profiles (id),
  updated_by          uuid references public.profiles (id),
  deleted_by          uuid references public.profiles (id)
);

comment on table public.gangs is 'ก๊วน — tenant หลัก ทุก query/policy ต้องกรอง deleted_at IS NULL';
comment on column public.gangs.features is
  '[v3.1] feature flags — enforce ฝั่ง server เสมอ (domain/permissions/can() + DB function)';
comment on column public.gangs.cancellation_policy is
  'policy ปัจจุบัน — ตอนสร้างนัดต้อง snapshot ลง sessions.snapshot ห้ามอ่านค่านี้ตอนคิดเงิน';

create index gangs_org_id_idx on public.gangs (org_id) where deleted_at is null;

-- discovery: ก๊วน public เท่านั้น (baseline §โมดูล ข้อ 9)
create index gangs_public_idx on public.gangs (is_public)
  where deleted_at is null and is_public = true;

-- [v3.1] pg_trgm — ค้นชื่อก๊วน/พื้นที่ (FTS ตัดคำไทยไม่ได้)
create index gangs_name_trgm_idx on public.gangs using gin (name extensions.gin_trgm_ops);
create index gangs_area_trgm_idx on public.gangs using gin (area extensions.gin_trgm_ops);

create trigger gangs_set_updated_at
  before update on public.gangs
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- gang_skill_levels — ระดับฝีมือ แต่ละก๊วนกำหนด scale เอง
-- -----------------------------------------------------------------------------
create table public.gang_skill_levels (
  id          uuid        primary key default public.uuid_generate_v7(),
  gang_id     uuid        not null references public.gangs (id) on delete cascade,
  label       text        not null,
  rank        integer     not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint gang_skill_levels_gang_rank_key unique (gang_id, rank)
);

comment on table public.gang_skill_levels is 'ระดับฝีมือต่อก๊วน — rank ใช้จัดลำดับใน Matching Engine (BalanceSkill)';

create index gang_skill_levels_gang_id_idx on public.gang_skill_levels (gang_id);

create trigger gang_skill_levels_set_updated_at
  before update on public.gang_skill_levels
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- gang_members
-- -----------------------------------------------------------------------------
-- [v3] ไม่เก็บ attendance counter — คำนวณจาก session_registrations / event_logs
--      UI อ่านจาก member_statistics rollup แทน (แหล่งเดียวสำหรับการแสดงผล)
create table public.gang_members (
  id                    uuid        primary key default public.uuid_generate_v7(),
  gang_id               uuid        not null references public.gangs (id)             on delete cascade,
  user_id               uuid        not null references public.profiles (id)          on delete cascade,
  role                  text        not null default 'member'
                                    check (role in ('owner', 'admin', 'member')),
  skill_level_id        uuid        references public.gang_skill_levels (id) on delete set null,

  -- สถานะสมาชิกรายเดือน — กติกาค่าสนาม/ค่าลูกอยู่ใน pricing plan (snapshot ตอนสร้างนัด)
  is_monthly_member     boolean     not null default false,
  monthly_member_since  date,
  monthly_member_until  date,

  joined_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  created_by            uuid references public.profiles (id),
  updated_by            uuid references public.profiles (id),
  deleted_by            uuid references public.profiles (id)
);

comment on table public.gang_members is
  'สมาชิกก๊วน — [v3] ไม่เก็บ attendance counter (คำนวณจาก registrations/event_logs)';

-- [v3] soft delete ⇒ partial unique: ออกจากก๊วนแล้วกลับเข้าใหม่ต้องไม่ชน
create unique index gang_members_gang_user_active_key
  on public.gang_members (gang_id, user_id)
  where deleted_at is null;

create index gang_members_user_id_idx       on public.gang_members (user_id)        where deleted_at is null;
create index gang_members_skill_level_idx   on public.gang_members (skill_level_id);
-- composite นำหน้าด้วย tenant key: "แอดมินของก๊วนนี้" / "สมาชิกทั้งหมดของก๊วนนี้"
create index gang_members_gang_role_idx     on public.gang_members (gang_id, role)  where deleted_at is null;
-- MembershipBilling รายเดือน: หาสมาชิกรายเดือน active ของก๊วน
create index gang_members_gang_monthly_idx  on public.gang_members (gang_id, is_monthly_member)
  where deleted_at is null and is_monthly_member = true;

create trigger gang_members_set_updated_at
  before update on public.gang_members
  for each row execute function public.set_updated_at();
