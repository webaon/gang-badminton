-- =============================================================================
-- 20260818000050 — WO-R-roles-1 (ADR-015 · ขั้น EXPAND): ชุดสิทธิ์ซ้อนบน role เดิม — ยังไม่มีใครใช้
-- =============================================================================
-- ADR-015 (Accepted): เพิ่ม "ชุดสิทธิ์" (role bundle) ให้สมาชิกทั่วไป (role='member') เช่น เหรัญญิก/ผู้จัดคิว
-- โดย **ไม่แทนที่** owner/admin/member — กติกา last-owner / leave / transfer / org admin ไม่เปลี่ยน
--
-- ขั้นนี้ = EXPAND ล้วน ๆ:
--   ✅ ตารางใหม่ gang_roles (preset ระบบ + รองรับ role ต่อก๊วนในเฟส 2) / gang_member_roles (สมาชิก ↔ ชุดสิทธิ์ m:n)
--   ✅ is_delegable_action / permissions_are_delegable — รายการ action ที่ "มอบได้" แบบปิด (allow-list)
--   ✅ has_gang_permission(gang, action) — ใช้ใน RLS · actor_has_permission(gang, actor, action) — ใช้ใน DB function
--   ✅ preset ระบบ 2 ชุด (Q2ก): treasurer (เหรัญญิก) / scheduler (ผู้จัดคิว)
--   ✅ assign_gang_role / revoke_gang_role (admin+owner เท่านั้น — Q4ก) + trigger ถอนชุดสิทธิ์เมื่อออกก๊วน/เลื่อนเป็น admin
--   ❌ ไม่แก้ policy เดิมสักตัว ไม่แก้ DB function เดิมสักตัว ⇒ role-matrix golden (R-roles-0) ต้องไม่เปลี่ยนช่องเดิม
--      (ยังไม่มี policy/function ไหนเรียก has_gang_permission — ผู้ถือชุดสิทธิ์จึง "ยังไม่ได้สิทธิ์อะไรเพิ่ม" ในระดับ DB;
--       การ migrate policy ทีละกลุ่มคือ R-roles-2)
--
-- 🔴 หลักการ
--   1. has_gang_permission ⊇ is_gang_admin เสมอ (admin/owner/แอดมินองค์กร ผ่านทุก action) ⇒ เปลี่ยน policy ภายหลังไม่ทำใครเสียสิทธิ์
--   2. ชื่อ action = ชื่อเดียวกับ can() ใน domain/permissions (ไม่มีคำศัพท์ capability ชุดที่สอง) · รายการอยู่ที่
--      domain/permissions/delegable.ts ↔ is_delegable_action() — มีเทสต์เทียบสองฝั่ง
--   3. ห้าม delegate: gang.member.manage / gang.ownership.transfer / gang.update / gang.line.manage / gang.join_request.manage /
--      gang.pricing.manage / gang.skill.manage — CHECK ที่ gang_roles ปฏิเสธต่อให้ใส่มาตรง ๆ (กัน escalation)
--   4. ตารางใหม่เขียนได้ทาง DB function (SECURITY DEFINER) เท่านั้น — authenticated/service_role มีแค่ SELECT
--   5. มอบให้ได้เฉพาะ role='member' · ออกจากก๊วน/ถูกเลื่อนเป็น admin|owner ⇒ ชุดสิทธิ์ถูกถอนใน txn เดียวกัน (trigger บน gang_members
--      — ครอบทุกเส้นทาง: leave_gang, transfer_gang_ownership, UPDATE ตรงโดยแอดมิน)
--   6. ลำดับ lock: gang_members (ทั้งก๊วน order by id — เหมือน leave_gang) → gang_member_roles · ไม่ล็อกย้อนกลับ
--
-- ROLLBACK (ก่อนมีใครใช้ — ขั้นนี้ไม่มี policy/function เดิมพึ่งพา):
--   DROP TRIGGER gang_members_revoke_roles ON public.gang_members;
--   DROP FUNCTION public.gang_members_revoke_roles(), public.assign_gang_role(uuid, uuid, text, uuid, text),
--     public.revoke_gang_role(uuid, uuid, text, uuid, text), public.has_gang_permission(uuid, text),
--     public.actor_has_permission(uuid, uuid, text), public.gang_member_roles_guard();
--   DROP TABLE public.gang_member_roles; DROP TABLE public.gang_roles;
--   DROP FUNCTION public.permissions_are_delegable(text[]), public.is_delegable_action(text);
--   DROP INDEX public.gang_members_id_gang_user_key;
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. รายการ action ที่ delegate ได้ (allow-list ปิด) — ต้องตรง domain/permissions/delegable.ts
-- -----------------------------------------------------------------------------
create or replace function public.is_delegable_action(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_action = any (array[
      -- การเงิน
      'payment.verify', 'credit.read.other', 'credit.overpayment.record', 'credit.payout.record',
      'credit.return_charge', 'credit.topup', 'gang.finance.view', 'gang.finance.manage', 'billing.close',
      -- จัดนัด / ลงชื่อ / วันเล่น
      'session.create', 'session.update', 'session.transition', 'session.invite.manage',
      'registration.create.other', 'registration.create.guest', 'registration.cancel.other',
      'registration.promote.other', 'registration.checkin', 'registration.no_show', 'game.manage',
      -- อื่นๆ
      'announcement.manage'
    ]::text[]),
    false
  );
