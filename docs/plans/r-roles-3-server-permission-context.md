# R-roles-3 Server Permission Context Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task only after a new planner work order. This document is a draft, NOT authorization to implement.

**Goal:** Load active gang bundles into `PermissionContext.extra` at trusted server boundaries so migrated DB permissions are usable through existing `can()` checks.

**Architecture:** Keep domain permissions pure. Introduce a server-only shared context loader using the authenticated Supabase client; preserve base gang/org roles and feature gates, merge only closed-list delegated actions from active assignments and roles. RLS/DB actor functions remain authority; do not add migrations, UI, role assignment endpoints, or legacy DB hardening in this WO.

**Tech Stack:** Next.js server actions, TypeScript, Supabase/PostgREST, Vitest, PostgreSQL fixtures.

## Preconditions / pause gate

- Planner explicitly releases the QA pause and assigns R-roles-3. Do not run this plan automatically after R-roles-2c.
- Confirm QA results for migrations 0050–0053 and cloud migration order (0047–0053 still pending when this draft was requested).
- Re-read STATE.md, CLAUDE.md, ADR-015 baseline amendment, BACKLOG.md, and current git status; shared-clone WIP must not be committed.
- Existing `can()` accepts optional `extra`; permission helpers remain feature-neutral. Resources enforce feature flags, not a global action→feature SQL helper.

## Confirmed current integration points

- Seven duplicated `roleInGang` loaders: `server/actions/{credit,gangs,members,membership,templates,payments,sessions}.ts`.
- Inline guards also occur in `server/actions/{announcements,billing,discovery,reports,registrations,payment-admin,game-console,line,gang-config,finance}.ts`.
- Read guards: `server/payments/admin-read.ts`, `server/sessions/console-loader.ts`.
- `server/actions/announcements.ts:29` currently loads gang membership and calls `assertCan` without `extra`.
- There is no `server/actions/statistics.ts` or `server/auth/context.ts`; do not invent an existing abstraction. Audit app server components for statistics reads and navigation context separately.
- Re-inventory at implementation time: earlier ADR counts are historical, not proof of current coverage.

## Task 1 — Freeze the integration inventory (test-only)

Files: create `tests/security/permission-context-coverage.test.ts` and a reviewed list of server guard sites in this plan.

1. Search server/app sources for `can(`, `assertCan(`, `roleInGang`, direct role checks, and `statistics.view`.
2. Classify each as tenant-scoped authorization, self-only path, public discovery, or org-level administration. Do not load gang bundles into public/org-only flows.
3. Write a source coverage test that flags unclassified old tenant guard patterns, but does not prescribe import spellings or match harmless comments.
4. Run `npx vitest run tests/security/permission-context-coverage.test.ts`; capture the RED list before integration.
5. Commit test/inventory only after planner review of scope. No production changes yet.

## Task 2 — Specify loader behavior before implementation

Files: create `tests/server/gang-permission-context.test.ts` and later `server/permissions/gang-context.ts`.

1. Write mocked query-contract tests for owner/admin/member/orgAdmin/outsider and feature flags.
2. Add member cases with treasurer, scheduler, both, duplicate permissions, deleted assignment, deleted role, departed member, foreign-gang role, and malformed permissions.
3. Assert explicit filters on gang_id, current actor user_id, and deleted_at. Use named FK embeds only after verifying actual FK names in the catalog.
4. Assert DB/query errors reject rather than silently enabling access, and unknown/nondelegable entries never enter `extra`.
5. Run `npx vitest run tests/server/gang-permission-context.test.ts` and save the RED result (loader missing).

## Task 3 — Implement the minimal server-only context loader

Files: create `server/permissions/gang-context.ts`; no imports added to domain from server/Next/Supabase.

Proposed interface (resolve naming in the WO):

```ts
export async function loadGangPermissionContext(
  gangId: string,
  actorId: string,
): Promise<PermissionContext>;
```

