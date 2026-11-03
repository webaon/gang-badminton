# Supported test environment — decision proposal

Status: DRAFT / QA REVIEW FIRST / NOT EXECUTION-READY.
Revision R1:READINESS-AMENDMENT.md + CANDIDATE-MANIFEST-SPEC.json + EGRESS-ALLOWLIST-SPEC.json + OPERATION-BUDGET.json supersede earlier resource/sink/operation TBDs and one-network/two-publication envelope. Final candidate is documentation-only:14services/13image digests,two internal networks and three loopback endpoints including owned deny-sentinel. PREPARATION-WO.md requires planner review BEFORE implementation. QA's original review did not cover R1.
Owner:gb-integrations. New investigation authorized by planner;previous capability round stays BLOCKED. Date:2026-11-03. Repo snapshot:1ba6430a27fde3d26fb73eb59b3b7a28dedfab0f. No ADR number reserved.

## 1. Executive decision / ★ recommendation

★ Advance A:an operator-owned,official Compose-derived TEST-ONLY environment through implementation-readiness and then a separately approved disposable capability validation. Do not migrate/adopt shared-local or attach original volumes. While A is unproved,operational state remains B:historical isolated stays stopped,card20 paused.

This differs from the old proposal only in authorized next work:planner/user now authorized investigation/proposal,NOT maintenance. A is source-supported for explicit credential inputs,not a certified Windows installation or a ready replacement for the exact historical environment. If compatibility/private-store/containment gates fail,stay B;do not reopen CLI-only S3 setters.

Original-data preservation by NON-USE is preferred over migrating production-like data just to validate a test environment. Disposable synthetic data can exercise lifecycle/restore without exposing incident credentials or shared data. Shared-local incident remains a separate open workstream regardless of A's success.

## 2. Established facts / evidence hierarchy

Existing evidence root E=C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/card20-isolation-preflight/.

| ID | Verified fact / anchor | Boundary |
|---|---|---|
| E1 | E/CONTAINMENT-RESULT.md:7–30 exact seven isolated IDs stopped/read back,no active bindings,retained two volumes+network | Historical snapshot,NOT a new live inventory. Do not repeat stop. |
| E2 | E/READONLY-REVIEW.md:14–28 all three incident fields configured-reused in shared-local;cloud unknown | No live acceptance/exploitation proof;isolated-only remediation insufficient. |
| E3 | E/PLAN-B-CAPABILITY-DELTA.md:13–16,30–53,75–82 supported JWT surface,fixed CLI S3 path,multiple HMAC domains,CLI stop/prune and Realtime persisted-tenant risk | Closed CLI-only rotation route. No new CLI research/run attempted. |
| E4 | E/PLAN-B-CONSUMER-DECLARATIONS.md:3–17 frontend declarations;E/PLAN-B-COORDINATED-REMEDIATION.md:51–74 static candidate mapping | Backend declaration PENDING;prior delivery provider-rate-limited. No retry,model change or wait.113references≠113processes. |
| E5 | Baseline:38–69,119–163,229–246;CLAUDE:9–18 | Supabase architecture,RLS/Vault/storage/queue/pooled-path and actual cron requirements must survive a controller change. Docs do not override these. |

Proof classes: S=public version/commit source verified;A=image/installed-artifact digest correspondence unproved;R=runtime unperformed;W=Windows ACL/private-writer unperformed. Source naming alone never closes A/R/W. Existing Docker29.5.3 is SERVER/ENGINE version,not verified Desktop product version. Current Compose/PowerShell versions/resources are NOT inspected.

## 3. Decision comparison