$$;

comment on function public.is_delegable_action(text) is
  '[ADR-015] action ที่มอบให้สมาชิกผ่านชุดสิทธิ์ได้ (allow-list ปิด) — ต้องตรง domain/permissions/delegable.ts (มีเทสต์เทียบ)';

create or replace function public.permissions_are_delegable(p_permissions text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_permissions is not null
     and cardinality(p_permissions) between 1 and 64
     and not exists (
       select 1 from unnest(p_permissions) a where a is null or not public.is_delegable_action(a)
     )
     -- ไม่มีค่าซ้ำ
     and cardinality(p_permissions) = (select count(distinct a) from unnest(p_permissions) a);
$$;

comment on function public.permissions_are_delegable(text[]) is
  '[ADR-015] ใช้ใน CHECK ของ gang_roles.permissions — ว่างไม่ได้ ซ้ำไม่ได้ ทุกตัวต้อง is_delegable_action';

revoke execute on function public.is_delegable_action(text)        from public, anon;
revoke execute on function public.permissions_are_delegable(text[]) from public, anon;
grant  execute on function public.is_delegable_action(text)        to authenticated, service_role;
grant  execute on function public.permissions_are_delegable(text[]) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. gang_roles — ชุดสิทธิ์ (preset ระบบ: gang_id null · ต่อก๊วน: เฟส 2)
-- -----------------------------------------------------------------------------
create table public.gang_roles (
  id          uuid        primary key default public.uuid_generate_v7(),
  gang_id     uuid        references public.gangs (id) on delete cascade,
  key         text        not null check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name        text        not null check (char_length(btrim(name)) between 1 and 60),
  permissions text[]      not null,
  is_system   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid        references public.profiles (id),
  deleted_at  timestamptz,
  deleted_by  uuid        references public.profiles (id),

  -- gang_id null ⇔ preset ระบบ (ทุกก๊วนใช้ร่วม แก้ไม่ได้ผ่านแอป)
  constraint gang_roles_system_shape check (is_system = (gang_id is null)),
  -- 🔴 กัน escalation: permissions ต้องเป็น action ที่ delegate ได้เท่านั้น (ว่างไม่ได้ ซ้ำไม่ได้)
  constraint gang_roles_permissions_delegable check (public.permissions_are_delegable(permissions))
);

comment on table public.gang_roles is
  '[ADR-015] ชุดสิทธิ์ซ้อนบน role พื้นฐาน — permissions เก็บชื่อ action เดียวกับ can() · เขียนผ่าน migration/DB function เท่านั้น';

create unique index gang_roles_system_key on public.gang_roles (key)
  where gang_id is null and deleted_at is null;
create unique index gang_roles_gang_key on public.gang_roles (gang_id, key)
  where gang_id is not null and deleted_at is null;

create trigger gang_roles_set_updated_at
  before update on public.gang_roles
  for each row execute function public.set_updated_at();

-- preset ระบบ 2 ชุด (Q2ก) — ต้องตรง ROLE_PRESETS ใน domain/permissions/delegable.ts
insert into public.gang_roles (gang_id, key, name, permissions, is_system)
values
  (null, 'treasurer', 'เหรัญญิก', array[
     'payment.verify', 'credit.read.other', 'credit.overpayment.record', 'credit.payout.record',
     'credit.return_charge', 'gang.finance.view', 'gang.finance.manage'
   ]::text[], true),
  (null, 'scheduler', 'ผู้จัดคิว', array[
     'session.create', 'session.update', 'session.transition', 'session.invite.manage',
     'registration.create.other', 'registration.create.guest', 'registration.cancel.other',
     'registration.promote.other', 'registration.checkin', 'registration.no_show', 'game.manage'
   ]::text[], true)
on conflict (key) where gang_id is null and deleted_at is null do nothing;


-- -----------------------------------------------------------------------------
-- 3. gang_member_roles — สมาชิก ↔ ชุดสิทธิ์ (m:n · soft delete)
-- -----------------------------------------------------------------------------
-- composite FK (id, gang_id, user_id) ⇒ แถวนี้ไม่มีทางชี้ไปสมาชิกของอีกก๊วน/อีกคนได้ (denormalize เพื่อให้ RLS ไม่ต้อง join)
create unique index gang_members_id_gang_user_key on public.gang_members (id, gang_id, user_id);

create table public.gang_member_roles (
  id             uuid        primary key default public.uuid_generate_v7(),
  gang_id        uuid        not null references public.gangs (id) on delete cascade,
  user_id        uuid        not null,
  gang_member_id uuid        not null,
  role_id        uuid        not null references public.gang_roles (id),
  assigned_by    uuid        references public.profiles (id),
  assigned_at    timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid        references public.profiles (id),
  -- revoked = แอดมินถอน · left_gang = สมาชิกออก · role_changed = ถูกเลื่อนเป็น admin/owner
  revoke_reason  text        check (revoke_reason in ('revoked', 'left_gang', 'role_changed')),

  constraint gang_member_roles_member_fk
    foreign key (gang_member_id, gang_id, user_id)
    references public.gang_members (id, gang_id, user_id) on delete cascade,
  constraint gang_member_roles_revoked_shape check ((deleted_at is null) = (revoke_reason is null))
);

comment on table public.gang_member_roles is
  '[ADR-015] มอบชุดสิทธิ์ให้สมาชิก — เฉพาะ role=member · เขียนผ่าน assign_gang_role/revoke_gang_role + trigger ถอนเมื่อออกก๊วน';

create unique index gang_member_roles_active_key
  on public.gang_member_roles (gang_member_id, role_id) where deleted_at is null;
-- has_gang_permission(): "ผู้ใช้นี้ในก๊วนนี้ถือชุดสิทธิ์อะไร"
create index gang_member_roles_lookup_idx
  on public.gang_member_roles (gang_id, user_id) where deleted_at is null;
create index gang_member_roles_role_idx on public.gang_member_roles (role_id);

-- ด่านสุดท้ายที่ชั้นตาราง (ต่อให้เขียนด้วยสิทธิ์สูง): มอบได้เฉพาะ member ที่ยังอยู่ · ชุดสิทธิ์ต้องเป็นของก๊วนนี้หรือ preset ระบบ
create or replace function public.gang_member_roles_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.gang_members;
  v_role   public.gang_roles;
begin
  select * into v_member from public.gang_members where id = new.gang_member_id;
  if not found or v_member.deleted_at is not null or v_member.role <> 'member' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'gang_member_id',
                                  'reason', 'มอบชุดสิทธิ์ได้เฉพาะสมาชิกทั่วไป (role=member) ที่ยังอยู่ในก๊วน')::text;
  end if;

  select * into v_role from public.gang_roles where id = new.role_id;
  if not found or v_role.deleted_at is not null
     or (v_role.gang_id is not null and v_role.gang_id <> new.gang_id) then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang_role', 'id', new.role_id)::text;
  end if;

  return new;
