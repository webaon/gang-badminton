-- =============================================================================
-- WO-1.2 · 0003 — นัดเล่น (pricing / sessions / registrations / games)
-- =============================================================================
-- Baseline: §Database Schema → ตาราง → "นัดเล่น"
--
-- ⚠️ ตารางนี้ถูกอ่าน/เขียนโดย DB functions ใน WO-1.3 เท่านั้นสำหรับ flow ลงชื่อ:
--    register_to_session / cancel_registration / promote_waitlist / check_in_registration
--    app code ห้าม check-then-act เอง (baseline §การตัดสินใจสะสม — blocker)
--
-- ⚠️ "เต็ม" ไม่ใช่ state — derive จาก count(confirmed) >= max_players เสมอ
--    จึงไม่มีคอลัมน์ is_full โดยตั้งใจ
--
-- Rollback: DROP TABLE games, session_registrations, session_invite_tokens,
--           sessions, session_templates, gang_pricing_plans CASCADE;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- gang_pricing_plans
-- -----------------------------------------------------------------------------
create table public.gang_pricing_plans (
  id            uuid        primary key default public.uuid_generate_v7(),
  gang_id       uuid        not null references public.gangs (id) on delete cascade,
  name          text        not null,
  type          text        not null
                            check (type in ('flat_rate', 'court_plus_shuttle', 'monthly')),

  -- พารามิเตอร์ราคาแยกตาม type — เก็บเป็น jsonb เพราะแต่ละ type ใช้คีย์ต่างกัน
  -- flat_rate:          { "amount_per_person": "150.00" }
  -- court_plus_shuttle: { "court_fee_total": "800.00", "shuttle_price": "25.00" }
  -- monthly:            { "monthly_fee": "1200.00" }
  params        jsonb       not null default '{}'::jsonb,

  -- [v3] rounding policy — default: ปัดขึ้นเป็นหน่วยบาทต่อคน เศษเข้ารายรับก๊วน
  -- { "mode": "ceil_baht" | "ceil_satang" | "absorb", "surplus_to": "gang" }
  rounding_policy jsonb     not null default
    '{"mode": "ceil_baht", "surplus_to": "gang"}'::jsonb,

  -- [v3] กติกาสมาชิกรายเดือนเมื่อมาเล่นใน session
  -- ค่าสนาม = 0 เสมอ / ค่าลูก: true = คิดตามจริง (default), false = รวมในรายเดือน
  monthly_member_pays_shuttle boolean not null default true,

  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id),
  updated_by    uuid references public.profiles (id)
);

comment on table public.gang_pricing_plans is
  'โมเดลคิดเงินต่อก๊วน — ตอนสร้างนัดต้อง snapshot ทั้งก้อนลง sessions.snapshot';
comment on column public.gang_pricing_plans.rounding_policy is
  '[v3] blocker — invariant: sum(session_charges) − ต้นทุนจริง = surplus ตาม policy เสมอ';

create index gang_pricing_plans_gang_idx on public.gang_pricing_plans (gang_id, is_active);

create trigger gang_pricing_plans_set_updated_at
  before update on public.gang_pricing_plans
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- session_templates — นัดประจำสัปดาห์ (Phase 2.5 แต่ schema ลงตั้งแต่แรก)
-- -----------------------------------------------------------------------------
create table public.session_templates (
  id               uuid        primary key default public.uuid_generate_v7(),
  gang_id          uuid        not null references public.gangs (id) on delete cascade,
  name             text        not null,

  -- recurrence rule: { "days": [1,4], "start_time": "19:00", "end_time": "21:00" }
  -- แปลงเป็นเวลาจริงตาม gangs.timezone เสมอ (baseline §Timezone)
  recurrence       jsonb       not null,

  venue            text,
  court_count      integer     not null default 1 check (court_count > 0),
  court_labels     jsonb       not null default '[]'::jsonb,
  max_players      integer     not null check (max_players > 0),
  pricing_plan_id  uuid        references public.gang_pricing_plans (id) on delete set null,
  allow_guests     boolean     not null default true,
  is_active        boolean     not null default true,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles (id),
  updated_by       uuid references public.profiles (id)
);

comment on table public.session_templates is
  'Phase 2.5 — cron generate ล่วงหน้า 2 สัปดาห์ (idempotent). แก้ template = มีผลกับนัดที่ยังไม่ generate';

create index session_templates_gang_idx         on public.session_templates (gang_id, is_active);
create index session_templates_pricing_plan_idx on public.session_templates (pricing_plan_id);