| Criterion | A:official Compose-derived test-only candidate | B:continue pause |
|---|---|---|
| Explicit unique S3/JWT | S:operator inputs exist;fresh independent generation proposed. Actual installation/revocation R/W open | No new capability;known CLI blocker remains |
| Loopback | S:explicit host_ip127.0.0.1;remove every unwanted publish. R open for both address families | Existing contained stopped snapshot;no new publications |
| Preserve old data | No old volume mounts/copies;new owned DB/storage data only | Retain old volumes/containers/evidence;no change |
| Historical0049 suitability | Unproved:template initialization,extensions,versions,gateway/pooler semantics differ | Card20 remains blocked,no misleading PASS |
| Lifecycle/revocation | Owned synthetic generation A→B,new-positive/old-negative,cache/persisted-state/restart proof proposed | No new proof;incident unresolved |
| Qualitative effort | Medium-high:manifest/DNS/image/digest contract,private writer,guard,compatibility+restore rehearsal | Low immediate effort;high schedule/opportunity cost |
| Main risk | Treating an official template as a validated local runbook;global names,env precedence,port merging,seed effects and PG build mismatch | Indefinite verification delay;preservation alone does not fix shared credentials |
| Recommended disposition | ★ Design/implementation-readiness next,NOT run now | ★ Remains the actual operational fallback until approved proof passes |

No patched CLI or managed/cloud deployment is silently substituted. New cloud environments are outside authority. A modified manifest retaining old image tags is a third compatibility matrix,not automatically the supported official matrix.

## 4. A source surface and provenance

Immutable upstream C=https://github.com/supabase/supabase/blob/831d6302c7361c0a5115a91e953bdf084eb85330/.
SOURCE-MAP.json independently re-fetches C/docker/docker-compose.yml and records fields without values:

| Input / lifecycle area | C/docker/docker-compose.yml lines | Source result / remaining proof |
|---|---|---|
| S3 pair | storage389–390 | Both S3_PROTOCOL_ACCESS_KEY_* fields interpolate operator inputs,unlike closed CLI fixed constants. Does not generate/install/revoke keys by itself. |
| JWT/derived client tokens | auth148;storage358–363;gateway98–103;realtime314,321;supavisor569–570 | Scalar JWT,anon/service-role and gateway/API mappings can be synchronized. Retaining a stale explicit token mapping breaks cutover. R/W open. |
| REST |273–275 | PGRST_JWT_SECRET selects configured JWKS/scalar input. No automatic following of Auth asserted. |
| Optional asymmetric keys |151–152,317–318,366–367 | Commented/opt-in fields are not enabled by default. A minimal fresh scalar+derived-token lifecycle is separate from asymmetric migration. No blanket asymmetric solution to metrics/HMAC domains. |
| Data |392,399;483–497;540 | Storage bind path,DB data/init mounts,pooler config differ from original CLI named volumes. |
| Global names |16,71,110,250,286,332,395,418,435,478,533 | Fixed container_name values mean --project-name alone does NOT provide safe multi-instance naming. Preflight every name;do not rename DNS/tenant-coupled names blindly. Conflict means STOP,not remove another stack. |

Current official matrix versus recorded isolated matrix:

| Service | Recorded isolated | Candidate C |
|---|---|---|
| Gateway |Kong2.8.1 |Envoy1.39.1 |
| Auth |2.195.0 |2.197.0 |
| Storage |1.68.8 |1.81.0 |
| REST |14.16 |14.18 |
| Realtime |2.123.5 |2.143.3 |
| Supavisor |2.9.7 |2.9.13 |
| PostgreSQL build |17.6.1.158 |17.6.1.136 |

This is not a drop-in upgrade. Never mount old PGDATA into a different build based only on major version. Exact image digests/source correspondence and extension/initialization compatibility remain future gates. No images pulled.

Vendor guide:https://supabase.com/docs/guides/self-hosting/docker (retrieved2026-11-03) explicitly includes Windows Docker Desktop as an install platform and operator-managed configuration. This is documentation support,not this host's resource/version/ACL proof or support-contract certification.

### 4.1 Candidate-image source checks, not borrowed old-version claims