end;
$$;

create trigger gang_member_roles_guard
  before insert on public.gang_member_roles
  for each row execute function public.gang_member_roles_guard();


-- -----------------------------------------------------------------------------
-- 4. RLS + grants — อ่านผ่าน RLS · เขียนไม่ได้ทุก role (ผ่าน DB function เท่านั้น)
-- -----------------------------------------------------------------------------
alter table public.gang_roles        enable row level security;
alter table public.gang_member_roles enable row level security;

revoke all on public.gang_roles        from public, anon, authenticated, service_role;
revoke all on public.gang_member_roles from public, anon, authenticated, service_role;
grant select on public.gang_roles        to authenticated, service_role;
grant select on public.gang_member_roles to authenticated, service_role;

-- preset ระบบอ่านได้ทุกคนที่ล็อกอิน (ไม่ใช่ความลับ) · ชุดของก๊วนเห็นเฉพาะสมาชิก/แอดมินก๊วนนั้น
create policy gang_roles_select on public.gang_roles
  for select to authenticated
  using (
    deleted_at is null
    and (
      gang_id is null
      or (select public.is_gang_member(gang_id))
      or (select public.is_gang_admin(gang_id))
    )
  );

-- แอดมินเห็นทั้งก๊วน (รวมประวัติที่ถอนแล้ว) · สมาชิกเห็นเฉพาะที่ถืออยู่ของตัวเอง
create policy gang_member_roles_select on public.gang_member_roles
  for select to authenticated
  using (
    (select public.is_gang_admin(gang_id))
    or (
      user_id = (select auth.uid())
      and deleted_at is null
      and (select public.is_gang_member(gang_id))
    )
  );

