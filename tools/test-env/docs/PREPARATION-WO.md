# Preparation WO — APPROVED source + offline dummy fixtures ONLY

Approval:planner explicitly conveyed user 'อนุมัติ ทำต่อ'. Sole implementation owner gb-integrations. Authorized:exact preparation files,offline synthetic/no-network checks,syntax parsing. NOT authorized:V0–V6,image pulls,container/network/DB operations,real credential inspection/generation/rotation,old/shared volumes,cloud,commit/push/deploy. Earlier proposed gates below are historical;runtime stays fail-closed. No real writer invocation/ACL proof is performed. Selected test-only direction is ADR-016 (number checked against existing ADR-001–015).

## WO-TEST-ENV-PREP (draft identifier)

**Goal**: Turn the reviewed documentation contract into auditable off-repo manifest/writer/guard/probe/restore source with offline checks,so a later exact bounded execution request can be reviewed honestly.

**Scope**:User/planner approved creation of the exact preparation sources below under P=C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/ and offline dummy/no-network fixture checks. Test-only direction selected in ADR-016;production unchanged. Only ADR-016+baseline append are permitted repository documentation changes. No V0–V6 deployment/credential/shared side effects.

**Definition of Done**:
1.All files exist with no import-time I/O/process/network/key generation;explicit phase capability gate required for any non-pure action. Missing inputs/budget/approval fail closed;no dotenv/shared default discovery.
2.Model builder consumes frozen source+digest+mount/name/DNS/resource/operation contracts,emits one private model,not a port-list merge. Every exposed port/volume/network/image/env input accounted for;zero anonymous volumes;no undeclared proxy/env/host/shared network.
3.Windows writer source implements explicit ACL/exclusive/temp/flush/atomic-publish/readback/error policy;only nonsecret fixture mode in offline checks. Real ACL/private-generation proof remains V1/V2 under separate runtime consent;syntax pass is NOT W proof.
4.URL/DNS/output/operation guards have offline positive+negative fixtures;deny-before-delegate proves no network/process request is invoked for shared/cloud/provider/proxy/redirect/rebinding/missing-approval targets. No real negative connection to old services.
5.Concrete sink implementations and SMTP settings follow READINESS-AMENDMENT.md;no SMTP relay/forward/webhooks/version checks,remote Functions imports or real notification worker. HTTP sink discards bodies and records counts only.
6.Lifecycle ledger permits exactly the V3/V4cutover/V4restart/V5restore/V6 waves in OPERATION-BUDGET.json;offline attempt to exceed any individual/aggregate budget fails before delegate. No auto-retry;fail-stop must be separately granted.
7.Backup/restore source explicitly handles fresh synthetic managed-schema conflicts,DB roles/extensions+Storage metadata/bytes and B-only acceptance configuration;SQL review and fresh-target selection demonstrated with nonsecret fixtures. Command construction never assumes whole dump replay into initialized schemas succeeds. Actual successful restore is NOT claimed by mocks.
8.QA reviews every executable boundary,file list/offline results and literal future command manifest. Every command placeholder/unknown tool flag removed before one runtime request;not replaced by a broad generic consent token.

**Forbidden**:Preparation approval does NOT authorize Docker/Compose,fetch/pull images,create runtime networks/volumes,read private env/incident/shared data,generate real keys,perform real ACL proof or execute V0–V6. No application/shared DB tests/builds,stop/rotate/recreate/delete old state,commit/push/cloud. Only offline synthetic fixture tests and source syntax checks are included. No WindowsACL/source/mock result labelled runtime PASS.

**References**: AGENT-EXECUTION.md:9–18;Task_04;PROPOSAL.md,READINESS-AMENDMENT.md,CANDIDATE-MANIFEST-SPEC.json,OPERATION-BUDGET.json,VALIDATION-PROPOSAL.md,ADR-016 and public source JSONs. Sources now exist under P;PREPARATION-REPORT.md records actual checks versus final tool-blocked gates. They do not establish live runtime readiness.

## Exact implementation file set (source only)

