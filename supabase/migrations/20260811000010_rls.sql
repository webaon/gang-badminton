-- =============================================================================
-- WO-1.4 · 0010 — RLS + security definer helpers
-- =============================================================================
-- Baseline §RLS:
--   "Security definer functions (SET search_path) + policy เรียกแบบ (SELECT fn(...))
--    กัน recursion และ per-row overhead"
--   "ข้อมูลก๊วนอ่าน/เขียนเฉพาะสมาชิก, งานแอดมินเฉพาะ owner/admin (gang หรือ org),
--    ก๊วน public เปิดอ่าน metadata"
--   "Guest เขียนผ่าน DB function ที่ validate invite token — ไม่มี service-role endpoint เปิด"
--   "gang_line_configs server-only"
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 ทำไมไม่เกิด recursion
--
-- policy ของ `gang_members` เรียก `is_gang_member()` ซึ่งอ่าน `gang_members` เอง
-- ปกติจะวนไม่รู้จบ แต่ helper ทุกตัวเป็น **SECURITY DEFINER ที่ owner = postgres**
-- และ postgres มี BYPASSRLS ⇒ query ข้างในไม่ถูก policy ตรวจซ้ำ วงจรจึงขาด
--
-- ⚠️ ห้ามใส่ `ALTER TABLE ... FORCE ROW LEVEL SECURITY` กับตารางเหล่านี้
--    FORCE ทำให้ owner ถูก policy ตรวจด้วย ⇒ recursion กลับมาทันที
--    และ DB functions ของ WO-1.3 (definer เหมือนกัน) จะเขียนไม่ได้
--
-- ─────────────────────────────────────────────────────────────────────────────
-- รูปแบบการเขียน policy
--
-- เรียก helper แบบ `(select public.is_gang_member(gang_id))` เสมอ — วงเล็บทำให้
-- Postgres ประเมินเป็น InitPlan ครั้งเดียวต่อ query แทนที่จะเรียกใหม่ทุกแถว
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Deviation notes
--
--   D-12 baseline บอกแค่ "ข้อมูลก๊วนอ่าน/เขียนเฉพาะสมาชิก" แต่ไม่ได้บอกว่า
--        `profiles` เปิดให้ใครอ่าน — ถ้าเปิดหมดจะ enumerate ผู้ใช้ทั้งแพลตฟอร์มได้
--        ⇒ อ่านได้เฉพาะแถวตัวเอง + คนที่อยู่ก๊วนเดียวกัน (`shares_gang_with()`)
--
--   D-13 ตารางที่เขียนผ่าน DB function เท่านั้น (`session_registrations`,
--        `session_charges`, `event_logs`, `notifications` ฝั่ง insert) **ไม่มี policy
--        สำหรับ INSERT/UPDATE ให้ `authenticated` เลย** — ไม่ใช่ลืม แต่ตั้งใจ:
--        นี่คือกลไกที่ทำให้ "ห้าม check-then-act ใน TS" บังคับได้จริงระดับ DB
--        (ปิดช่องโหว่ข้อ 4 ที่ WO-1.3 เปิดค้างไว้: waitlist → confirmed ตรงๆ)
--
--   D-14 `sessions` INSERT ถูกบังคับ `status = 'draft'` ผ่าน WITH CHECK
--        ปิดช่องโหว่ข้อ 2 ของ WO-1.3 (GUC trigger คุมเฉพาะ UPDATE ไม่คุม INSERT)
--
-- Rollback: ALTER TABLE <ทุกตาราง> DISABLE ROW LEVEL SECURITY;
--           DROP POLICY ... (ทุกตัวในไฟล์นี้);
--           DROP FUNCTION public.is_gang_member(uuid), public.is_gang_admin(uuid),
--             public.is_org_member(uuid), public.shares_gang_with(uuid),
--             public.is_session_member(uuid), public.is_session_admin(uuid),
--             public.is_payment_visible(uuid);
-- =============================================================================