create trigger session_templates_set_updated_at
  before update on public.session_templates
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- sessions
-- -----------------------------------------------------------------------------
-- [v3] ตัดตาราง courts ออก — ยังไม่ load-bearing จนกว่าจะทำ layout หลายสนาม
--      เก็บเป็น court_count + court_labels (jsonb) แทน
create table public.sessions (
  id              uuid        primary key default public.uuid_generate_v7(),
  gang_id         uuid        not null references public.gangs (id) on delete cascade,
  template_id     uuid        references public.session_templates (id) on delete set null,

  title           text,
  venue           text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,

  court_count     integer     not null default 1 check (court_count > 0),
  court_labels    jsonb       not null default '[]'::jsonb,
  max_players     integer     not null check (max_players > 0),
  allow_guests    boolean     not null default true,

  -- Session state machine (baseline §State Machines) — enforce ผ่าน transition_session() ใน WO-1.3
  --   draft → open → in_play → billing → settled → archived
  --   + draft/open → cancelled, in_play → cancelled, open → billing
  status          text        not null default 'draft'
                              check (status in ('draft', 'open', 'in_play', 'billing',
                                                'settled', 'archived', 'cancelled')),

  -- 🔴 Snapshot — บันทึกแช่แข็งทุกอย่างที่กระทบเงิน ณ ตอนสร้างนัด
  -- { snapshot_version, pricing_plan{...}, rounding_policy{...}, promptpay_id,
  --   cancellation_policy{...}, skill_levels[...] }
  -- ตอนคิดเงิน "อ่านจากที่นี่เสมอ" ห้ามอ่านค่าปัจจุบันจาก gangs / gang_pricing_plans
  snapshot        jsonb       not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  created_by      uuid references public.profiles (id),
  updated_by      uuid references public.profiles (id),
  deleted_by      uuid references public.profiles (id),

  constraint sessions_ends_after_starts check (ends_at > starts_at)
);

comment on table public.sessions is
  'นัดเล่น — "เต็ม" ไม่ใช่ state (derive จาก count(confirmed) >= max_players) จึงไม่มีคอลัมน์ is_full';
comment on column public.sessions.snapshot is
  '🔴 บันทึกแช่แข็ง: pricing plan + rounding policy + promptpay + cancellation policy + skill scale + snapshot_version. Billing อ่านจากที่นี่เท่านั้น';
comment on column public.sessions.status is
  'enforce ผ่าน transition_session() (WO-1.3) + BEFORE UPDATE trigger ที่เช็ค GUC app.allow_transition';

create index sessions_template_idx  on public.sessions (template_id);
-- composite นำหน้าด้วย tenant key ตาม query จริง (equality ก่อน range/sort)
create index sessions_gang_status_starts_idx
  on public.sessions (gang_id, status, starts_at) where deleted_at is null;
-- ปฏิทิน/รายการนัดของก๊วนตามช่วงเวลา
create index sessions_gang_starts_idx
  on public.sessions (gang_id, starts_at) where deleted_at is null;

create trigger sessions_set_updated_at
  before update on public.sessions
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- session_invite_tokens — [v3] ลิงก์เชิญต่อ session สำหรับ guest
-- -----------------------------------------------------------------------------
-- 🔴 [v3.2] secret ห้ามใช้ UUID ใดๆ (v7 ฝัง timestamp ⇒ เดาได้)
--    generate: gen_random_bytes(32) → base64url → เก็บเฉพาะ SHA-256 hash
--    validate: เทียบ hash — ห้าม log plaintext token
create table public.session_invite_tokens (
  id          uuid        primary key default public.uuid_generate_v7(),
  session_id  uuid        not null references public.sessions (id) on delete cascade,
  token_hash  bytea       not null,
  expires_at  timestamptz not null,
  max_uses    integer     not null default 1 check (max_uses > 0),
  used_count  integer     not null default 0 check (used_count >= 0),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id),

  constraint session_invite_tokens_hash_key unique (token_hash),
  constraint session_invite_tokens_uses_within_max check (used_count <= max_uses)
);

comment on table public.session_invite_tokens is
  '[v3.2] เก็บเฉพาะ SHA-256 hash ของ random 32 bytes — ห้ามใช้ PK/UUID เป็น token';

create index session_invite_tokens_session_idx on public.session_invite_tokens (session_id);


