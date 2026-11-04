# Cards 17–19 Owner Review and Corrective Implementation Plan

> **For Hermes:** Use subagent-driven-development skill for a later, separately authorized implementation work order. This is DOCS-ONLY review, not execution authority.

**Goal:** Correct leave-credit attribution and define recipient-membership serialization, while closing QA gaps without regressing delegated permissions or weakening race assertions.

**Architecture:** Preserve existing signatures, permissions, state machines, append-only money ledgers and wallet-before-charge ordering. Proposed new migration replaces only `leave_gang` from 0049 and, subject to deterministic reproduction/approved serialization, `credit_topup` from 0051. Tests must identify the responsible operation and actual production close path, rather than infer success from final inequalities.

**Tech Stack:** PostgreSQL functions/RLS, Supabase/PostgREST, pure TypeScript money/domain tests, Vitest pooled-client barrier tests.

## 1. Authority and evidence boundary

- Planner authorization: inspect local Git/source and write a plan only. No production or test edits, application imports, credentials/env reads, DB/catalog access, services, tests, builds, apply, push, restart, rotation, model or provider changes.
- QA input: `C:/Users/peepe/.hermes/profiles/gb-qa/cache/scratch/cards17-19-static-review.md`, including Later-tip check.
- Exact card17: `f917afc628a1bb2ecfcdb6128f41672c3504ae51`.
- Exact card18: `a6254ea3fcc14747c42acd6431c9d4ad3168fed8`.
- Exact card19: `6d6a3ba8555addd925db30598869c29d14087563`.
- QA pinned tip and actual HEAD inspected: `1ba6430a27fde3d26fb73eb59b3b7a28dedfab0f`. `git rev-parse` returned each full object ID, exit 0.
- Read-only diffs from the exact card commits to pinned tip were empty for their respective 0047/0048/0049 migrations and credit-received-amount/credit-flows/credit-leave tests; card19 `server/actions/members.ts` also unchanged. Working-tree diff against pinned tip for all migrations, these three tests and credit/members actions exited 0.
- Unrelated frontend/payment/report WIP exists. It was not edited. One read-only command had a misspelled repository path and returned 128; corrected source-diff commands returned 0. No runtime outcome is inferred from source correspondence.
- Credential incident HOLD applies to shared AND isolated runtime. Existing isolated 0049 resources are NOT permission to restart, connect or run a later-tip suite. No QA PASS, acceptance closure or cloud clearance is claimed.

## 2. Owner disposition by finding

| Finding | Disposition | Current source anchor / consequence |
|---|---|---|
| S17-T1 catch-all authenticated update | Accept test-design gap | `tests/sessions/credit-received-amount.test.ts:194–202` swallows every error; `tests/helpers/db.ts:220–238` always rolls back, so a later unchanged value is not proof of rejection. Verified fixture may be invisible to UPDATE. |
| S17-T2 losing request errors | Accept test-design gap | `credit-received-amount.test.ts:304–323` checks one successful recorder and final values, not every rejected result's structured SQLSTATE/domain code. |
| S18-T1 both return/refund fail | Accept test-design gap | `tests/sessions/credit-flows.test.ts:444–456` discards results; an upper bound alone accepts zero progress. |
| S18-T2 fake close | Accept coverage gap | `credit-flows.test.ts:63–73,475–477` inserts monthly_fee via charge(); this exercises auto-apply, not session close locks/state/atomic charge insertion. |
| S19-C1 leave attribution | Accept high-priority source correctness defect; runtime manifestation NOT reproduced | `0049:217–221,273` reports unlocked balance difference, not the return from the operation it performed. This can include a concurrent payout/manual apply/topup. |
| S18-C1 / S19-C2 membership serialization | Credible source-only hypothesis; do NOT call reproduced | Latest topup is `0051:782–869`, with permission at 813, self guard 820–824, ordinary membership check 826–833, wallet lock 839–842, no recheck. Leave holds all active membership rows FOR UPDATE at `0049:153–160`. Ordinary SELECT does not serialize with that row lock. |
| S19-T1 return fields + fake close | Accept coverage gap | `tests/sessions/credit-leave.test.ts:282–311` never validates leave credit return fields and uses monthly_fee insertion as its close job. |
| S19-T2 event privacy | Accept coverage gap | Superuser payload inspection proves payload shape, not who can read it through RLS. |

## 3. Latest-definition map: do not restore stale authorization

| Function / guard | Latest tracked definition at pinned tip | Planned treatment |
|---|---|---|
| credit_topup(uuid,uuid,numeric,text,uuid,text) | `20260818000051_finance_permissions.sql:782–869` | Copy this body, NOT 0048/0049. Preserve actor_has_permission(...,'credit.topup'), self guard, validation, sequence, audit and numeric behavior. |
| leave_gang(uuid,uuid,text) | `20260818000049_leave_gang_credit.sql:121–277` | Copy this body, retain member locking, owner invariant, cancellation loop, soft-delete, LINE unlink and public-event fields. |
| apply_credit(uuid,uuid,uuid[],uuid,text) | `20260818000046_credit_ledger_seq.sql:192–334` | Consume existing JSON `applied`/`remaining`; no body change initially. Wallet lock 244–249, zero/no-wallet return 251–255, no-debt return 281–285, successful return 328–332. |
| credit_balance_of(uuid,uuid) | `0044:173–180` | Nonlocking STABLE ledger sum; not an operation-attribution source. Do not change its global contract for this fix. |
| set_payment_received_amount | `0051:334–409` | No production change proposed; tests retain payment.verify delegation. |
| record_overpayment | `0051:412–548` | No production change proposed; preserve credit.overpayment.record delegation. |
| credit_cash_payout / credit_return_charge | `0051:551–627 /630 onward` | Existing production paths for race tests; do not copy older authorization by accident. Payout intentionally permits departed recipients. |
| received-amount trigger | `0047:38–67` | Direct mutation raises SQLSTATE P0001 with message FORBIDDEN; service setter uses row-specific GUC. No guard redesign proposed. |
| close_session_with_charges | `0009:780 onward` | Keep production body/lock/expected_status logic unchanged; invoke this actual function in tests. |
| TS consumers | `server/actions/credit.ts:289–330`, `server/actions/members.ts:144–178` | Money already passes through moneyFromDb. Preserve API; add return-contract tests/documentation, not TS balance arithmetic. |