| Candidate source | Pinned path / lines | Finding |
|---|---|---|
| Authv2.197.0 |internal/conf/configuration.go1144–1164;internal/conf/jwk.go89+ | Empty Keys derives signer from scalar secret;configured keys choose signer. Need intended generation and key list. |
| Storagev1.81.0 |src/config.ts436,490–491,870–876;src/http/plugins/signature-v4.ts262–343 | S3 injected pair supported;single-tenant path uses pair+service token. Protocol versus backend-object-store credentials remain distinct. |
| Storagev1.81.0 |src/internal/auth/jwt.ts306–375,411–436 | HMAC fallback exists with JWKS;cache key includes secret/key-set fingerprint. Do not infer cache lifetime or revocation solely from append. |
| Realtimev2.143.3 |priv/repo/seeds.exs19,27–28,47;lib/realtime/api.ex26–38,159–161;channels/auth/jwt_verification.ex99+ | Seed deletes/inserts tenant if invoked;tenant JWT state/admin+metrics are separate and updates/disconnections matter. Restart preserving application data does not prove tenant/session preservation. |
| Supavisorv2.9.13 |lib/supavisor/jwt.ex98–102 | HMAC-specific signer;API/metrics are not automatically asymmetric Auth consumers or DB passwords. |
| PostgRESTv14.18 |src/PostgREST/Config.hs491–499;Auth/JwtCache.hs75–97 | Explicit configured key material/cache dependency. Need actual reload/recreate and rejection proof. |

Full immutable/version URLs and property anchors are in CANDIDATE-IMAGE-SOURCES.json,SOURCE-SUPPLEMENT.json,ADDITIONAL-SOURCES.json. These verify retrieval/source structure,not runtime signatures or image-build provenance.

## 5. Loopback and configuration hardening contract

-Use one reviewed materialized manifest with all published ports enumerated;explicit127.0.0.1 only. No host network,daemon changes or wildcard/empty host_ip. Optional::1 requires a separate explicit dual-loopback design;absence of IPv6 wildcard still must be proved.
-Do NOT append a loopback ports override and assume old ports disappear:Compose merge key includes ip,target,published,protocol. A second loopback entry can coexist with original wildcard entry. !override requires appropriate Compose support;current installed version unknown. Prefer a reviewed single resulting manifest;check resolved effective model privately before container creation.
-Compose spec pin8f2dcf99fe9c62a09ae9915f1f8a9ba1b01bf65e/workload_spec.md:175–252 documents host IP and all-interface default;13-merge.md:96–104,175–212 documents unique port keys/!override. Source moved from services to workload_spec;citation checked at actual path,not guessed.
-Shell variables outrank --env-file in documented interpolation. Start subprocess from explicit approved minimal env,not inherited shell wholesale;reject missing fields,empty defaults/duplicate definitions/unexpected precedence. Read protected private file through the trusted launcher;never print docker compose config/config --environment or raw inspect/log output. A private in-memory render may project names/ports/mounts/boolean equality only.
-Synthetic external integrations disabled:do not send LINE/email/push,enable real OAuth credentials or run external notification dispatcher. Keep only reviewed test-local mocks/sinks. Do not introduce a replacement notification worker.

## 6. Data preservation versus migration/backup/restore

P0 preferred now:non-migrating fresh synthetic capability environment. Original CLI containers/DB+storage volumes/network/worktree/transcripts remain untouched and unmounted,even read-only. No backup reads of old data are authorized by this investigation. No implicit claim original data is independently backed up.

For a later historical0049 test environment,use canonical49migration/seed artifacts from exact2e000f6 in a NEW project only after compatibility/initialization review. Retain byte-equality guard;do not normalize SQL or apply0050+ to historical target. Old physical data import is not necessary to test reproducibility,but schema/cron/pooler/RLS/function inventory must match the intended historical contract. Card20 resume is a separate QA gate.