-- =============================================================================
-- ส่วนที่ 1 — security definer helpers
-- =============================================================================

-- -----------------------------------------------------------------------------
-- is_gang_member(gang_id)
-- -----------------------------------------------------------------------------
create or replace function public.is_gang_member(p_gang_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.gang_members gm
     where gm.gang_id    = p_gang_id
       and gm.user_id    = (select auth.uid())
       and gm.deleted_at is null
  );
$$;

comment on function public.is_gang_member(uuid) is
  'สมาชิกก๊วนนี้หรือไม่ (นับเฉพาะแถวที่ยังไม่ถูก soft delete) — definer เพื่อกัน recursion';


-- -----------------------------------------------------------------------------
-- is_org_member(org_id)
-- -----------------------------------------------------------------------------
create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members om
     where om.org_id  = p_org_id
       and om.user_id = (select auth.uid())
  );
$$;

comment on function public.is_org_member(uuid) is
  'สมาชิกองค์กรนี้หรือไม่ — organization_members มีเฉพาะ role owner/admin อยู่แล้ว';


-- -----------------------------------------------------------------------------
-- is_gang_admin(gang_id)
-- -----------------------------------------------------------------------------
-- baseline: "งานแอดมินเฉพาะ owner/admin (gang หรือ org)"
-- ⇒ แอดมินขององค์กรที่เป็นเจ้าของก๊วน มีสิทธิ์แอดมินในก๊วนนั้นด้วย
create or replace function public.is_gang_admin(p_gang_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.gang_members gm
     where gm.gang_id    = p_gang_id
       and gm.user_id    = (select auth.uid())
       and gm.deleted_at is null
       and gm.role       in ('owner', 'admin')
  )
  or exists (
    select 1
      from public.gangs g
      join public.organization_members om on om.org_id = g.org_id
     where g.id         = p_gang_id
       and g.deleted_at is null
       and om.user_id   = (select auth.uid())
  );
$$;

comment on function public.is_gang_admin(uuid) is
  'owner/admin ของก๊วน หรือ owner/admin ขององค์กรที่เป็นเจ้าของก๊วนนั้น';


-- -----------------------------------------------------------------------------
-- shares_gang_with(user_id) — [D-12]
-- -----------------------------------------------------------------------------
create or replace function public.shares_gang_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.gang_members me
      join public.gang_members them on them.gang_id = me.gang_id
     where me.user_id      = (select auth.uid())
       and me.deleted_at   is null
       and them.user_id    = p_user_id
       and them.deleted_at is null
  );
$$;

comment on function public.shares_gang_with(uuid) is
  '[D-12] อยู่ก๊วนเดียวกันหรือไม่ — ใช้จำกัดการอ่าน profiles ไม่ให้ enumerate ผู้ใช้ทั้งแพลตฟอร์ม';


-- -----------------------------------------------------------------------------
-- is_session_member / is_session_admin — ตารางที่ผูกกับก๊วนผ่าน session
-- -----------------------------------------------------------------------------
create or replace function public.is_session_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.sessions s
     where s.id         = p_session_id
       and s.deleted_at is null
       and public.is_gang_member(s.gang_id)
  );
$$;

create or replace function public.is_session_admin(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.sessions s
     where s.id         = p_session_id
       and s.deleted_at is null
       and public.is_gang_admin(s.gang_id)
  );
$$;


-- -----------------------------------------------------------------------------
-- is_payment_visible(payment_id) — เจ้าของสลิป หรือแอดมินก๊วนนั้น
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
         or public.is_gang_admin(p.gang_id)
       )
  );
$$;