Latest-definition search found no leave replacement after 0049 and no topup replacement after 0051. Fresh source inventory is mandatory before future implementation if tip changes.

## 4. Proposed changes and files (NOT implemented)

### User decision — accepted principles, not execution authorization

The user explicitly accepted both principles after planner review:

1. Leave returns only this invocation's `apply_credit.applied`, with `credit_balance` as the immediately-after-apply snapshot held under the wallet lock. Idempotent creation of a missing zero-wallet cache row is accepted; it creates no money or ledger entry. Later committed transactions may change the current balance.
2. Recipient-membership lock order defines topup/leave serialization: topup locking membership first may complete before leave; leave locking membership first requires the subsequent topup to reject without money/ledger mutation. Deterministic old-definition reproduction and lock-order/deadlock verification remain mandatory before implementing the candidate.

Acceptance does not authorize production/test edits, migration reservation/application, DB/runtime tests, credential changes, restart, push or deployment. Credential-incident HOLD remains in force. Planner requests QA plan review next; related `record_overpayment` behavior remains out of scope, not implicitly fixed or approved.


### 4A. Correct leave attribution and define a returned-balance snapshot

New corrective migration: proposed `supabase/migrations/20260818000054_credit_leave_serialization.sql`; number must be rechecked/reserved by planner before implementation. Never edit an applied migration or remove a history entry.

Inside the copied 0049 leave body, after its existing cancellation loop and before soft-delete:

1. Ensure the recipient wallet row exists with an idempotent zero-row `INSERT ... ON CONFLICT DO NOTHING`. This creates no credit/ledger event and does not mint money. It deliberately changes the no-wallet case from a missing cache row to a zero cache row; include this in review/tests.
2. Call existing `apply_credit(...)` unconditionally and capture its JSON result in a local variable. The existing function locks the now-existing wallet row even when credit is zero/no debt. Row locks remain held through the outer transaction.
3. Return `credit_applied` from that call's `applied` and `credit_balance` from its `remaining`, retaining text/decimal output. Remove before-minus-after attribution. Do not silently default a malformed internal result to zero; contract tests must cover every early-return branch.
4. Keep owner/cancel rollback, outstanding calculation, membership soft-delete, unlink and public-event body unchanged. No monetary fields are added to gang.member_left.

Accepted snapshot contract (user decision above): credit_applied is ONLY the debit performed by this invocation's apply_credit. credit_balance is the wallet snapshot immediately after that invocation, while its row remains locked until leave commits. It is NOT guaranteed to equal a later read after another transaction commits a payout/overpayment. Empty-wallet materialization prevents an unprotected missing-row window. Outstanding_* retains its existing contract; this fix does not claim to freeze every concurrent transfer/charge writer.

The no-materialization alternative is not selected: idempotent zero-row materialization + captured result is the accepted design. No renewed approval of these two principles is required; implementation/runtime authority is still absent.

### 4B. Recipient-membership serialization in topup (conditional on runtime gate)

Define valid histories explicitly: topup that locks active recipient membership first may commit before leave; leave that obtains membership lock first makes a later topup reject NOT_GANG_MEMBER without ledger/sequence/cache mutation. A topup is not allowed to validate active status before leave and then credit after leave committed.

Candidate narrow change in the copied 0051 body: replace ordinary recipient exists-check with a targeted active gang_members row read using FOR SHARE, followed by NOT_GANG_MEMBER when no row is locked. Acquire it BEFORE wallet insert/FOR UPDATE. FOR SHARE conflicts with leave's FOR UPDATE and with non-key soft-delete updates; do not rely on FOR KEY SHARE for general membership-update exclusion. Preserve permission and self-check order and every existing grant/signature.

This is a proposed serialization contract, not proof of a live bug. First run the controlled old-definition experiment below after separate authorization. If it cannot reproduce, report exact observed waits/isolation and stop or narrow scope with planner; do not mark the hypothesis fixed merely because the candidate looks safer.

### 4C. Test-only repairs