Optional P1 migration of OLD data is NOT recommended/approved. If later needed:
1.Owner-approved quiescence across relevant DB/object writers;independent private recovery set for DB data+roles/extensions/config dependencies and Storage metadata+object bytes. DB dump alone is insufficient.
2.Use version-compatible tools and privately review restore SQL/managed-schema conflicts. A consistent pg_dump snapshot does not synchronize separate dumps/object copies. Do not tar live PGDATA;physical snapshots need valid whole-cluster/WAL/tablespace consistency.
3.Restore into another NEW empty target,never overwrite original volumes;verify logical IDs/schema/counts and owned object byte integrity privately,emit boolean results only. Synthetic rehearsal is not proof old-data recovery is complete.
4.Separate business data from acceptance configuration:restore must not reintroduce compromised JWT/S3/gateway/tenant/session/verifier material. Forward-recover with fresh keys or remain stopped,not leaked-key rollback. Preserve unrelated encryption keys/LINE Vault data;never full-regenerate them implicitly.
5.Existing shared-local/old data reads,backup creation,migration and downtime require their own explicit future scope/user decision;not part of test capability validation.

Sources:PostgreSQL17/app-pgdump.html (Description,security warning,roles limitations);backup-file.html (shutdown/consistent-snapshot constraints). No backup/restore command is operationally ready here.

## 7. Windows private writer contract / W OPEN

Supported API surface:https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-7.5 changes Windows security descriptors;related Get-Acl/ObjectSecurity.SetAccessRuleProtection/FileSystemAccessRule define verification/protected inheritance. Documentation does not prove installed PowerShell/NTFS/Docker handling.

Proposed private-store threat model:current authorized Windows user+SYSTEM,not protection against privileged administrators/Docker daemon. Owner-owned off-repo directory,protected inheritance,no broad allow ACEs,no reparse points;new exclusive files,flush/atomic publication and verified ACLs before any real material. Use a nonsecret canary/failure-path test first under later approval. No chmod0600-only claim. Avoid scratch auto-pruning for final runtime private store;new long-lived store/path needs explicit approval and retention owner.

Lifecycle values remain in private files/process memory,not argv/history/tool/chat/raw stderr/config dumps or public build outputs. Service-role never enters browser output. Mandatory output schema names/stage/status/booleans only;failure must not echo exception text or secret-bearing child output. Generation and key serialization require source-reviewed implementation,not a guessed shell command.

C/docker/utils/generate-keys.sh:46,60–61,71–72 shows generation;77–91 prints values;122–138 rewrites.env with.old backup and also touches unrelated encryption/password fields. It is evidence of capability,NOT the approved writer. Do not execute it wholesale as selective remediation. No keys generated in this WO.

## 8. Consumers and old-key-negative acceptance

Scope for first canary:only its own fresh pre-rotation generation A and replacement B. Do NOT read incident/shared keys or probe shared/cloud to manufacture a negative. This proves proposed lifecycle on owned canary material,NOT actual shared incident revocation.