-- =============================================================================
-- ส่วนที่ 2 — เปิด RLS ทุกตารางใน public
-- =============================================================================
-- เปิดก่อนแล้วค่อยใส่ policy: ตารางที่ "ไม่มี policy" = ปฏิเสธทุกอย่างโดยปริยาย
-- ซึ่งเป็น default ที่ต้องการสำหรับตาราง server-only
alter table public.announcements          enable row level security;
alter table public.coupons                enable row level security;
alter table public.daily_metrics          enable row level security;
alter table public.event_logs             enable row level security;
alter table public.games                  enable row level security;
alter table public.gang_expenses          enable row level security;
alter table public.gang_incomes           enable row level security;
alter table public.gang_line_configs      enable row level security;
alter table public.gang_members           enable row level security;
alter table public.gang_pricing_plans     enable row level security;
alter table public.gang_skill_levels      enable row level security;
alter table public.gangs                  enable row level security;
alter table public.join_requests          enable row level security;
alter table public.member_line_links      enable row level security;
alter table public.member_statistics      enable row level security;
alter table public.notification_logs      enable row level security;
alter table public.notifications          enable row level security;
alter table public.organization_members   enable row level security;
alter table public.organizations          enable row level security;
alter table public.payment_adjustments    enable row level security;
alter table public.payment_allocations    enable row level security;
alter table public.payments               enable row level security;
alter table public.profiles               enable row level security;
alter table public.rate_limits            enable row level security;
alter table public.session_charges        enable row level security;
alter table public.session_invite_tokens  enable row level security;
alter table public.session_registrations  enable row level security;
alter table public.session_templates      enable row level security;
alter table public.sessions               enable row level security;


-- =============================================================================
-- ส่วนที่ 3 — ตาราง server-only (เปิด RLS แล้วไม่ใส่ policy เลย)
-- =============================================================================
-- 🔴 gang_line_configs — baseline สั่ง "server-only" ตรงๆ
--    เก็บ Vault secret id ⇒ สมาชิกธรรมดา **และแม้แต่แอดมินก๊วน** อ่านผ่าน client ไม่ได้
--    ต้องผ่าน server (service_role) เท่านั้น
-- 🔴 daily_metrics — ตัวเลขระดับแพลตฟอร์ม ไม่ใช่ข้อมูลของก๊วนไหน
-- 🔴 rate_limits   — counter ภายใน
--
-- ทั้งสามตารางไม่มี CREATE POLICY โดยเจตนา ห้ามเพิ่มโดยไม่ทบทวน baseline ก่อน


-- =============================================================================
-- ส่วนที่ 4 — policies
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles — [D-12]
-- -----------------------------------------------------------------------------
create policy profiles_select_self_or_gangmate on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select public.shares_gang_with(id))
  );

create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- organizations / organization_members
-- -----------------------------------------------------------------------------
create policy organizations_select_member on public.organizations
  for select to authenticated
  using ((select public.is_org_member(id)));

create policy organizations_insert_self_owned on public.organizations
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy organizations_update_member on public.organizations
  for update to authenticated
  using ((select public.is_org_member(id)))
  with check ((select public.is_org_member(id)));

create policy organization_members_select on public.organization_members
  for select to authenticated
  using ((select public.is_org_member(org_id)));

-- คนที่เพิ่งสร้าง org ต้องเพิ่มตัวเองเป็น owner ได้ (ตอนนั้นยังไม่เป็นสมาชิก)
create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (
    (select public.is_org_member(org_id))
    or user_id = (select auth.uid())
  );

create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using ((select public.is_org_member(org_id)));


-- -----------------------------------------------------------------------------
-- gangs — สมาชิกอ่านได้ / ก๊วน public เปิดอ่าน metadata (discovery)
-- -----------------------------------------------------------------------------
create policy gangs_select_member on public.gangs
  for select to authenticated
  using (deleted_at is null and (select public.is_gang_member(id)));

-- baseline §RLS "ก๊วน public เปิดอ่าน metadata" — anon ก็เห็นได้ (หน้า discovery)
create policy gangs_select_public on public.gangs
  for select to anon, authenticated
  using (deleted_at is null and is_public = true);

create policy gangs_insert_org_member on public.gangs
  for insert to authenticated
  with check ((select public.is_org_member(org_id)));