- Modify `tests/sessions/credit-received-amount.test.ts`: remove catch-all assertions; inspect structured errors for every losing job.
- Add `tests/sessions/credit-received-amount-rest.test.ts`: real authenticated PostgREST positive/negative controls, only through a later-approved credential-safe HTTP harness.
- Modify `tests/sessions/credit-flows.test.ts`: retain all results, require progress and exact per-job outcomes; rename trigger-only cases accurately or replace their claimed close job.
- Modify `tests/sessions/credit-leave.test.ts`: assert returned credit_applied/credit_balance and correlation-specific allocations/audit; keep ledger invariants as additional checks, not attribution substitutes.
- Add `tests/concurrency/credit-leave-serialization.test.ts`: explicit independent clients, deterministic barriers and lock-observer evidence; no production hooks/GUC bypass/disabled triggers.
- Add `tests/concurrency/credit-close-wallet.test.ts`: actual SessionBilling.calculate() → close_session_with_charges() path from sessions.snapshot, not a handcrafted monthly_fee stand-in.
- Extend `tests/rls/tenant-isolation.test.ts` or a narrowly scoped new credit-event-visibility test to prove public/audit visibility with authenticated roles and own/other gangs.
- Extend existing `tests/sessions/member-credit-actions.test.ts` (leaveGang return coverage at 275–300): money-string return forwarding, exact RPC names and can boundaries. Preserve `server/actions/credit.ts` and `server/actions/members.ts` production shells unless a separate API defect is demonstrated.
- Documentation updates: ADR-010 snapshot/linearization clarification and relevant existing error rows only if semantics change. No new error codes are currently needed. Do not change billing formulas or session/payment/registration state machines.

## 5. Lock order and scope boundaries

- Topup: active recipient membership FOR SHARE → wallet creation/lock → ledger/cache/audit. Never lock membership after the wallet.
- Leave: existing ordered active membership FOR UPDATE → existing future-session/registration cancellation order → wallet/apply_credit → existing soft-delete/unlink/event. Do not move wallet acquisition ahead of cancellation, which could create wallet→session inversion.
- apply_credit remains wallet → existing payment/allocation/transition work; it does not newly lock membership rows. Return-charge remains wallet → charge; refund keeps its existing charge locking. Do not blanket-reorder legacy functions in this corrective WO.
- Actual close remains session → charge insert/auto-apply → wallet path; analyze its existing FK/trigger waits in tests. Preserve close_session_with_charges and SessionBilling. A reproduced cross-function deadlock is a blocker to discuss, not permission to rewrite billing/state machines.
- Actor permission helpers stay unchanged. FOR SHARE concerns recipient membership, not a new guarantee about concurrent actor role revocation.
- Related source pattern: record_overpayment at `0051:492–513` also checks recipient membership before wallet. Do not claim the topup-only change serializes every credit writer with leave. A membership-lock change there needs separate payment→membership→wallet cycle analysis/approval; keep it an explicit follow-up question.

## 6. Deterministic RED experiments, then expected GREEN

All scenarios below are FUTURE procedures. None were run in this review. Use real transactions/commits on an approved isolated target, not just Promise.all or sleeps. Capture worker PIDs and prove blocking with scoped pg_blocking_pids/lock observations; bounded waits fail if the intended interleaving was not reached. Finally rollback unfinished transactions/release clients without masking errors.

### D19-A: payout is not leave's applied credit

1. Fixture: active non-owner recipient, wallet with credit, no outstanding debt, no future cancellation work. Distinct operation correlation IDs.
2. Payout client P begins and locks that wallet row FOR UPDATE, without membership locks.
3. Client L starts real leave_gang. Observe L blocked by P at the wallet, proving L passed the legacy before-read on the old definition.
4. P invokes real credit_cash_payout on its held row and commits. L completes.
5. Desired invariant on BOTH old/new: leave credit_applied must be zero because no debt allocation was made by leave; credit_balance must equal the payout result's balance_after at this scheduled ordering. Assert absence of leave-correlated credit allocation/audit, not merely final SUM.
6. Old source predicts incorrect positive applied difference; that is an EXPECTED RED, not an observed failure. After correction, require exact zero and snapshot-consistent return.

D19-B variant: P uses manual apply_credit on existing debt while holding the wallet before L. Compare leave return to only leave-correlated applied audit/payment, excluding P's result. This can expose before/after misattribution even when final debt/ledger is correct. Also force the reverse ordering so a payout after leave commits does not invalidate the previously returned snapshot.

### D18/19-M: topup must not pass a stale pre-leave membership check

Use the natural LINE-unlink wait point, not a production test hook. The schema permits a fixture member_line_links row (`0006:38–47`), and leave deletes it after apply_credit (`0049:251–253`). No actual LINE call/credential is needed.

1. Fixture recipient has a wallet and a synthetic test LINE-link row; no debt/future cancellations are needed. Actor is an independently authorized admin/delegated test role, not the recipient.
2. Blocker B locks only that LINE-link row FOR UPDATE.
3. L starts real leave. Observe L blocked by B at DELETE; L now holds membership + wallet and has an uncommitted membership soft-delete.
4. Start T topup. On old code, T can read the pre-leave committed active membership and then wait for L's wallet; observe T→L blocking. On the candidate, T must instead wait on recipient membership; do not infer which relation is blocked from blocking PIDs alone—inspect scoped lock/wait evidence too.
5. Release B so L commits. Desired invariant: T rejects SQLSTATE P0001/message NOT_GANG_MEMBER and creates no topup ledger/audit/seq change. Old source predicts it can proceed after the wallet unlock; reproduction is still required.
6. Reverse-order control: T obtains recipient FOR SHARE before L starts; observe L waiting, let T commit, then L succeeds. Assert this serial order is accepted, not an unconditional “concurrent topup must fail” rule.

### D17-S: setter versus recorder lock directions

