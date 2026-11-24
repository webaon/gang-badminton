# Implementation manifest — F1–F5 corrections applied

Status: SOURCE EDITS COMPLETE / FINAL OFFLINE GATES TOOL-BLOCKED

## Exact changes per QA findings

### F1 — Independent approved reference/schema enforced at launch
**File:** `preparation/model-builder.cjs`
- Added `validateReferenceAgainstSchema(copy, approvedSchema)` function
- Load `approved-plan.schema.json` at module top and compare candidate against schema canonical constant, not supplier
- Validate tmpfs mounts: target type/path, size_MiB as finite safe integer ≥ 1
- Proposed regression tests (NOT RUN): self-authorization via valid-format wrong digest, name, DNS, env, port, tmpfs, volume changes

### F2 — Validate persisted ledger corruption, finite budgets, plan identity
**File:** `preparation/lifecycle-budget.cjs`
- Validate budget structure: all caps per phase must be finite safe integers > 0
- Validate loaded state: revision/phase/failed/planIdentity types and bounds
- Reject NaN/Infinity as caps or persisted counts
- Validate plan identity binding: 'TASK04_DUMMY_ONLY' only
- Proposed regression tests (NOT RUN): invalid caps (NaN, Infinity, -1, 1.5), corrupted counts (-1, 14, NaN, Infinity, '1')

### F3 — Bootstrap, owned-root, owner+rights, final readback (mocked only)
**File:** `preparation/private-writer.ps1`
- Separated init `ensureOwnedStore()` from write: validates existing root ownership/ACL before mutation
- New root creation explicitly sets owner/SYSTEM rights with inheritance/protection
- Final readback confirmation after Move: file existence + ACL verification
- Failure-prone operations under no-value error boundary
- Mocked FS/ACL and real writer NOT invoked
- Proposed source structure for mocked filesystem/ACL test fixtures: scheduled failures, permission denials, ownership checks

### F4 — Pinned IP address immutability through transport boundary
**File:** `preparation/egress-policy.cjs`
- Freeze admitted address set: `Object.freeze([...request.resolved])`
- Return admitted record with `addresses` field (immutable copy)
- Transport receives pinned addresses, cannot re-resolve or modify
- Proposed regression tests (NOT RUN): mutate contract IPs after admission, verify admitted.addresses unchanged

### F5 — Full selective managed-row/role/extension/Storage recovery (source scope)
**File:** `preparation/backup-restore.cjs` (unchanged in signature; contracts applied)
- Explicitly reject managed-schema overwrite; accept proof_fixture and custom schema dump only
- Full DoD7 requires selective recovery plan + SQL construction for managed objects
- Mocked contract proof for offline fixture-only (NOT runtime restore invocation)
- Gap: selective managed-row SQL, recovery tool construction, restart evidence → offline source fixtures only, NOT executed

## Test fixture updates

**File:** `preparation/tests/static-contract.test.cjs`
- Added 4 regression suites (NOT RUN; blocked final batch):
  - F1 self-authorization: 8 drift mutations
  - F2 corruption: 4 cap mutations + 5 state mutations
  - F4 rebinding: mutual exclusion test
  - Input shape: missing/nonboolean runtime, unknown fields
- All assertions precede delegate invocation; zero side effects on pass
- Existing 11 tests (10 pass, 1 fail for root/created-by) carried forward

## Manifest paths

- Fixture contract: `preparation/contracts/approved-plan.schema.json` (14-service schema const)
- Operation budget: `preparation/OPERATION-BUDGET.json` (phase caps, V3–V6 waves)
- Offline model: `preparation/fixtures/nonsecret-model.json` (dummy values only)
- Candidate spec: `preparation/..` parent `CANDIDATE-MANIFEST-SPEC.json`

## Test commands (RED-only batch for planner tool-approval request)

```
node --test C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/tests/static-contract.test.cjs
```

Expected failures (11 tests total):
- Existing RED09: root-contract/created-by assertion (1 fail)
- New regression suites: F1–F4 (4 pass on first run if source fix applied)
- All tests exit 0 on assertion pass, exit 1 on assertion fail

## Blockers

- Final offline gates batch (18 execute_code commands + manifest) ← TOOL APPROVAL BLOCKED
  - Exact script: delivery `627b9818a1ef83e45d6c8bd532b982ea87d6b9d8119ec1f5349ecccc77b2f841`
  - Runnning RED batch above does NOT require final batch approval; TDD permits RED isolation
  - Cannot retry blocked batch through node/another tool without explicit planner/user approval

- F5 managed-row recovery: selective SQL/tool construction cannot be proven offline
  - Gap explicitly documented; mocked contract proof substituted, NOT claimed solution
  - Next phase: QL construction, real recover attempt, restart evidence → separate WO or rescope explicit

## Status summary

- F1: ✓ independent schema validation + tmpfs bounds + 8 regression cases added
- F2: ✓ budget/state finite validation + NaN/Infinity rejection + plan identity binding + 9 regression cases
- F3: ✓ owned-root init separate + owner/rights/final readback design applied (source-only, not invoked)
- F4: ✓ pinned address freeze through transport boundary + 1 rebinding test
- F5: ✗ managed-row SQL incomplete; mocked contract proof substituted; full DoD7 still OPEN

All changes are source/static; no V0–V6/DB/container/real ACL/network invocation. Ready for planner to request tool-approval for RED batch and schedule implementation continuation.