create policy gangs_update_admin on public.gangs
  for update to authenticated
  using (deleted_at is null and (select public.is_gang_admin(id)))
  with check ((select public.is_gang_admin(id)));


-- -----------------------------------------------------------------------------
-- gang_members
-- -----------------------------------------------------------------------------
create policy gang_members_select on public.gang_members
  for select to authenticated
  using (deleted_at is null and (select public.is_gang_member(gang_id)));

create policy gang_members_insert_admin on public.gang_members
  for insert to authenticated
  with check ((select public.is_gang_admin(gang_id)));

create policy gang_members_update_admin on public.gang_members
  for update to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));


-- -----------------------------------------------------------------------------
-- ตารางตั้งค่าของก๊วน — สมาชิกอ่าน / แอดมินเขียน
-- -----------------------------------------------------------------------------
create policy gang_skill_levels_select on public.gang_skill_levels
  for select to authenticated using ((select public.is_gang_member(gang_id)));
create policy gang_skill_levels_write on public.gang_skill_levels
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));

create policy gang_pricing_plans_select on public.gang_pricing_plans
  for select to authenticated using ((select public.is_gang_member(gang_id)));
create policy gang_pricing_plans_write on public.gang_pricing_plans
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));

create policy session_templates_select on public.session_templates
  for select to authenticated using ((select public.is_gang_member(gang_id)));
create policy session_templates_write on public.session_templates
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));

create policy coupons_select on public.coupons
  for select to authenticated using ((select public.is_gang_member(gang_id)));
create policy coupons_write on public.coupons
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));

-- รายรับ-รายจ่ายของก๊วนเป็นข้อมูลการเงิน — แอดมินเท่านั้น ไม่ใช่สมาชิกทั่วไป
create policy gang_expenses_admin on public.gang_expenses
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));

create policy gang_incomes_admin on public.gang_incomes
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));

create policy announcements_select_member on public.announcements
  for select to authenticated using ((select public.is_gang_member(gang_id)));
create policy announcements_write_admin on public.announcements
  for all to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));


-- -----------------------------------------------------------------------------
-- sessions — [D-14] INSERT ได้เฉพาะ status = 'draft'
-- -----------------------------------------------------------------------------
create policy sessions_select_member on public.sessions
  for select to authenticated
  using (deleted_at is null and (select public.is_gang_member(gang_id)));

-- 🔴 ปิดช่องโหว่ WO-1.3 ข้อ 2: GUC trigger คุมเฉพาะ UPDATE
--    ถ้าไม่บังคับตรงนี้ จะ insert นัดใหม่ที่ status = 'settled' ข้าม state machine ได้เลย
create policy sessions_insert_admin_draft_only on public.sessions
  for insert to authenticated
  with check (
    (select public.is_gang_admin(gang_id))
    and status = 'draft'
  );

-- เปลี่ยน status ยังถูก BEFORE UPDATE trigger บล็อกอยู่ดี (ต้องผ่าน transition_session)
create policy sessions_update_admin on public.sessions
  for update to authenticated
  using (deleted_at is null and (select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));


-- -----------------------------------------------------------------------------
-- session_registrations — [D-13] อ่านได้ เขียนไม่ได้
-- -----------------------------------------------------------------------------
-- 🔴 ไม่มี policy INSERT/UPDATE/DELETE โดยเจตนา
--    ทุกการเขียนต้องผ่าน register_to_session / cancel_registration /
--    promote_waitlist / check_in_registration (security definer → bypass RLS)
--    นี่คือสิ่งที่ทำให้ "waitlist → confirmed ผ่าน promote_waitlist() เท่านั้น"
--    เป็นกติกาที่ DB บังคับเอง ไม่ใช่แค่ข้อตกลงในเอกสาร
create policy session_registrations_select on public.session_registrations
  for select to authenticated
  using (deleted_at is null and (select public.is_session_member(session_id)));