- Setter-first: explicit transaction executes setter and retains payment FOR UPDATE; start recorder, prove it waits, commit setter, then recorder succeeds with that exact received_amount.
- Recorder-first: explicit transaction records and retains payment FOR SHARE; start setter and prove wait; commit recorder; setter must reject P0001/VALIDATION_ERROR with the credited-payment reason. Keep one successful recorder and no duplicate credit.
- For the existing four-job barrier race, every rejected setter/record job must have the exact allowed P0001/VALIDATION_ERROR case for its role in that fixture. Assert SQLSTATE/domain message/detail, not a broad message regex or any-error catch.

## 7. Progress, PostgREST and real-close proof

### Card17 authenticated positive control

- Use own SUBMITTED payment, not verified-only fixture. Positive PATCH changes a source-confirmed RLS-writable ordinary field (e.g. a fixture-only reject_reason marker after checking current guards) and returns exactly the intended row; separate authenticated GET verifies committed marker. No rollback-only asRole proof.
- Negative PATCH targets received_amount on the SAME visible row and actor, require guard-specific P0001/FORBIDDEN response and unchanged money on an independent read. Pin the HTTP status from the approved PostgREST error contract; do not conflate app error→403 mapping with direct PostgREST P0001 mapping or accept arbitrary 4xx.
- Add direct INSERT with received_amount negative control, and anon/outsider/RPC EXECUTE negatives with exact expected access-denial response codes. Do not log JWTs/keys, embed them in a plan, or load existing shared credentials for this review.

### Card18 return versus refund full-cap race

- Capture both results. Fixture has one refundable transfer-funded amount and no preexisting wallet credit.
- Require exactly one successful full-cap operation. The losing job must be P0001/VALIDATION_ERROR with the exhausted-cap/no-refundable-amount reason identified for that job from its latest source.
- Assert returned-to-wallet plus cash-refunded amount EQUALS the refundable transfer cap, not just <=. If both fail, test must fail. Include transfer/credit mixed-allocation controls and correlation-specific rows.

### Actual close (cards18 and19)

- Build an open/in_play session with active/checked-in member registration so leave does not try to cancel it; keep snapshot pricing complete.
- Calculate charges with `calculateSessionCharges` exported by `domain/billing/session-billing.ts:211` (the implementation named SessionBilling.calculate() in ADR/comments), using only snapshot pricing, then invoke close_session_with_charges with expected_status through the worker client assigned to the close job. Use the existing input preparation in `server/actions/billing.ts` as source reference; do not import an invented SessionBilling class. Calling a pool helper outside that client defeats barrier/transaction control.
- Assert close success, exactly one session-charge set, expected status transition, auto-apply effects and no duplicate allocations. A stale duplicate-close probe has a separately specified permitted outcome; it is not the mixed-race success control.
- Run leave/payout/manual-apply/topup/actual-close as separate pairwise scenarios plus a mixed barrier, at least 20 rounds each after deterministic schedules pass. Specify allowed outcomes per job: leave and single valid close succeed; payout may reject only INSUFFICIENT_CREDIT when ordering exhausts wallet; topup may reject only NOT_GANG_MEMBER when leave wins; apply_credit must succeed including zero/no-debt return. Return/refund need their own correctly funded fixture and exact cap outcomes.
- Never globally allow VALIDATION_ERROR for every job. Reject 40P01, 40001, 55P03, 57014, connection failures and unexpected domain/transport codes; do not hide them with retries. Test-only lock timeouts are failure diagnostics, not acceptable business outcomes.
- Per run: reconcile contiguous seq, balance_after chain, cache=ledger sum, nonnegative wallet, allocation caps/outstanding, returned money strings and attribution. Monetary arithmetic in tests uses existing satang/decimal helpers.

### RLS/event proof

- Ordinary same-gang member reads the scoped gang.member_left event, which has no financial fields; outsider/other-gang/anon do not gain it.
- Apply-credit/payout/topup audit payloads are invisible to ordinary members; assert owner/admin and the accepted treasurer finance-audit boundary, using current 0051 policy behavior.
- Use authenticated visibility counts/actual query results plus a privileged fixture existence control. Do not silently drop rows from expected counts to make privacy tests pass.

## 8. Execution phases and definition of done (all deferred)

1. User-approved snapshot/zero-wallet and membership linearization principles in section 4 stay settled. Complete the open QA test-spec gaps in section 9 before requesting a runtime work order; any related overpayment writer concern needs separate scope, not automatic extension.
2. Credential incident/remediation gate clears, QA grants a fresh runtime lane and target provenance. Use only a newly approved safe isolated harness pinned to current source including 0051 delegation; stopped isolated0049 is not sufficient for latest permission regression acceptance. Pre-import guard must reject shared-target connections before existing tests/helpers/db.ts or application imports. Never retry usernames/ports or fall back to shared DB.
3. Write/inspect test-only changes, run old-definition schedules and preserve actual RED assertions with wait evidence. Membership failure remains hypothesis until this point. No production mutation before that evidence and authorization.
4. Implement new corrective migration from latest definitions; prove narrow body diff. Preserve empty search_path, schema qualification, signatures, grants, permission helpers, self-topup guard, last-owner behavior, cutoff rollback, audit/privacy and soft-delete cleanup. No edits to 0047–0053.
5. With separate migration authorization apply only the new migration on the approved lane; verify installed definitions match it. Rerun deterministic cases, pairwise/mixed 20-round barriers and REST controls; record actual GREEN output.
6. Run touched action/money/RLS/grant/role-matrix and prior credit/fanout/leave regressions, typecheck/lint, full suite and build only when runtime/build is separately authorized. Exact historical card gates and current-tip regression results are separate evidence, never interchangeable. Any golden delta from zero-wallet cache materialization must be identified, not blanket regenerated.
7. QA independently verifies errors/progress/linearization/real close, rollback, FIFO, departed-member payout, self-topup denial for all roles and delegated custom credit.topup preservation. Treasurer/scheduler presets must not gain credit.topup. Future server-extra loader work remains outside this corrective WO.
8. Handoff supplies migration number, commit(s), actual failing-before/passing-after tests, every remaining failure, lane/environment provenance without secrets, unapplied cloud order and explicit HOLD/authorization boundaries. No PASS/closure until those gates are actually executed and accepted.