comment on policy gang_roles_select on public.gang_roles is
  '[ADR-015] preset ระบบ (gang_id null) อ่านได้ทุกคนที่ล็อกอิน · ชุดของก๊วนเห็นเฉพาะสมาชิก/แอดมิน';
comment on policy gang_member_roles_select on public.gang_member_roles is
  '[ADR-015] แอดมินเห็นทั้งก๊วนรวมประวัติ · สมาชิกเห็นเฉพาะชุดที่ถืออยู่ของตัวเอง';


-- -----------------------------------------------------------------------------
-- 5. has_gang_permission / actor_has_permission — ตัวตัดสินตัวเดียว (ใช้ใน RLS และ DB function)
-- -----------------------------------------------------------------------------
-- = is_gang_admin (owner/admin/แอดมินองค์กร ผ่านทุก action) หรือ ถือชุดสิทธิ์ที่มี action นั้น (เฉพาะ action ที่ delegate ได้)
-- 🔴 ผู้ถือชุดสิทธิ์นับเฉพาะ role='member' ที่ยังอยู่ — แถวค้างของคนที่ถูกเลื่อน/ออกไม่มีผล (ถูกถอนด้วย trigger อยู่แล้ว · นี่คือสายรัดอีกชั้น)
create or replace function public.has_gang_permission(p_gang_id uuid, p_action text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select public.is_gang_admin(p_gang_id))
      or (
        public.is_delegable_action(p_action)
        and exists (
          select 1
            from public.gang_members gm
            join public.gang_member_roles gmr
              on gmr.gang_member_id = gm.id and gmr.deleted_at is null
            join public.gang_roles r
              on r.id = gmr.role_id and r.deleted_at is null
           where gm.gang_id    = p_gang_id
             and gm.user_id    = (select auth.uid())
             and gm.deleted_at is null
             and gm.role       = 'member'
             and p_action      = any (r.permissions)
        )
      );
$$;

comment on function public.has_gang_permission(uuid, text) is
  '[ADR-015] ผู้ใช้ปัจจุบัน (auth.uid()) ทำ action นี้ในก๊วนนี้ได้หรือไม่ = is_gang_admin หรือถือชุดสิทธิ์ที่มี action (เฉพาะที่ delegate ได้) — ⊇ is_gang_admin';

