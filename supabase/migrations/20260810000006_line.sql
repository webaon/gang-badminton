-- =============================================================================
-- WO-1.2 · 0006 — LINE (optional ต่อก๊วน)
-- =============================================================================
-- Baseline: §Database Schema → ตาราง → "LINE (optional ต่อก๊วน)"
--
-- 🔴 ความปลอดภัย: credentials เก็บใน Supabase Vault — ตารางนี้เก็บ "เฉพาะ secret id"
--    ไม่เก็บค่า plaintext และไม่เก็บ key ใน DB (fallback AES-256-GCM ใช้ key จาก env)
--    RLS ของตารางนี้เป็น server-only (WO-1.4)
--
-- Rollback: DROP TABLE member_line_links, gang_line_configs CASCADE;
-- =============================================================================

create table public.gang_line_configs (
  id                        uuid        primary key default public.uuid_generate_v7(),
  gang_id                   uuid        not null references public.gangs (id) on delete cascade,

  -- ⚠️ เก็บเฉพาะ Vault secret id — ห้ามเก็บ token/secret plaintext ในตารางนี้
  channel_access_token_ref  text,
  channel_secret_ref        text,
  liff_id                   text,

  is_enabled                boolean     not null default false,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references public.profiles (id),
  updated_by                uuid references public.profiles (id),

  constraint gang_line_configs_gang_key unique (gang_id)
);

comment on table public.gang_line_configs is
  'server-only — เก็บเฉพาะ Vault secret id. webhook /api/line/webhook/[gangId] verify signature ด้วย secret ของก๊วนนั้น';
comment on column public.gang_line_configs.channel_access_token_ref is
  '⚠️ Vault secret id เท่านั้น — ห้ามเก็บ plaintext token';


create table public.member_line_links (
  id           uuid        primary key default public.uuid_generate_v7(),
  gang_id      uuid        not null references public.gangs (id)    on delete cascade,
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  line_user_id text        not null,
  linked_at    timestamptz not null default now(),

  -- หนึ่ง LINE user ต่อหนึ่งก๊วน ผูกได้กับบัญชีเดียว
  constraint member_line_links_gang_line_key unique (gang_id, line_user_id),
  constraint member_line_links_gang_user_key unique (gang_id, user_id)
);

comment on table public.member_line_links is 'ผูก LINE user กับบัญชีในระบบ ต่อก๊วน';

create index member_line_links_user_idx on public.member_line_links (user_id);
