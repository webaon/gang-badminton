-- =============================================================================
-- WO-1.2 · 0005 — แพลตฟอร์ม (discovery / announcements / queue / event log / rollup)
-- =============================================================================
-- Baseline: §Database Schema → ตาราง → "แพลตฟอร์ม"
--
-- Rollback: DROP TABLE member_statistics, daily_metrics, event_logs,
--           notification_logs, notifications, announcements, join_requests CASCADE;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- join_requests — ขอเข้าก๊วนจาก discovery
-- -----------------------------------------------------------------------------
create table public.join_requests (
  id           uuid        primary key default public.uuid_generate_v7(),
  gang_id      uuid        not null references public.gangs (id)    on delete cascade,
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  message      text,
  status       text        not null default 'pending'
                           check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_at   timestamptz,
  decided_by   uuid        references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.join_requests is 'Phase 3 Discovery — ขอเข้าก๊วน';

-- ขอซ้ำระหว่างที่ยังรออยู่ไม่ได้ แต่ขอใหม่หลังถูกปฏิเสธได้
create unique index join_requests_gang_user_pending_key
  on public.join_requests (gang_id, user_id)
  where status = 'pending';

create index join_requests_user_idx        on public.join_requests (user_id);
create index join_requests_decided_by_idx  on public.join_requests (decided_by);
create index join_requests_gang_status_idx on public.join_requests (gang_id, status, created_at);

create trigger join_requests_set_updated_at
  before update on public.join_requests
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- announcements
-- -----------------------------------------------------------------------------
create table public.announcements (
  id           uuid        primary key default public.uuid_generate_v7(),
  gang_id      uuid        not null references public.gangs (id) on delete cascade,
  title        text        not null,
  body         text        not null,
  image_urls   jsonb       not null default '[]'::jsonb,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id),
  updated_by   uuid references public.profiles (id)
);

create index announcements_gang_published_idx
  on public.announcements (gang_id, published_at desc);

create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- notifications — queue
-- -----------------------------------------------------------------------------
-- [v3] worker claim ด้วย FOR UPDATE SKIP LOCKED + เปลี่ยน status เป็น processing ก่อนส่ง
--      แถวค้าง processing เกิน N นาที ถูก sweep กลับเป็น pending (pg_cron)
-- [v3.1] retry exponential backoff ผ่าน next_retry_at (5 นาที → 15 นาที → 1 ชม.)
--        เกิน 3 ครั้ง = failed ถาวร
create table public.notifications (
  id            uuid        primary key default public.uuid_generate_v7(),
  gang_id       uuid        not null references public.gangs (id)    on delete cascade,
  recipient_id  uuid        references public.profiles (id)          on delete cascade,

  channel       text        not null check (channel in ('in_app', 'line')),
  event_type    text        not null,
  payload       jsonb       not null default '{}'::jsonb,

  status        text        not null default 'pending'
                            check (status in ('pending', 'processing', 'sent', 'failed')),

  scheduled_at  timestamptz not null default now(),
  claimed_at    timestamptz,
  sent_at       timestamptz,

  attempt       integer     not null default 0 check (attempt >= 0),
  last_error    text,
  next_retry_at timestamptz not null default now(),

  read_at       timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.notifications is
  '[v3] worker claim ด้วย SKIP LOCKED → processing → sent/failed. [v3.1] retry backoff ผ่าน next_retry_at';

-- 🔴 [v3.2] index สำหรับ worker query โดยเฉพาะ — partial WHERE status = 'pending'
--    worker หยิบเฉพาะ pending AND next_retry_at <= now()
create index notifications_pending_retry_idx
  on public.notifications (status, next_retry_at)
  where status = 'pending';

-- sweep แถวค้าง processing (pg_cron)
create index notifications_processing_claimed_idx
  on public.notifications (claimed_at)
  where status = 'processing';

-- Notification center: กระดิ่งของผู้ใช้ (ยังไม่อ่านก่อน)
create index notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc)
  where channel = 'in_app';

create index notifications_gang_idx on public.notifications (gang_id);

create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- notification_logs — ผลส่งจริง + counter โควต้า LINE ต่อก๊วนต่อเดือน
-- -----------------------------------------------------------------------------
create table public.notification_logs (
  id              uuid        primary key default public.uuid_generate_v7(),
  notification_id uuid        references public.notifications (id) on delete set null,
  gang_id         uuid        not null references public.gangs (id) on delete cascade,
  channel         text        not null check (channel in ('in_app', 'line')),
  success         boolean     not null,
  error_message   text,
  sent_at         timestamptz not null default now()
);