create or replace function public.actor_has_permission(p_gang_id uuid, p_actor_id uuid, p_action text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor_id is not null
     and (
       public.actor_is_gang_admin(p_gang_id, p_actor_id)
       or (
         public.is_delegable_action(p_action)
         and exists (
           select 1
             from public.gang_members gm
             join public.gang_member_roles gmr
               on gmr.gang_member_id = gm.id and gmr.deleted_at is null
             join public.gang_roles r
               on r.id = gmr.role_id and r.deleted_at is null
            where gm.gang_id    = p_gang_id
              and gm.user_id    = p_actor_id
              and gm.deleted_at is null
              and gm.role       = 'member'
              and p_action      = any (r.permissions)
         )
       )
     );
$$;

comment on function public.actor_has_permission(uuid, uuid, text) is
  '[ADR-015] เวอร์ชันรับ actor สำหรับ DB function ที่เรียกผ่าน service_role (แทน actor_is_gang_admin เมื่อ action นั้น delegate ได้) — ⊇ actor_is_gang_admin';

-- policy ต้องเรียกได้ (เหมือน is_gang_admin) · actor_has_permission รับ actor จากผู้เรียก ⇒ service_role เท่านั้น
revoke execute on function public.has_gang_permission(uuid, text)         from public, anon, authenticated;
revoke execute on function public.actor_has_permission(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.has_gang_permission(uuid, text)         to anon, authenticated, service_role;
grant  execute on function public.actor_has_permission(uuid, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- 6. assign_gang_role / revoke_gang_role — admin+owner เท่านั้น (Q4ก) · audit · idempotent
-- -----------------------------------------------------------------------------
-- ผู้ถือชุดสิทธิ์แต่งตั้งต่อไม่ได้ (gang.member.manage ไม่อยู่ใน delegable) · มอบให้ได้เฉพาะ role='member'
-- ลำดับ lock: gang_members ทั้งก๊วน (order by id — เหมือน leave_gang) ⇒ แข่งกับ leave/เลื่อน role/แต่งตั้งซ้ำ ต่อคิวกันได้ ไม่ deadlock
-- 🔴 อ่าน role ของเป้าหมาย "หลัง" ล็อก (READ COMMITTED: FOR UPDATE อ่านเวอร์ชันล่าสุด) ⇒ ไม่มอบให้คนที่เพิ่งถูกเลื่อนเป็น admin
create or replace function public.assign_gang_role(
  p_gang_id        uuid,
  p_user_id        uuid,
  p_role_key       text,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns public.gang_member_roles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key    text := lower(btrim(coalesce(p_role_key, '')));
  v_member public.gang_members;
  v_role   public.gang_roles;
  v_row    public.gang_member_roles;
begin
  if p_user_id is null or v_key = '' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', case when p_user_id is null then 'user_id' else 'role_key' end,
                                  'reason', 'ต้องระบุสมาชิกและชุดสิทธิ์')::text;
  end if;

  -- ด่านแรก (ก่อนล็อก ไม่ให้คนไม่มีสิทธิ์ถ่วงทั้งก๊วน)
  if not public.actor_is_gang_admin(p_gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่มอบชุดสิทธิ์ได้')::text;
  end if;

  perform 1
     from public.gang_members
    where gang_id    = p_gang_id
      and deleted_at is null
    order by id
      for update;

  -- ตรวจซ้ำหลังล็อก — สถานะของผู้เรียกนิ่งแล้ว
  if not public.actor_is_gang_admin(p_gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่มอบชุดสิทธิ์ได้')::text;
  end if;

  select * into v_member
    from public.gang_members
   where gang_id = p_gang_id and user_id = p_user_id and deleted_at is null;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_GANG_MEMBER',
      detail  = json_build_object('reason', 'มอบชุดสิทธิ์ได้เฉพาะสมาชิกที่ยังอยู่ในก๊วน')::text;
  end if;

  if v_member.role <> 'member' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', 'user_id',
                                  'reason', 'แอดมิน/โอเนอร์มีสิทธิ์ครบอยู่แล้ว — มอบชุดสิทธิ์ได้เฉพาะสมาชิกทั่วไป')::text;
  end if;

  -- ชุดของก๊วนนี้มาก่อน preset ระบบ (false เรียงก่อน true)
  select * into v_role
    from public.gang_roles
   where key = v_key
     and deleted_at is null
     and (gang_id is null or gang_id = p_gang_id)
   order by (gang_id is null)
   limit 1;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'NOT_FOUND',
      detail  = json_build_object('entity', 'gang_role', 'key', v_key)::text;
  end if;

  select * into v_row
    from public.gang_member_roles
   where gang_member_id = v_member.id and role_id = v_role.id and deleted_at is null;

  if found then
    return v_row;   -- มีอยู่แล้ว — เรียกซ้ำไม่สร้างแถว/ไม่เขียน audit ซ้ำ
  end if;

  insert into public.gang_member_roles (gang_id, user_id, gang_member_id, role_id, assigned_by)
  values (p_gang_id, p_user_id, v_member.id, v_role.id, p_actor_id)
  returning * into v_row;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'audit.role_assigned', 'member', v_member.id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'user_id',        p_user_id,
       'role_key',       v_role.key,
       'role_id',        v_role.id,
       'permissions',    to_jsonb(v_role.permissions)
     ));

  return v_row;
end;
$$;

comment on function public.assign_gang_role(uuid, uuid, text, uuid, text) is
  '[ADR-015] มอบชุดสิทธิ์ให้สมาชิก (role=member) — admin/owner เท่านั้น · FOR UPDATE gang_members ทั้งก๊วน · idempotent · audit.role_assigned';

create or replace function public.revoke_gang_role(
  p_gang_id        uuid,
  p_user_id        uuid,
  p_role_key       text,
  p_actor_id       uuid default null,
  p_correlation_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key     text := lower(btrim(coalesce(p_role_key, '')));
  v_row     public.gang_member_roles;
  v_role_id uuid;
begin
  if p_user_id is null or v_key = '' then
    raise exception using
      errcode = 'P0001', message = 'VALIDATION_ERROR',
      detail  = json_build_object('field', case when p_user_id is null then 'user_id' else 'role_key' end,
                                  'reason', 'ต้องระบุสมาชิกและชุดสิทธิ์')::text;
  end if;

  if not public.actor_is_gang_admin(p_gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่ถอนชุดสิทธิ์ได้')::text;
  end if;

  perform 1
     from public.gang_members
    where gang_id    = p_gang_id
      and deleted_at is null
    order by id
      for update;

  if not public.actor_is_gang_admin(p_gang_id, p_actor_id) then
    raise exception using
      errcode = 'P0001', message = 'FORBIDDEN',
      detail  = json_build_object('reason', 'เฉพาะแอดมินที่ถอนชุดสิทธิ์ได้')::text;
  end if;

  update public.gang_member_roles gmr
     set deleted_at    = now(),
         deleted_by    = p_actor_id,
         revoke_reason = 'revoked'
    from public.gang_roles r
   where gmr.gang_id    = p_gang_id
     and gmr.user_id    = p_user_id
     and gmr.deleted_at is null
     and r.id           = gmr.role_id
     and r.key          = v_key
  returning gmr.* into v_row;

  if not found then
    return false;   -- ไม่มีให้ถอน (ถอนไปแล้ว/ไม่เคยมี) — idempotent
  end if;

  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  values
    (p_gang_id, 'audit.role_revoked', 'member', v_row.gang_member_id, p_actor_id,
     jsonb_build_object(
       'correlation_id', p_correlation_id,
       'user_id',        p_user_id,
       'role_key',       v_key,
       'role_id',        v_row.role_id,
       'reason',         'revoked'
     ));

  return true;
end;
$$;

comment on function public.revoke_gang_role(uuid, uuid, text, uuid, text) is
  '[ADR-015] ถอนชุดสิทธิ์ (soft delete) — admin/owner เท่านั้น · idempotent · audit.role_revoked';

revoke execute on function public.assign_gang_role(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.revoke_gang_role(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant  execute on function public.assign_gang_role(uuid, uuid, text, uuid, text) to service_role;
grant  execute on function public.revoke_gang_role(uuid, uuid, text, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- 7. ออกจากก๊วน / ถูกเลื่อนเป็น admin|owner ⇒ ชุดสิทธิ์หลุดใน txn เดียวกัน
-- -----------------------------------------------------------------------------
-- trigger บน gang_members (ไม่แก้ leave_gang / transfer_gang_ownership เดิม) — ครอบทุกเส้นทางที่เปลี่ยน deleted_at/role
-- ทำงานหลังฟังก์ชันต้นทางล็อก gang_members แล้ว ⇒ ไม่เพิ่มลำดับ lock ใหม่
create or replace function public.gang_members_revoke_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if old.deleted_at is null and new.deleted_at is not null then
    v_reason := 'left_gang';
  elsif new.deleted_at is null and old.role = 'member' and new.role <> 'member' then
    v_reason := 'role_changed';
  else
    return new;
  end if;

  with revoked as (
    update public.gang_member_roles gmr
       set deleted_at    = now(),
           deleted_by    = coalesce(new.deleted_by, new.updated_by),
           revoke_reason = v_reason
     where gmr.gang_member_id = new.id
       and gmr.deleted_at is null
    returning gmr.role_id
  )
  insert into public.event_logs
    (gang_id, event_type, aggregate_type, aggregate_id, actor_id, payload)
  select new.gang_id, 'audit.role_revoked', 'member', new.id,
         coalesce(new.deleted_by, new.updated_by),
         jsonb_build_object(
           'user_id',  new.user_id,
           'role_key', r.key,
           'role_id',  r.id,
           'reason',   v_reason
         )
    from revoked rv
    join public.gang_roles r on r.id = rv.role_id;

  return new;
end;
$$;

comment on function public.gang_members_revoke_roles() is
  '[ADR-015] ถอนชุดสิทธิ์อัตโนมัติเมื่อสมาชิกออกก๊วน (left_gang) หรือถูกเลื่อนเป็น admin/owner (role_changed) — audit.role_revoked';

create trigger gang_members_revoke_roles
  after update of deleted_at, role on public.gang_members
  for each row execute function public.gang_members_revoke_roles();