-- -----------------------------------------------------------------------------
-- session_registrations
-- -----------------------------------------------------------------------------
-- Registration state machine (baseline §State Machines):
--   waitlist → confirmed  (ผ่าน promote_waitlist() เท่านั้น)
--   confirmed → checked_in | cancelled | no_show
--   waitlist → cancelled
--   ❌ ห้าม waitlist → checked_in ตรง
create table public.session_registrations (
  id                       uuid        primary key default public.uuid_generate_v7(),
  session_id               uuid        not null references public.sessions (id) on delete cascade,

  -- user_id nullable = guest (ไม่มีบัญชี)
  -- ⚠️ on delete restrict (ไม่ใช่ set null) เพราะ CHECK ด้านล่างบังคับว่า
  --    user_id NULL ต้องมี guest_name — set null จะทำให้แถวเดิมผิด constraint ทันที
  --    และการลบผู้ใช้ที่มีประวัติเงินควรถูกบล็อกอยู่แล้ว (soft delete คือทางปกติ)
  user_id                  uuid        references public.profiles (id) on delete restrict,
  guest_name               text,
  guest_phone              text,

  -- [v3.2] signed URL ให้ guest ดู/ยกเลิกเอง — เก็บ hash เท่านั้น
  guest_access_token_hash  bytea,

  status                   text        not null default 'confirmed'
                                       check (status in ('confirmed', 'waitlist', 'cancelled',
                                                         'no_show', 'checked_in')),
  -- ลำดับใน waitlist — promote_waitlist() เรียงตาม ordering + reliability
  ordering                 integer     not null default 0,

  registered_by            uuid        references public.profiles (id) on delete set null,
  checked_in_at            timestamptz,
  cancelled_at             timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  created_by               uuid references public.profiles (id),
  updated_by               uuid references public.profiles (id),
  deleted_by               uuid references public.profiles (id),

  -- guest ต้องมีชื่อ / สมาชิกต้องมี user_id — อย่างใดอย่างหนึ่งเสมอ
  constraint session_registrations_user_or_guest check (
    (user_id is not null and guest_name is null)
    or (user_id is null and guest_name is not null)
  )
);

comment on table public.session_registrations is
  'การลงชื่อ — เขียนผ่าน DB functions เท่านั้น (register/cancel/promote/check_in) ห้าม check-then-act ใน TS';

-- [v3] soft delete + user_id nullable ⇒ partial unique ที่กัน NULL ด้วย
--      สมาชิกยกเลิกแล้วลงใหม่ต้องไม่ชน / guest หลายคนในนัดเดียวกันได้
create unique index session_registrations_session_user_active_key
  on public.session_registrations (session_id, user_id)
  where deleted_at is null and user_id is not null;

create index session_registrations_user_idx on public.session_registrations (user_id)
  where deleted_at is null;
create index session_registrations_registered_by_idx on public.session_registrations (registered_by);
create index session_registrations_guest_token_idx on public.session_registrations (guest_access_token_hash)
  where guest_access_token_hash is not null;

-- 🔴 index หลักของ flow ลงชื่อ: นับ confirmed / เลือกหัวคิว waitlist
--    (session_id, status, ordering) ตามที่ baseline ระบุตรงๆ
create index session_registrations_session_status_ordering_idx
  on public.session_registrations (session_id, status, ordering)
  where deleted_at is null;

create trigger session_registrations_set_updated_at
  before update on public.session_registrations
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- games — เกมต่อคอร์ท (ผู้เล่น 4 คนอ้าง registration id เพื่อรองรับ guest)
-- -----------------------------------------------------------------------------
create table public.games (
  id            uuid        primary key default public.uuid_generate_v7(),
  session_id    uuid        not null references public.sessions (id) on delete cascade,

  court_no      integer     not null check (court_no > 0),
  court_label   text,

  -- [v3] อ้าง registration ไม่ใช่ user — guest ก็ลงเกมได้
  -- ⚠️ ต้องเป็น cascade ไม่ใช่ restrict: ลบ session จะ cascade ไปทั้ง games และ
  --    session_registrations พร้อมกัน — restrict จะ error ทันทีที่แถว registration
  --    ถูกลบทั้งที่ game ที่อ้างถึงก็กำลังถูกลบในคำสั่งเดียวกัน
  player1_registration_id uuid not null references public.session_registrations (id) on delete cascade,
  player2_registration_id uuid not null references public.session_registrations (id) on delete cascade,
  player3_registration_id uuid not null references public.session_registrations (id) on delete cascade,
  player4_registration_id uuid not null references public.session_registrations (id) on delete cascade,

  shuttles_used numeric(10, 2) not null default 0 check (shuttles_used >= 0),

  started_at    timestamptz,
  ended_at      timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id),
  updated_by    uuid references public.profiles (id),

  constraint games_ends_after_starts check (ended_at is null or started_at is null or ended_at >= started_at),
  -- ผู้เล่น 4 คนต้องไม่ซ้ำกันเอง
  constraint games_distinct_players check (
    player1_registration_id <> player2_registration_id and
    player1_registration_id <> player3_registration_id and
    player1_registration_id <> player4_registration_id and
    player2_registration_id <> player3_registration_id and
    player2_registration_id <> player4_registration_id and
    player3_registration_id <> player4_registration_id
  )
);

comment on table public.games is
  'เกมต่อคอร์ท — shuttles_used เป็น numeric เพราะแบ่งลูกกันได้ (เงินทุกคอลัมน์ห้าม float)';

create index games_session_court_idx on public.games (session_id, court_no);
create index games_p1_idx on public.games (player1_registration_id);
create index games_p2_idx on public.games (player2_registration_id);
create index games_p3_idx on public.games (player3_registration_id);
create index games_p4_idx on public.games (player4_registration_id);

create trigger games_set_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();