| Domain / consumer | Positive and negative proof required on SAME scoped path | Gap/owner |
|---|---|---|
| Auth signer/verifier | Fresh B token works;owned A signed token fails cryptographic auth,not merely expired/missing user | Session/refresh-token policy separate from JWT signing;integrations specifies,QA verifies |
| Gateway/API key map | B approved role/key routes correctly;A legacy anon/service-role/API key denied on protected control | Public routes or RLS403 are not proof of revoked signature;new opaque keys are distinct mappings |
| REST | B minimal authorized fixture succeeds;A fails verifier on equivalent action | Guard avoids fallbacks;need exact error contract |
| Storage JWT+S3 protocol | B authorized JWT and SigV4 owned-object request succeed;A JWT/pair fails same endpoint/action | Missing bucket/404 is not revocation proof;test session-token S3 authorization separately if enabled |
| Realtime | B new channel auth succeeds;A new auth fails;existing A connection/session behavior recorded | Tenant stored jwt_secret/jwt_jwks,seed/reconnect effects must be intentional,not silently delete production-like tenant state |
| API/metrics HMAC domains | B legitimate control succeeds;A correctly signed control fails each affected verifier | Administrative APIs often unexposed;use scoped private probe inside NEW network only if later approved,not publish extra control ports |
| DB/session/config consumers | Fresh pool identity/transaction mode verified;no old acceptance restored from stored config | DB password separate;never derive username from Docker project ID. Synthetic DB password may be fresh for new project only,not shared rotation |
| App/browser/tests | Strict explicit helper env;server cached client restarted only for new test process;fresh public bundle/context if needed | Frontend declaration received;backend active consumer declaration PENDING,not wait/retry. No shared app server/build during first canary |
| Persistence/recovery | Recheck A-negative/B-positive after one authorized canary recreation and synthetic restore | Preserve application/schema/owned object data;fresh verifier config not replaced by recovery artifacts |

Generation A/B comparisons and authentication results emitted as booleans only;no values or credential hashes. New positive before AND after negative rules out dead endpoints/vacuous denials. Unknown signer cache/TTL or session acceptance horizon must be measured/source-specified before declaring revocation. Existing offline guard/native-worker16/16 is not real Vitest-worker proof;strict pre-import and every-worker origin/port guards remain a separate historical-test prerequisite.

## 9. Bounded validation / readiness

See VALIDATION-PROPOSAL.md as amended by READINESS-AMENDMENT.md R1. Final candidate envelope:one NEW project gb-env-proof-01,14services,13distinct immutable linux/amd64 image manifests,two NEW internal bridges and loopback ports56321(API)/56329(transaction pooler)/56325(inert outside-network deny-sentinel control),subject to future conflict/exclusion proof. These are proposed ceilings,not reservations or permission. No554xx historical/543xx shared connection,no old mounts/credential reads. Candidate full names/DNS/tenant/mounts are enumerated in CANDIDATE-MANIFEST-SPEC.json;effective runtime identity remains unproved. Numerical estimates and explicit lifecycle counts are in R1/OPERATION-BUDGET.json;all runtime/implementation HOLDs remain.

Runtime execution NOT READY:implemented private writer/guard+exact command/digest manifest,resource/port/name proof,Windows ACL proof and compatibility acceptance are missing. Source-level decisions can be made now without pretending these are complete. No runtime invocation from this WO.

## 10. Consolidated user decision package (QA→planner→user)

D1.Choose ★A as TEST-ONLY architecture direction with ADR draft,or B pause. Current authority already covers investigation/proposal only;this document grants nothing.
D2.Accept ★non-migration/original-data non-use;existing data/incident evidence retained. Any old-data migration/shared maintenance is excluded and requires a separately specified package.
D3.Choose private-store threat model/retention owner and allow a later implementation-only WO for writer,manifest/guard and no-value probes. Do not authorize key generation or arbitrary scripts by approving this design.
D4.Freeze validation ceiling in VALIDATION-PROPOSAL.md:only new synthetic stack/credentials/objects,one owned rotation/recreate/restore rehearsal,exact cleanup and fail-stop. Full literal implemented commands/image digests must pass QA before planner requests ONE bounded execution consent. No placeholder/destructive command preapproval.
D5.Accept compatibility gate:failure means stay paused;no baseline/golden relaxation,image swap,shared/cloud/direct fallback or hidden data migration. Card20 resume/matrix/cron tests require separate QA readiness disposition,not architecture acceptance.
D6.Keep shared-local credentials incident OPEN under its own maintenance decision;new isolated success cannot revoke shared leaked material or erase transcript copies.

Request these decisions as one table,not repeated per-field questions. Approval of a direction/validation ceiling is not execution consent;do not collapse missing exact commands into an implicit grant. QA reviewer findings attach before planner reports to user.