-- -----------------------------------------------------------------------------
-- session_invite_tokens — แอดมินเท่านั้น (เก็บ hash ของ secret)
-- -----------------------------------------------------------------------------
create policy session_invite_tokens_admin on public.session_invite_tokens
  for all to authenticated
  using ((select public.is_session_admin(session_id)))
  with check ((select public.is_session_admin(session_id)));


-- -----------------------------------------------------------------------------
-- games — สมาชิกดูกระดานคิว / แอดมินจัดคู่+นับลูก
-- -----------------------------------------------------------------------------
create policy games_select_member on public.games
  for select to authenticated
  using ((select public.is_session_member(session_id)));

create policy games_write_admin on public.games
  for all to authenticated
  using ((select public.is_session_admin(session_id)))
  with check ((select public.is_session_admin(session_id)));


-- -----------------------------------------------------------------------------
-- session_charges — [D-13] อ่านอย่างเดียว
-- -----------------------------------------------------------------------------
-- ADR-001: charges ประเภท session เกิดได้จาก close_session_with_charges() เท่านั้น
-- ⇒ ไม่มี policy เขียนให้ client เด็ดขาด
create policy session_charges_select on public.session_charges
  for select to authenticated
  using (
    (select public.is_gang_admin(gang_id))
    or exists (
      select 1
        from public.session_registrations r
       where r.id      = session_charges.registration_id
         and r.user_id = (select auth.uid())
    )
    or exists (
      select 1
        from public.gang_members gm
       where gm.id      = session_charges.gang_member_id
         and gm.user_id = (select auth.uid())
    )
  );


-- -----------------------------------------------------------------------------
-- payments — เจ้าของ + แอดมินก๊วน
-- -----------------------------------------------------------------------------
create policy payments_select on public.payments
  for select to authenticated
  using (
    deleted_at is null
    and (
      payer_user_id = (select auth.uid())
      or (select public.is_gang_admin(gang_id))
    )
  );

create policy payments_insert_self on public.payments
  for insert to authenticated
  with check (
    payer_user_id = (select auth.uid())
    and (select public.is_gang_member(gang_id))
  );

-- อัปสลิปของตัวเองได้ / แอดมิน verify ได้
-- (status ยังถูก trigger บล็อกอยู่จนกว่าจะมี transition_payment() ใน Phase 2)
create policy payments_update on public.payments
  for update to authenticated
  using (
    deleted_at is null
    and (
      payer_user_id = (select auth.uid())
      or (select public.is_gang_admin(gang_id))
    )
  )
  with check (
    payer_user_id = (select auth.uid())
    or (select public.is_gang_admin(gang_id))
  );

create policy payment_allocations_select on public.payment_allocations
  for select to authenticated
  using ((select public.is_payment_visible(payment_id)));

create policy payment_adjustments_select on public.payment_adjustments
  for select to authenticated
  using (
    exists (
      select 1
        from public.session_charges sc
       where sc.id = payment_adjustments.session_charge_id
         and (select public.is_gang_admin(sc.gang_id))
    )
  );


-- -----------------------------------------------------------------------------
-- notifications — เจ้าของกระดิ่งเท่านั้น
-- -----------------------------------------------------------------------------
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (recipient_id = (select auth.uid()));

-- อัปเดตได้เฉพาะของตัวเอง (ใช้ mark read) — insert เป็นงานของ DB function/worker
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

create policy notification_logs_admin on public.notification_logs
  for select to authenticated
  using ((select public.is_gang_admin(gang_id)));


-- -----------------------------------------------------------------------------
-- event_logs — timeline ของก๊วน อ่านอย่างเดียว
-- -----------------------------------------------------------------------------
create policy event_logs_select_member on public.event_logs
  for select to authenticated
  using (gang_id is not null and (select public.is_gang_member(gang_id)));


-- -----------------------------------------------------------------------------
-- member_statistics / member_line_links / join_requests
-- -----------------------------------------------------------------------------
create policy member_statistics_select on public.member_statistics
  for select to authenticated
  using ((select public.is_gang_member(gang_id)));

