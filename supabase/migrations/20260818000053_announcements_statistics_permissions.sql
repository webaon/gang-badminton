-- 0053 / ADR-015 R-roles-2c: announcements + gang-wide statistics.
-- Shared permission helpers stay feature-neutral; statistics flag is enforced
-- only in the policy's delegated branch. Legacy admin and self-row access stay
-- unchanged, including flag-off behavior. No preset gains announcement.manage.
-- No new tables/grants; publish_announcement and all actor functions unchanged.
-- Rollback: remove statistics.view.all from bundles before restoring 0050's
-- allow-list and revalidating CHECK; restore policies from 0010/0031/0032.

create or replace function public.is_delegable_action(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_action = any (array[
      'payment.verify', 'credit.read.other', 'credit.overpayment.record', 'credit.payout.record',
      'credit.return_charge', 'credit.topup', 'gang.finance.view', 'gang.finance.manage', 'billing.close',
      'session.create', 'session.update', 'session.transition', 'session.invite.manage',
      'registration.create.other', 'registration.create.guest', 'registration.cancel.other',
      'registration.promote.other', 'registration.checkin', 'registration.no_show', 'game.manage',
      'announcement.manage', 'statistics.view.all'
    ]::text[]),
    false
  );
$$;
comment on function public.is_delegable_action(text) is
  '[ADR-015] Closed delegable list matches DELEGABLE_ACTIONS, including statistics.view.all (Q6).';

-- Revalidate CHECK after widening its immutable predicate.
alter table public.gang_roles drop constraint gang_roles_permissions_delegable;
alter table public.gang_roles add constraint gang_roles_permissions_delegable
  check (public.permissions_are_delegable(permissions));

update public.gang_roles
set permissions = array_append(permissions, 'statistics.view.all')
where gang_id is null and is_system and key = 'scheduler' and deleted_at is null
  and not ('statistics.view.all' = any(permissions));

-- No existing preset has announcement.manage, so preset access stays unchanged.
drop policy announcements_select_member on public.announcements;
create policy announcements_select_member on public.announcements
for select to authenticated
using (
  (select public.is_gang_member(gang_id))
  and (published_at is not null
       or gang_id = any ((select public.gangs_with_permission('announcement.manage'))::uuid[]))
);

drop policy announcements_write_admin on public.announcements;
create policy announcements_write_admin on public.announcements
for all to authenticated
using (gang_id = any ((select public.gangs_with_permission('announcement.manage'))::uuid[]))
with check (gang_id = any ((select public.gangs_with_permission('announcement.manage'))::uuid[]));

-- Keep 0031 self/admin predicates verbatim. Added permission and feature sets
-- are uncorrelated InitPlans, evaluated once per statement, not per statistic row.
-- Feature lookup through gangs RLS works for active delegated members; orgAdmin
-- keeps its legacy branch even if parent gangs RLS hides the gang.
drop policy member_statistics_select on public.member_statistics;
create policy member_statistics_select on public.member_statistics
for select to authenticated
using (
  exists (
    select 1 from public.gang_members m
    where m.id = member_statistics.gang_member_id
      and m.user_id = (select auth.uid())
      and m.deleted_at is null
  )
  or (select public.is_gang_admin(gang_id))
  or (
    gang_id = any ((select public.gangs_with_permission('statistics.view.all'))::uuid[])
    and gang_id = any ((
      select array_agg(g.id) from public.gangs g
      where g.deleted_at is null and g.features @> '{"statistics":true}'::jsonb
    )::uuid[])
  )
);
comment on policy member_statistics_select on public.member_statistics is
  '[ADR-015 Q6] Self or legacy admin, or statistics.view.all AND statistics enabled (two uncorrelated InitPlans).';