| Relative path under P | Contract |
|---|---|
| model-builder.cjs | Pure validated source-spec→single model;safe private renderer adapter,no direct stdout config |
| private-writer.ps1 | Windows protected directory/file ACL,exclusive writes,atomic publication,no-value failure;real execution gated |
| target-guard.cjs | Exact project/platform/digest/host-port/mount/network/tenant allowlists before helper imports |
| output-boundary.cjs | Explicit metadata schema;capture child output privately,never print raw stderr/config/tokens |
| egress-policy.cjs | Exact service-ID/IP/port mapping,alias-only resolution,no redirects/proxy/host/provider fallback |
| lifecycle-budget.cjs | Persistent private phase counter;atomic transition budget and stop/cleanup identity guards |
| runtime-launcher.cjs | Capability-gated phase entry;no import-time execution;only literal reviewed subcommands |
| probes/verifier-probes.cjs | Owned A accepted-before/B-positive/A-negative after,per-enabled-domain cryptographic semantics |
| probes/egress-probes.cjs | Mailpit/HTTP positive,predelegate URL negatives,owned outside-sentinel control only |
| probes/http-sink.cjs | Internal8081 fixed routes,discard body,metadata counters |
| probes/deny-sentinel.cjs | Inert8080 outside-network listener+health;no secrets or outbound client |
| backup-restore.cjs | Private quiescence/DB+objects/fresh-restore recipe;exclude restored acceptance config;tools/flags source-verified |
| cleanup.cjs | Exact newly-created IDs/path inventory,non-reparse/ownership guards,no prune/down-v |
| functions/main/index.ts | NEW synthetic Functions handler using runtime built-ins only,no remote imports or delivery |
| contracts/approved-plan.schema.json | Full scope/digest/resource/op/egress/cleanup/retention schema;unknowns reject execution |
| fixtures/nonsecret-model.json | Complete nonsecret safe model plus separate negative fixture cases |
| tests/static-contract.test.cjs | Offline injected-adapter fixtures ONLY;trap any real fs/private read/child/network delegate |
| EXECUTION-MANIFEST.md | Full literal commands,path/tool versions/flags/outputs/stages/fail-stop/cleanup,NOT placeholders |

Vendor files are a separate immutable public copy from exact831d630 under prepared/vendor/docker/. Enumerate every copied source dependency and any test-only derivative. Do not vendor a real.env or make upstream example defaults runtime inputs. Selected public registry digests are already in the spec;do not resolve tags at run time. No dependency installation is silently part of this WO;new dependencies require a separately reviewed package scope. Node probes should prefer built-in crypto/http/net primitives and existing frozen-image DB tools;unsupported tools/flags are hard blockers.

## Exact proposed offline commands (not run,files do not yet exist)

After preparation grant+implementation,from the Windows Git Bash shell:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/runtime-launcher.cjs
    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/model-builder.cjs
    node --test C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/tests/static-contract.test.cjs
    powershell.exe -NoProfile -NonInteractive -Command '$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/private-writer.ps1",[ref]$t,[ref]$e); if($e.Count -gt 0){exit 1}'

Require Node syntax checks for EVERY.cjs in the exact file list,not just the two displayed entrypoints;the implementation's EXECUTION-MANIFEST.md must enumerate that list as literal commands. PowerShell command above parses only;it does not execute writer/ACL/key operations. Installed tool availability/version is unknown now. Offline test command is allowed only in a preparation grant explicitly including fixture-only execution;otherwise perform source review and leave tests NOT RUN.

Actual validation commands are intentionally absent while code/tools/plan schema are unimplemented. No `node nonexistent-harness --phase ...` is represented as supported. EXECUTION-MANIFEST.md is the deliverable that must replace this gap after implementation and QA,not preapproval to invent flags. Docker/Compose command syntax and secret-output behavior must be checked against actual approved tool versions before requesting runtime consent.

## User/planner gates

G0.Current docs amendment:authorized,source metadata/static checks only.
G1.User approval explicitly conveyed by planner SELECTS the test-only direction and preparation source+offline fixtures,recorded ADR-016. This is not deployment/production adoption;all real execution phases remain held.
G2.After implementation+offline evidence+QA review,user receives ONE command-ready bounded V0–V6 execution package with numerical caps,two networks/three loopback endpoints,sinks,owned rotation/restart/restore,cleanup/fail-stop/retention and remaining exposure limitations. No execution until that explicit grant.
G3.Card20 historical readiness and shared-local incident maintenance remain separate approvals;no grant above permits either by implication.