create policy member_line_links_select on public.member_line_links
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.is_gang_admin(gang_id))
  );

create policy join_requests_select on public.join_requests
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.is_gang_admin(gang_id))
  );

create policy join_requests_insert_self on public.join_requests
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy join_requests_update_admin on public.join_requests
  for update to authenticated
  using ((select public.is_gang_admin(gang_id)))
  with check ((select public.is_gang_admin(gang_id)));


-- =============================================================================
-- ส่วนที่ 4.5 — table GRANT (ต้องมีคู่กับ policy เสมอ)
-- =============================================================================
-- 🔴 RLS กรอง "แถว" ได้ก็ต่อเมื่อ role มีสิทธิ์บน "ตาราง" ก่อน — เป็นสองด่านแยกกัน
--
-- โปรเจกต์นี้ default ACL ของ schema public ให้ anon/authenticated/service_role
-- แค่ `Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) **ไม่มี SELECT/INSERT/UPDATE/DELETE**
-- ⇒ ต่างจาก template ทั่วไปของ Supabase ที่ grant ทุกอย่างแล้วค่อยพึ่ง RLS ล้วน
--
-- ผลคือ deny-by-default ซึ่งดีกว่า แต่แปลว่า **policy ที่เขียนไว้ข้างบนจะไม่มีผลเลย
-- ถ้าไม่ grant ตรงนี้** และตารางที่ลืม grant = ใช้ไม่ได้เงียบๆ (error 42501 ตอน runtime)
--
-- กติกา: grant ให้ตรงกับ policy เป๊ะๆ — ตารางไหนไม่มี policy เขียน ห้าม grant เขียน

-- อ่านอย่างเดียว (เขียนผ่าน DB function เท่านั้น — [D-13])
grant select on public.session_registrations to authenticated;
grant select on public.session_charges       to authenticated;
grant select on public.event_logs            to authenticated;
grant select on public.member_statistics     to authenticated;
grant select on public.notification_logs     to authenticated;
grant select on public.payment_allocations   to authenticated;
grant select on public.payment_adjustments   to authenticated;
grant select on public.member_line_links     to authenticated;

-- อ่าน + เขียนบางส่วน
grant select, insert, update         on public.profiles             to authenticated;
grant select, insert, update         on public.organizations        to authenticated;
grant select, insert, delete         on public.organization_members to authenticated;
grant select, insert, update         on public.gangs                to authenticated;
grant select, insert, update         on public.gang_members         to authenticated;
grant select, insert, update         on public.sessions             to authenticated;
grant select, insert, update         on public.payments             to authenticated;
grant select, update                 on public.notifications        to authenticated;
grant select, insert, update         on public.join_requests        to authenticated;

-- ตารางที่แอดมินจัดการเต็ม (policy เป็น FOR ALL)
grant select, insert, update, delete on public.gang_skill_levels     to authenticated;
grant select, insert, update, delete on public.gang_pricing_plans    to authenticated;
grant select, insert, update, delete on public.session_templates     to authenticated;
grant select, insert, update, delete on public.coupons               to authenticated;
grant select, insert, update, delete on public.gang_expenses         to authenticated;
grant select, insert, update, delete on public.gang_incomes          to authenticated;
grant select, insert, update, delete on public.announcements         to authenticated;
grant select, insert, update, delete on public.games                 to authenticated;
grant select, insert, update, delete on public.session_invite_tokens to authenticated;

-- anon เห็นได้อย่างเดียวคือก๊วน public (หน้า discovery) — policy จำกัดแถวไว้แล้ว
grant select on public.gangs to anon;

-- service_role = ฝั่ง server ที่เชื่อถือได้ (มี BYPASSRLS อยู่แล้ว แต่ BYPASSRLS
-- ไม่ข้าม GRANT) ⇒ ต้อง grant ให้ครบ ไม่งั้น server action อ่านตารางตรงไม่ได้
grant select, insert, update, delete on all tables in schema public to service_role;

-- ⚠️ ตารางที่ **จงใจไม่ grant ให้ anon/authenticated**:
--    gang_line_configs · daily_metrics · rate_limits
--    (server-only — ดูส่วนที่ 3) เข้าถึงได้เฉพาะ service_role กับ definer functions


-- =============================================================================
-- ส่วนที่ 5 — ปิดช่องโหว่ EXECUTE grant (WO-1.3 ข้อ 1)
-- =============================================================================
-- ฟังก์ชัน WO-1.3 ทั้งหมดเป็น security definer (owner = postgres) ⇒ bypass RLS
-- ถ้าปล่อย EXECUTE ไว้ที่ PUBLIC ใครก็ตามที่มี anon key จะเรียกได้ทุกตัว
-- เช่น ยิง close_session_with_charges() ใส่ก๊วนคนอื่น
--
-- วิธี: revoke จาก public/anon/authenticated ทั้งหมดก่อน แล้ว grant กลับเฉพาะที่จำเป็น

revoke execute on function public.register_to_session(uuid, uuid, text, text, text, uuid, text)   from public, anon, authenticated;
revoke execute on function public.cancel_registration(uuid, uuid, text)                            from public, anon, authenticated;
revoke execute on function public.promote_waitlist(uuid, integer, uuid, text)                      from public, anon, authenticated;
revoke execute on function public.check_in_registration(uuid, uuid, text)                          from public, anon, authenticated;
revoke execute on function public.transition_session(uuid, text, uuid, text)                       from public, anon, authenticated;
revoke execute on function public.close_session_with_charges(uuid, jsonb, text, text, uuid, text)  from public, anon, authenticated;
revoke execute on function public.claim_notifications(integer)                                     from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, integer, interval)                        from public, anon, authenticated;

-- helper ที่ policy ใช้ — ต้องเรียกได้ ไม่งั้น policy ประเมินไม่ผ่าน
grant execute on function public.is_gang_member(uuid)      to anon, authenticated;
grant execute on function public.is_gang_admin(uuid)       to anon, authenticated;
grant execute on function public.is_org_member(uuid)       to anon, authenticated;
grant execute on function public.shares_gang_with(uuid)    to anon, authenticated;
grant execute on function public.is_session_member(uuid)   to anon, authenticated;
grant execute on function public.is_session_admin(uuid)    to anon, authenticated;
grant execute on function public.is_payment_visible(uuid)  to anon, authenticated;

-- ⚠️ ที่เหลือ (register/cancel/promote/check_in/transition/close/claim) เรียกได้เฉพาะ
--    service_role ⇒ **ต้องเรียกจาก server action เท่านั้น ห้ามเรียกจาก browser**
--    รวมถึง guest ด้วย: baseline บอก "ไม่มี service-role endpoint เปิด" หมายถึงไม่มี
--    endpoint ที่ปล่อย service key ออกไป ไม่ได้แปลว่า client เรียกฟังก์ชันตรงได้
--    ⇒ guest ลงชื่อผ่าน route handler ฝั่งเรา ที่ validate invite token + rate limit ก่อน
grant execute on function public.register_to_session(uuid, uuid, text, text, text, uuid, text)   to service_role;
grant execute on function public.cancel_registration(uuid, uuid, text)                            to service_role;
grant execute on function public.promote_waitlist(uuid, integer, uuid, text)                      to service_role;
grant execute on function public.check_in_registration(uuid, uuid, text)                          to service_role;
grant execute on function public.transition_session(uuid, text, uuid, text)                       to service_role;
grant execute on function public.close_session_with_charges(uuid, jsonb, text, text, uuid, text)  to service_role;
grant execute on function public.claim_notifications(integer)                                     to service_role;
grant execute on function public.check_rate_limit(text, integer, interval)                        to service_role;