1. Actor comes from `requireUser()` or an already trusted server identity, never from submitted DTOs. Resolve resource→gang IDs using the established authorized entity lookup first.
2. Use `supabaseServer()` for membership, organization membership, gang features and active assignments. Preserve current org-admin semantics; do not infer ownership from an organization role.
3. Query active gang_member_roles joined to gang_roles, using explicit FK names and explicit tenant/user filters. Validate active gang membership before accepting extras.
4. Flatten/dedupe permissions through `isDelegableAction`. Return deterministic `extra`; retain base `role`, `orgRole`, and `features` unchanged.
5. No global/TTL cache: each action reloads current grants, so revocation is visible on the next action. Do not use service-role reads as a fallback to missing authorized rows.
6. Run the loader tests until GREEN, then typecheck/eslint. Commit this shared loader and its tests.

## Task 4 — Integrate finance guards in a small commit

Files: `server/actions/{credit,payments,payment-admin,finance,reports,billing}.ts`, `server/payments/admin-read.ts`; their existing tests plus new delegated-action tests.

1. Write RED action tests: treasurer gets only accepted finance actions; cannot close billing, top up, alter pricing, or access another gang.
2. Replace tenant-scoped role-only contexts with the shared loader. Preserve existing action names and all money/state-machine logic.
3. Keep resource lookup → tenant resolution → context/can check → mutation ordering. Untrusted gang IDs may not authorize a payment belonging to another gang.
4. Keep self-only payments/credit behavior unchanged; do not expose another payer's identity via wider reads.
5. Run relevant action and DB suites, inspect semantic permission diffs, typecheck/lint/build, then commit only owned files.

## Task 5 — Integrate sessions/game guards in a separate commit

Files: `server/actions/{sessions,registrations,game-console,templates}.ts`, `server/sessions/console-loader.ts`.

1. Write RED scheduler action tests for create/update/transition/invite/register-other/guest/cancel/promote/check-in/no-show/game operations.
2. Confirm guest/other feature gates still deny with flags off despite extras.
3. Replace guard contexts only; no seat counting, lock order, matching, billing, template schedule semantics, or transition changes.
4. **Blocking decision for the future WO:** templates.ts currently uses session.create at lines 78/187 and session.update at 114/156. Blindly supplying scheduler extras would enable templates, contradicting Q2ก. Keep these four guards explicitly exempt/unchanged until planner chooses a distinct nondelegable template action or another `can()`-based boundary. Do not add direct role checks or invent the policy decision in this WO.
5. Test revoke/leave/other gang and an ordinary member negative control. Commit after targeted suites and checks pass.

## Task 6 — Remaining guards and statistics read semantics

Files: classified sites from Task 1, including `server/actions/announcements.ts`; app/server statistics loaders as actually discovered.

1. Write RED tests that a scheduler can request gang-wide statistics only via `can(ctx,'statistics.view.all')` with statistics enabled; ordinary members retain self-only behavior.
2. Keep `statistics.view` distinct from gang-wide scope. Do not use service-role reads to bypass the 0053 policy.
3. No preset manages announcements. A test-only custom announcement bundle can exercise the generic loader, without shipping custom-role UI/API.
4. Nondelegable member/ownership/LINE/discovery/config actions remain protected through `can()` even if malicious extras include them.
5. Remove duplicate loaders only after their caller classification and tests pass. Do not replace public/org checks with gang-only checks.

## Task 7 — Verification / handoff / stop

1. Run source coverage and loader/action tests; ensure every pre-existing guard is integrated or explicitly exempted with a reason.
2. Run role-matrix/RLS, gang-roles, treasurer-finance, scheduler-sessions, scheduler-statistics and touched action suites at least three times.
3. Run `npm run typecheck`, scoped eslint, `npm run build`, and the full Vitest suite; report real counts and unrelated failures separately.
4. Prove regrant/revoke/leave are reflected on the next independent server action without restarting the process.
5. DB mutations protected by RLS/actor-checked functions retain their DB enforcement. Legacy service-only functions without actor guards remain a documented defense-in-depth backlog risk; do NOT claim this loader fixes mid-flight revoke races in those functions.
6. Commit only scoped files; planner handles push/QA/cloud sequencing. No db reset, db push, deployment, UI enablement, or R-roles-4 work.

## Open points for the future WO

- Confirm whether app server components/navigation context integration is owned by backend or paired with frontend; loader alone must not imply UI is enabled.
- Confirm exact scope for org-admin legacy differences rather than silently changing permissions while deduplicating loaders.
- Storage policies for announcement assets remain separately inventoried; migrated table permissions alone do not prove asset upload authorization for future custom bundles.