## 9. QA plan review follow-up — OPEN, not execution-ready

Review source: `C:/Users/peepe/.hermes/profiles/gb-qa/cache/scratch/cards17-19-remediation-plan-review.md`. QA accepts the design direction for planning WITH OPEN TEST-SPEC GAPS; this is not code PASS, reproduction, lane authorization or cloud clearance. Accepted user principles in section 4 are settled, not renewed questions.

- **G1 — named zero-wallet matrix required:** ZW-ABSENT-NO-DEBT, ZW-ABSENT-DEBT, ZW-ZERO-NO-DEBT, ZW-ZERO-DEBT, ZW-POSITIVE-NO-DEBT, ZW-POSITIVE-PARTIAL-DEBT, ZW-POSITIVE-FULL-DEBT. Each case must assert exactly one cache row after successful leave, decimal-string outputs, and operation-specific applied/remaining. Zero/no-funds cases must retain zero balance/last_seq and unchanged debt, with no financial ledger/payment/allocation/apply-audit rows; the separate public member-left event is expected. Add ZW-CREATE-TOPUP-FIRST and ZW-CREATE-LEAVE-FIRST with proven membership ordering, no duplicate wallet/phantom credit and no failed-topup ledger/audit/seq/cache mutation. Existing no-wallet early returns alone are not proof of these new materialization branches.
- **G2 — post-materialization failure proof still OPEN:** last-owner/cancellation rejection happens before cache creation and cannot prove rollback of the new row or apply side effects. Specify an isolated, fixture-scoped failure after wallet/apply with baseline comparisons for wallet, ledger, payments/allocations, membership and LINE link. No production hooks or permanent shared schema changes. Any proposed scoped cancellation/fault mechanism requires separate explicit authority; none is implemented or authorized here. Do not label early-failure tests as this coverage.
- **G3 — exact lock graph still OPEN:** source-inventory each inherited FK/trigger edge for close charge insertion, wallet creation, apply-credit payments/allocations/transitions, membership soft-delete and LINE unlink. Record relation/key/lock mode/acquisition order and conditional branches, not just the visible parent-function order. Include absent-wallet and real-close both-order schedules. Hidden wallet-to-membership cycles remain a review gate; no blanket reorder or deadlock-safe claim is approved.
- **G4 — RLS identities fixed in specification:** public-event positive actor must be a remaining ordinary member, not the departed recipient. Name `asRole()` / `visibleCount()` for authenticated SQL checks and retain privileged existence controls. Custom credit.topup delegate is a separate actor from treasurer audit visibility. Treasurer/scheduler must not gain topup from their presets. These checks remain unexecuted.
- **G5 — direct HTTP/delegation contract still OPEN:** freeze current policy/guard and exact direct PostgREST status/code/message expectations before any REST runner, without borrowing application error mapping. Retain custom credit.topup RPC permission positive, treasurer/scheduler negatives and server can() boundary tests. A custom DB-role positive does not imply the future server-extra loader is implemented. No HTTP response was observed in this review.

G1/G4 now have named branch/identity requirements; they are not executed proof. G2/G3/G5 remain explicit pre-runtime specification/proof gates, not waived. `record_overpayment` remains out of corrective scope and the credential incident HOLD remains unchanged.

## 10. Concrete test specifications for QA G1–G5 (DOCS-ONLY)

### G1 — named matrix, fixture preconditions and exact assertions

Let C be the fixture's positive wallet amount and D its positive debt; arithmetic is performed with existing decimal/satang helpers in the future test, never JS floats. Baseline allocation/audit IDs are captured before the call. Existing-zero fixtures in this matrix start with balance=0,last_seq=0 and no prior credit ledger; an additional historical-zero fixture with last_seq>0 must preserve its existing sequence rather than reset it.

| Named case | Wallet/debt before leave | Own applied / returned remaining | Extra assertions |
|---|---|---|---|
| ZW-ABSENT-NO-DEBT | No cache row, no debt | '0.00' / '0.00' | One cache row after success, balance/last_seq zero. |
| ZW-ABSENT-DEBT | No cache row, D>0 | '0.00' / '0.00' | Debt unchanged; no new credit allocations. |
| ZW-ZERO-NO-DEBT | Existing zero row, no debt | '0.00' / '0.00' | Same row identity; no duplicate cache row. |
| ZW-ZERO-DEBT | Existing zero row, D>0 | '0.00' / '0.00' | Same row; debt unchanged. |
| ZW-POSITIVE-NO-DEBT | C>0, no debt | '0.00' / C | No debit or sequence consumption. |
| ZW-POSITIVE-PARTIAL-DEBT | 0<D<C | D / C-D | Allocation sum equals own applied; remaining debt zero. |
| ZW-POSITIVE-FULL-DEBT | D=C | C / '0.00' | Allocation sum equals own applied; debt zero. |
| ZW-POSITIVE-INSUFFICIENT | 0<C<D | C / '0.00' | Remaining debt D-C; no over-allocation. |
| ZW-HISTORICAL-ZERO | Existing zero row, previous ledger/seq, with and without debt | '0.00' / '0.00' | Old seq and ledger unchanged; no reset to zero. |