comment on table public.notification_logs is
  'ผลส่งจริง — นับโควต้า LINE ต่อก๊วนต่อเดือนจากตารางนี้ (usage counter ในหน้าตั้งค่า)';

create index notification_logs_notification_idx on public.notification_logs (notification_id);
-- นับโควต้า: ก๊วนนี้ ช่องทาง line เดือนนี้ส่งไปกี่ข้อความ
create index notification_logs_gang_channel_sent_idx
  on public.notification_logs (gang_id, channel, sent_at);


-- -----------------------------------------------------------------------------
-- event_logs — [v3] รวม audit ไว้ที่เดียว
-- -----------------------------------------------------------------------------
-- append-only. ไม่ใช่ event sourcing: state จริงอยู่ในตาราง ไม่มี replay
-- จึงไม่มีคอลัมน์ version (baseline §ADR "ไม่รับ")
create table public.event_logs (
  id             uuid        primary key default public.uuid_generate_v7(),
  gang_id        uuid        references public.gangs (id)    on delete cascade,
  session_id     uuid        references public.sessions (id) on delete cascade,

  -- event ธุรกิจ: 'registration.confirmed', 'waitlist.promoted', 'payment.verified', ...
  -- audit event: 'audit.*' เก็บ before/after ใน payload
  event_type     text        not null,

  -- [v3.1] query timeline ต่อ object ได้ตรง
  aggregate_type text        check (aggregate_type in ('session', 'game', 'payment',
                                                       'registration', 'gang', 'member')),
  aggregate_id   uuid,

  actor_id       uuid        references public.profiles (id) on delete set null,

  -- แนบ correlation_id ทุกครั้ง (baseline §Observability) — ตามบั๊กจาก UI ถึง DB ในเส้นเดียว
  payload        jsonb       not null default '{}'::jsonb,

  created_at     timestamptz not null default now()
);

comment on table public.event_logs is
  '[v3] append-only — event ธุรกิจ + audit (audit.* เก็บ before/after). ไม่ใช่ event sourcing จึงไม่มี version';
comment on column public.event_logs.payload is
  'ต้องมี correlation_id เสมอ (baseline §Observability)';

-- baseline ระบุ composite นี้ตรงๆ
create index event_logs_gang_type_created_idx
  on public.event_logs (gang_id, event_type, created_at);
-- [v3.1] timeline ต่อ object
create index event_logs_aggregate_idx
  on public.event_logs (aggregate_type, aggregate_id, created_at);
create index event_logs_session_created_idx on public.event_logs (session_id, created_at);
create index event_logs_actor_idx           on public.event_logs (actor_id);


-- -----------------------------------------------------------------------------
-- daily_metrics — [v3.1] rollup รายวันระดับแพลตฟอร์ม (Phase 3)
-- -----------------------------------------------------------------------------
create table public.daily_metrics (
  -- PK เป็น UUIDv7 ตามกติกา baseline (§Database Schema [v3.1]) — metric_date เป็น natural key
  id            uuid        primary key default public.uuid_generate_v7(),
  metric_date   date        not null unique,
  new_members   integer     not null default 0,
  games_played  integer     not null default 0,
  sessions_held integer     not null default 0,
  revenue       numeric(14, 2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.daily_metrics is
  '[v3.1] platform dashboard — insert โดย rollup job เดิม (Phase 3)';

create trigger daily_metrics_set_updated_at
  before update on public.daily_metrics
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- member_statistics — rollup รายคืน (แหล่งเดียวสำหรับการแสดงผลสถิติ)
-- -----------------------------------------------------------------------------
create table public.member_statistics (
  id                uuid        primary key default public.uuid_generate_v7(),
  gang_id           uuid        not null references public.gangs (id)        on delete cascade,
  gang_member_id    uuid        not null references public.gang_members (id) on delete cascade,

  attended_count    integer     not null default 0,
  games_count       integer     not null default 0,
  shuttles_used     numeric(10, 2) not null default 0,
  total_paid        numeric(14, 2) not null default 0,
  attendance_rate   numeric(5, 2)  not null default 0,

  computed_at       timestamptz not null default now(),

  constraint member_statistics_member_key unique (gang_member_id)
);

comment on table public.member_statistics is
  'rollup รายคืน — UI อ่านสถิติจากตารางนี้เท่านั้น (gang_members ไม่เก็บ counter)';

create index member_statistics_gang_idx on public.member_statistics (gang_id);