For EVERY no-op case: zero deltas in credit_ledger, payments, payment_allocations and audit.credit_applied for the leave operation, unchanged last_seq, matching wallet snapshot and decimal-string output. A public gang.member_left event is expected and is not an apply audit. Role-revocation audit may legitimately occur for a recipient holding bundles; isolate its event type from financial deltas. For positive application: verify the single operation's credit-funded payment/allocations, corresponding ledger debit, sequence increment and audit correlation independently of other writers.

Concurrent absent-wallet creation cases (repeat with existing-zero control):

- **ZW-CREATE-TOPUP-FIRST:** start T on an absent wallet; T obtains active membership FOR SHARE and creates/credits wallet inside its transaction. Prove L waits for T's membership lock, commit T, then L proceeds. Assert one wallet, no duplicate unique-key failure, and leave applied/remaining account only for its own work using the committed credited balance. Topup must succeed; leave must succeed.
- **ZW-CREATE-LEAVE-FIRST:** L obtains membership, materializes zero wallet and waits at the natural LINE-unlink point described in D18/19-M. Start T; prove membership wait, release L and commit it. T must reject P0001/NOT_GANG_MEMBER. Final cache is the zero row created by L, NOT an expected absent cache; compare T's ledger/audit/seq/cache deltas with the post-leave state so L's legitimate materialization is not misclassified as a failed-topup mutation.
- These schedules are requirements, not observed behavior. Do not replace blocked-order evidence with sleeps or a success-count-only barrier.

### G2 — late rollback using an EXISTING deferred constraint, no hooks

Source-backed fault surface: `20260810000004_money.sql:163–203` defines `payment_allocations_within_payment`, DEFERRABLE INITIALLY DEFERRED. `check_allocation_within_payment()` raises P0001/ALLOCATION_EXCEEDS_PAYMENT when allocation sum exceeds payment.amount. It is a pre-existing constraint trigger, not a proposed production/test trigger.

Proposed future isolated transaction procedure:

1. Commit normal scoped fixtures and snapshot all affected row IDs/values. Prepare a separate fault-control payment/charge fixture (outside the leave recipient's debt cohort) so its pending allocation cannot change the debt under test.
2. In one explicit client transaction insert a fixture-only allocation that will violate the existing deferred sum constraint. Keep that constraint deferred; do not disable it or alter any schema. If some installed immediate constraint rejects this setup, the case is BLOCKED at setup, not a successful late-rollback test.
3. Call real leave_gang on the same transaction/client. Confirm its SELECT actually returned. Before inducing failure, query within that transaction and prove the new cache row exists (absent-wallet variant), or the real applied payment/allocation/ledger exists (positive-wallet/debt variant), membership is soft-deleted and the fixture LINE link is removed.
4. Issue `SET CONSTRAINTS public.payment_allocations_within_payment IMMEDIATE` on that same transaction. Expected source-level error: P0001/ALLOCATION_EXCEEDS_PAYMENT. This forces validation AFTER the materialization/apply work, not an early last-owner/cancellation rejection. Exact installed constraint name/deferrability must be verified on the approved target before this procedure is accepted.
5. Explicitly roll back the now-aborted transaction and release the client. Use a fresh independent client to compare wallet existence/value/seq, credit ledger, payments/allocations, debt, membership, LINE link, role assignments and public/audit events with the committed baseline. The deliberately invalid fault allocation must also be absent.
6. Execute BOTH variants: absent-wallet/no-debt proves newly inserted zero-row rollback; positive-wallet/debt proves actual credit application and all financial side effects roll back. An absent-wallet/no-funds case alone cannot prove rollback of a debit it never made.

This proves late OUTER-TRANSACTION/constraint-failure atomicity after leave returned. It does not claim an injected intra-function failure or a reproduced production error. No pg_cancel_backend, process cancellation, production hook, trigger disabling, schema change or new fault authority is required by this proposed mechanism. Runtime still requires a separately approved isolated test lane. If installed definitions do not support the deferred constraint procedure, keep G2 blocked and return to planner; do not substitute an early failure or invent a new hook.

### G3 — source-derived FK/trigger wait graph and remaining runtime gate

Anchors below are relative to `supabase/migrations/`. They identify logical FK columns exactly as declared. PostgreSQL-generated FK names and live enforcement modes have NOT been catalog-verified. Ordinary SELECT entries mean no explicit row lock in the inspected function, not “no relation/engine lock.” FK parent key checks are expected to acquire parent KEY SHARE under normal PostgreSQL RI behavior; actual waits/held locks remain a catalog/runtime proof gate.

| Edge / phase | Source-backed relation/function/trigger | Expected blocking edge / condition |
|---|---|---|
| Close parent lock | `0009_db_functions.sql:798–802` close_session_with_charges | Session row FOR UPDATE before any charge insert. |
| Session-charge insert | `0009:876–886`; `0004_money.sql:27–58` | Unique session-registration index at 0004:71–74; FKs gang_id→gangs.id, session_id→sessions.id, registration_id→session_registrations.id, optional gang_member_id→gang_members.id, created_by/updated_by→profiles.id. Actual close INSERT omits gang_member_id, so that optional FK is NULL on this path; monthly_fee insertion is different. |
| Registration parent identity | `0003_sessions.sql:196–225` | Registration FKs session_id→sessions.id and user_id/actor fields→profiles.id. No gang_member_id FK is declared in this table. No membership row lock is implied just by joining registration.user_id. |
| Auto-apply dispatch | `0044_member_credit.sql:469–510`, trigger session_charges_auto_credit | AFTER INSERT STATEMENT with transition table new_charges; ordinary joins to registrations/members and ordinary positive-wallet EXISTS; grouped order user_id,gang_id, then calls apply_credit. An absent/zero wallet may skip automatic application; test this branch rather than assume it locks. |
| Wallet acquisition | `0046_credit_ledger_seq.sql:244–255`; `0044:45–59` | apply_credit FOR UPDATE on credit_balances, or no-row return in old code. Materialization adds unique (gang_id,user_id) conflict/wait before this step. Cache FKs are gang_id→gangs.id and user_id→profiles.id, NOT gang_members. BEFORE UPDATE credit_balances_set_updated_at calls set_updated_at. |
| Apply charge scan | `0046:225–241,259–279` | Ordinary ownership/debt SELECTs ordered by charge id; NO explicit session_charges FOR UPDATE here. Do not manufacture a charge lock in the documented graph. Charge_outstanding is a read; concurrent charge/allocation/FK blockers still need runtime coverage. |
| Credit payment and allocations | `0046:287–300`; `0004:93–96,139–147` | New payment FKs gang/profile; allocation FKs payment_id→payments.id, session_charge_id→session_charges.id, created_by→profiles.id. Unique payment/charge pair can wait. Allocation constraint trigger is deferred (0004:200–203), and its body reads totals/payment amount without explicit FOR UPDATE. Commit-time checks are part of the graph, not just function-return time. |
| Payment transitions | `0022_transition_payment.sql:70–74,100–124` | FOR UPDATE of the just-created payment, GUC-guarded status UPDATE, payment.transitioned event insert. UPDATE triggers include payments_enforce_status_transition (0008), payments_set_updated_at (0004), payments_guard_received_amount (0047); the received guard tests a field/GUC, not recipient membership. |
| Ledger/cache/audit tail | `0046:302–326`; `0044:65–80`; `0047:158`; `0005_platform.sql:152–169` | Ledger FKs gang/profile/payment and optional charge; unique per-wallet seq from0046. Event FKs gang/session/actor profile. Cache updates keep wallet lock. No new membership FK is declared on credit_balances or payments. |
| Leave membership/cancel prefix | `0049_leave_gang_credit.sql:153–160,193–212` | Ordered active gang_members FOR UPDATE, then existing cancel session/registration paths BEFORE wallet. Preserve their ordering; a close session/registration wait can precede wallet acquisition. |
| Leave post-wallet role cleanup | `0049:244–248`; `0050_gang_roles_expand.sql:529–577` | Membership soft-delete triggers gang_members_revoke_roles, which UPDATEs active gang_member_roles then inserts audit.role_revoked. Composite membership FK is declared at0050:160–161; touched role rows/actor profile FK/event inserts add inherited edges. The BEFORE INSERT-only gang_member_roles_guard at0050:176–208 does NOT run on this revoke UPDATE. |
| LINE unlink wait | `0049:250–253`; `0006_line.sql:38–47` | DELETE exact recipient's member_line_links row after wallet work; row lock can conflict with a fixture blocker. LINE-link FKs are gang/profile; unique gang/user and gang/line keys. No external LINE call occurs. A parent hard delete/cascade is not exercised by soft membership deletion. |
| Final close UPDATE/event | `0009:904–925`; `0008_status_guard_and_rate_limits.sql:70–76` | Existing held session row updated under status-transition GUC, timestamp trigger and event FK checks. No new membership lock is explicitly acquired by this source segment. |

The filenames abbreviated by numeric prefix above are the inspected full migration files; number plus line is a source anchor, not an assertion of an applied runtime catalog. Source search found these relevant trigger declarations; target catalog parity and any later tip replacements remain mandatory before execution.

Named future schedules: **LC-EXISTING-CLOSE-FIRST**, **LC-EXISTING-LEAVE-FIRST**, **LC-ABSENT-CLOSE-FIRST**, **LC-ABSENT-LEAVE-FIRST**, plus the matrix topup orders. For each, pin session/registration/wallet identities and capture worker PIDs, acquired-row evidence, table/transaction wait evidence and commit order. Include a genuine session charge where gang_member_id is NULL and a separate monthly-fee control where that FK is populated. Include a positive-wallet control for the auto-apply EXISTS gate; absence/zero is a different path. A multi-recipient close must respect and test auto-apply's user_id ordering against leave's existing cancellation work, without broadening production changes.

OPEN runtime gate: enumerate actual FK/trigger definitions, deferred modes and relevant indexes on the approved isolated target; trace observed waits through transaction completion and compare with this source graph. Verify source-derived table/column edges against live catalog rather than asserting guessed generated names. Existing role-assignment writers, trigger/FK RI checks and concurrent charge/transfer updates may add cycles not demonstrated by this review. Any unexpected wallet→membership or reverse parent-row dependency stops the run and returns to planner. No claim of deadlock safety, no blanket lock reorder and no change to record_overpayment is authorized.

### G4 — exact visibility actors and financial scopes

Define distinct fixture identities: LEAVER; REMAINING_MEMBER (ordinary active member of the same gang); ADMIN/OWNER; TREASURER (accepted preset); CUSTOM_TOPUP (member holding only a test custom credit.topup bundle); OUTSIDER and OTHER_GANG_MEMBER. Do not reuse LEAVER as the post-exit public-event positive, or TREASURER as the custom-topup positive.

- Privileged fixture query first proves existence of the exact gang.member_left / financial audit IDs for the run. Use `asRole('authenticated', actor, ...)` or `visibleCount(actor, scopedQuery, params)` for each visibility assertion; no superuser payload read alone counts as RLS proof.
- REMAINING_MEMBER sees the public event without money fields. LEAVER's loss of membership is a separate expected-negative case. OUTSIDER/OTHER_GANG_MEMBER and anonymous access must not gain rows.
- ADMIN/OWNER see financial audit rows through the admin branch. Source `0051_finance_permissions.sql:273–288` grants the finance subset (`payment.*` / `audit.credit_*`, definition88–95) through gang.finance.view; TREASURER has that permission, CUSTOM_TOPUP-only does not. Therefore require TREASURER positive and CUSTOM_TOPUP negative for the exact audit.credit_topup/audit.credit_applied rows, plus CUSTOM_TOPUP negative for unrelated admin-only role audit. Calling topup must not imply credit.read.other or audit visibility. Compare only exact fixture IDs; live policy correspondence remains a runtime gate.
- No post-leave topup ledger/audit/sequence/cache mutation is attributable to T. If L created a zero cache, compare after-L and after-rejected-T rather than asserting global absence of cache.

### G5 — source-backed database errors versus UNKNOWN HTTP mapping

| Control | Source-backed expected database/row contract | Direct HTTP status evidence now |
|---|---|---|
| Own SUBMITTED payment ordinary-field PATCH positive | At pinned tip0051:133–156 payer identity passes SELECT+UPDATE; use verified writable fixture field, explicit Prefer:return=representation, exactly one matching row and independent committed GET marker. | Exact successful status is NOT OBSERVED. Freeze the deployed PostgREST protocol contract for this explicit preference before runner assertions. Do not treat arbitrary 2xx as adequate proof. |
| Same actor/row PATCH received_amount | 0047:38–67 BEFORE UPDATE guard raises P0001/FORBIDDEN if value changes without its row GUC. Pin both code and message; old values must survive independent GET. | UNKNOWN installed mapping until approved engine/version mapping or controlled isolated preflight establishes the single expected status. App-level shared/errors.ts 403 mapping is not direct PostgREST evidence. |
| Direct INSERT including received_amount | 0047:44–48 BEFORE INSERT raises P0001/FORBIDDEN; ensure a source-valid payer/tenant payload first so another validation is not mistaken for the guard. | UNKNOWN mapping; same explicit mapping/preflight gate, not any-4xx whitelist. |
| Anonymous/authenticated call of service-only financial RPC | EXECUTE revokes/grants in0049:282–286 and existing service-only inventory; expected database privilege-denial SQLSTATE42501. Test authenticated-no-EXECUTE separately from anon or malformed-auth requests. | Whether the target produces401 or403 for the precise request context is UNKNOWN here; do not conflate anon with invalid-JWT401 or authenticated42501 mapping. |
| Setter/recorder loser cases | Latest0051 setter379–386 and recorder515–526 identify P0001/VALIDATION_ERROR for already-credited/duplicate fixture cases. Check operation-specific detail; no broad failure allowance. | SQL pooled race code contract is source-backed; any REST counterpart requires separately pinned direct mapping. |
| Custom topup delegation | Latest0051:813 checks actor_has_permission(...,'credit.topup');0050 allows a custom bundle, and presets do not include this action. Actor is not recipient; active membership and valid reason/amount required. | Future service-RPC call with p_actor_id proves DB delegation, not a direct authenticated client EXECUTE grant. Future can() test passes the approved explicit extra context; it does not claim server-extra loading is implemented. |

Required future pin procedure: after a fresh safe-runtime authorization, confirm exact target PostgREST build/config/error mapping without exposing secret material; use the source-pinned fixture and the explicit auth role/request preference, make the positive then guard-negative requests, record only sanitized status/code/message/row-count/readback. Compare with the frozen mapping and fail on mismatch; do not modify expectations to whatever error happened. If available source cannot establish one exact HTTP status before preflight, label that preflight as a contract-discovery gate, NOT the acceptance test. No key/token/env read, HTTP call or observed response exists from this DOCS-ONLY work.

These additions resolve specification detail only where anchored above. Live FK/trigger/catalog correspondence, executed post-materialization rollback, causal RED/GREEN schedules and HTTP status pinning remain unexecuted runtime gates under incident HOLD. No implementation permission is implied.

## Current result

Source review and plan only. No migration/test/production files changed; no runtime or secret inspection was performed. Runtime verification, causal reproduction, implementation, build, migration apply, push and cloud clearance remain NOT RUN / NOT AUTHORIZED.
