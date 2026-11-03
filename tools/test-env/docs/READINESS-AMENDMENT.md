# Task04 readiness amendment R1 — static closure,not execution approval

Status:PROPOSAL/DESIGN ONLY;★A is a candidate,not architecture acceptance. Current HOLD unchanged. This amendment explicitly supersedes earlier V0 resource TBD,the one-network/two-publication envelope and ambiguous V4/V5 wording in PROPOSAL.md/VALIDATION-PROPOSAL.md. It does not modify approved app baseline. Source/runtime/Windows ACL evidence remain separate.

## 1. Candidate manifest/service/image/digest/name/DNS/tenant/mount contract

CANDIDATE-MANIFEST-SPEC.json is the final candidate documentation specification,NOT executable Compose or implemented launcher input. Fourteen proposed services:the eleven official-template services plus smtp-sink,probe and deny-sentinel;thirteen distinct immutable linux/amd64 image manifests. The probe and sentinel reuse one Node image digest. No services/images are pulled,created or run.

Official-template source remains831d6302c7361c0a5115a91e953bdf084eb85330. Public registry GETs resolved tag/index→linux/amd64 manifest digests and projected ONLY architecture,declared volume destinations and layer sizes;no private runtime config/credentials inspected. No anonymous bearer token is logged/stored. Registry digests are PUBLIC IMAGE hashes,not credential hashes. Raw image Env is not emitted. Registry metadata is not build-source attestation or actual local image identity.

| Service | Public tag selector (not execution pin) | linux/amd64 manifest execution candidate digest |
|---|---|---|
| studio | supabase/studio:2026.10.12-sha-3699278 | `sha256:bfb1b1e4a7ee9fee9f0f5aaa86f990f271305cf89d736f64b437e11d5d85b86d` |
| api-gw | envoyproxy/envoy:v1.39.1 | `sha256:be87c8b52663c1164a5bdf3c5419017a269cb3d8c74be1ec93638a71f1ffbd4b` |
| auth | supabase/gotrue:v2.197.0 | `sha256:839f529492d116b4e8b7777c953a27c381d34c15a744b1bcefde5eefaa1f9f9f` |
| rest | postgrest/postgrest:v14.18 | `sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0` |
| realtime | supabase/realtime:v2.143.3 | `sha256:1591e9049bf15fd392da9e8344db892f6acfe9da274517327dbd14733f32b9e1` |
| storage | supabase/storage-api:v1.81.0 | `sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799` |
| imgproxy | darthsim/imgproxy:v3.31.4 | `sha256:80200afeaa85c4abb58bbcb84deadab6d6cf5c79ac7af0694ff22e2b5de1477b` |
| meta | supabase/postgres-meta:v0.100.0 | `sha256:822227a8d12c109b24b8d8f1dae98a9c089a698b4586d35527dadf929e655136` |
| functions | supabase/edge-runtime:v1.77.4 | `sha256:fded42ff725708990b1a0803633c2659453259d075c4bec6b4d01dfb82dc055e` |
| db | supabase/postgres:17.6.1.136 | `sha256:5a4314708484bec672de2c09653a5c01fb1c84a998564ac231b0325e2238ed5b` |
| supavisor | supabase/supavisor:2.9.13 | `sha256:c57b1222f3ca21a3180c202dea14806cc0be67cda633eb62bcc6481efc0e7a95` |
| smtp-sink | axllent/mailpit:v1.33.0 | `sha256:18156f9ee243aa339170ac33d09d6d5a80b10d9e06b265f90f223a777a8f4b73` |
| probe | node:24-alpine | `sha256:4eefa1bfce4197942661ef9148247d779ddf1bb0ee006d3294a467609de60724` |

Full docker.io/repository@digest references and registry URLs are in the JSON and REGISTRY-METADATA-BATCH1/2/3.json. Node24-alpine is only a lookup selector;runtime candidate uses its resolved digest,never a mutable tag. Mailpitv1.33.0 source and digest support are explicit. Runtime daemon platform/current compatibility remain UNKNOWN;do not silently switch architecture/images.

Names/DNS:vendor fixed global names are preserved to avoid unreviewed DNS/tenant rewrites;new services use gb-env-proof-01-prefixed container names. All names/aliases are enumerated. Any existing-name collision blocks creation,not permission to remove another stack. Supavisor intended POOLER_TENANT_ID=gb-env-proof-01 is supported by upstream pooler.exs:10 input;intended postgres.gb-env-proof-01 transaction login remains runtime UNPROVED. Realtime intended vendor realtime-dev mapping remains subject to actual seed/gateway/tenant proof.

Mounts:each service's bind/volume/tmpfs source,target,access and upstream line is enumerated. Original/shared volumes and credentials are excluded. Public source/config copies and synthetic Functions/probes are NEW prepared files only;read-only mode/bootstrap compatibility is NOT proved. Live DB/storage binds stay below the NEW data root. Named volumes are exactly gb-env-proof-01-db-config-live,gb-env-proof-01-deno-cache and the V5-only gb-env-proof-01-db-config-restore. Candidate image-config declared volume destinations were empty for all selected manifests;expected anonymous volumes=0. Unexpected anonymous/image volumes fail the model/runtime guard;they are not silently added to consent. Actual runtime mounts/anonymous volumes remain unknown until approved proof.

## 2. Numeric resource/pull/time budgets — estimates versus observations

| Item | Candidate planning limit/estimate | Evidence / remaining gate |
|---|---|---|
| Service CPU | Sum7.25vCPU;aggregate design ceiling8vCPU | Per-service proposed limits in JSON;not observed CPU use or proof limits work |
| Service RAM | Sum7424MiB;aggregate ceiling8GiB,swap growth prohibited | Not measured usage;actual enforcement/engine capacity must be verified V0/V3 |
| Available resources gate | At least12GiB available engine memory and64GiB free on every relevant backing store;no CPU oversubscription beyond chosen8vCPU ceiling | Proposed headroom policy,NOT observed host state. Old resource snapshots not reused as fresh |
| Incremental disk |48GiB total for new images/unpack/live+restore/synthetic recovery data;retain16GiB floor from64GiB gate | Estimate,not measured growth;original data retention is additional existing usage,never pruned for space |
| Compressed image layer metadata |2,226,633,911bytes,2.074GiB before dedup | OBSERVED public manifest size metadata,not downloaded bytes/local cache/unpacked footprint |
| Pull budget |Thirteen distinct digest pulls maximum,one launcher attempt each;30minutes inside V3;8GiB planning wire allowance | Time/attempt budgets require future implementation. Actual CDN/wire bytes are UNKNOWN;8GiB is not a proven byte-quota mechanism. If hard network-byte quota is required,this is a blocker,not an invented Docker flag |
| Overall elapsed |180minutes maximum:V0=10,V1=10,V2=10,V3=70,V4=30,V5=35,V6=15 | Finite proposed ceiling,not elapsed runtime. V3 includes pull30,bootstrap25,network10,fixtures5 |
| Synthetic content |One test object≤64KiB;SMTP≤8messages;HTTPdelivery sink≤12messages;probe requests≤300 | Small owned data only,not card20/full-suite workloads |

If public image metadata/time/resource estimates prove inadequate,fail-stop and resubmit;do not raise budgets,add retries,prune old data or use shared services. Source metadata sum is conservatively without dedup,but not a substitute for a fresh disk/resource assessment. Host-registry CDN redirect allowlist is not frozen yet;image acquisition must not create a blanket runtime egress exception.

## 3. Concrete sinks / destination policy / negative cases

S1 SMTP:smtp-sink runs pinned Mailpitv1.33.0 on canary-only network;auth SMTP points only to smtp-sink:1025. Mailpit API8025 is internal only. Only canary@example.invalid recipients;database/tmp files in bounded64MiB tmpfs. Disable version check and SMTP reverse DNS;reject relay/forward configuration/env/flags/mounts,webhooks,remote database,remote spam services and browser-driven link fetches. MP_SMTP_RELAY_ALL=false is the only explicit false-valued relay-prefix exception. No public SMTP/UI. No real provider credentials. Mailpit source:cmd/root.go88,139–144,208,299–332,337–380,410–417;STATIC-READINESS-SOURCES.json records fields.

S2 HTTP:probe hosts a NEW implementation-planned internal sink at http://probe:8081 with only /healthz,/line,/push,/webhook. It discards bodies and records counters/booleans,never headers/tokens/person data. No real LINE/push dispatcher or Next shared app is started. Synthetic Functions handler must have no remote imports/delivery;its source is a preparation-WO file,NOT implemented now.

Network policy:two NEW explicitly internal bridges,gb-env-proof-01-net(main13services) and gb-env-proof-01-deny-net(deny-sentinel only). No shared/host/external network attachment,default route to outside destination,proxy env or Docker socket mount. Compose internal:true has source support at spec06-networks.md215–218;its actual host/bridge isolation remains a runtime gate. This is coarse network isolation,not a claimed per-flow firewall.

Application/probe destination allowlist:EGRESS-ALLOWLIST-SPEC.json enumerates exact proposed service aliases and TCP ports;resolve only from frozen exact main-network IDs before delegation. SMTP only smtp-sink1025,delivery HTTP only probe8081. Reject URL credentials,redirects,unapproved schemes/ports/DNS rebinding and any resolved IP outside that frozen set BEFORE sending. Internal permitted control/data ports are constrained by prepared service contract,not all RFC1918 addresses. DNS only for approved aliases;built-in service/Docker external-DNS forwarding enforcement is UNKNOWN pending V3,not claimed solved by internal:true. Any undocumented dependency blocks readiness. Host access is only API127.0.0.1:56321 and pooled127.0.0.1:56329,plus the isolated dummy sentinel127.0.0.1:56325 needed for a non-vacuous deny test. No public::/0.0.0.0,Studio,metrics or direct DB publish.

S3 deny-sentinel:NEW Node-based inert listener on deny-net:8080,host-published127.0.0.1:56325. Host can prove it alive,while a main-network probe must fail to reach the sentinel's exact NEW network address. It receives no credentials or application payload. This third publication/two-network expansion is PROPOSED scope requiring user consent,not an existing deployment change. No independent external host is available:keep that limitation;host→sentinel positive+cross-network negative is not external exposure certification.

Negative acceptance cases:
-N1 Allowed synthetic SMTP reaches Mailpit;nonallowlisted recipient is rejected and sink count unchanged.
-N2 Allowed internal HTTP sink increments exactly once;external-provider URL,public IP,shared/historical endpoint,host.docker.internal,proxy bypass,redirect and DNS-rebinding candidates are denied BEFORE socket/DNS dispatch. No actual connection to shared/provider/cloud endpoints.
-N3 Direct network probe(no application policy bypass assumption) to exact NEW deny-sentinel address fails while host sentinel health and allowed same-network sink succeed. Max12 such credential-free attempts across V3–V5;no Internet message/SMTP delivery attempt.
-N4 Effective model has exactly one approved network per service;altered model adding external/host network or wildcard publish is rejected before create.
-N5 Mailpit relay/forward/webhook/remote-db env/flag/mount injections fail offline preparation checks;running sink must retain mail with no relay destinations. No flag-only safety claim.

Concrete policy enforcement/probes are NOT IMPLEMENTED. Built-in service libraries do not magically inherit the proposed application's URL guard;their external delivery is constrained by internal network+no provider config and must pass V3 proof. If internal network prevents required loopback access or bootstrap,STOP;do not attach an Internet network as a workaround.

## 4. Explicit operation budget — no hidden repeat consent

OPERATION-BUDGET.json is the auditable finite count contract. Primary set=the13main-network services;outside sentinel=one,not rotated.

| Phase | Allowed lifecycle ceiling |
|---|---|
| V3 |Create/start13primary+1sentinel;create2newnetworks;at most13digest pull invocations |
| V4 cutover |Exactly one credential generation A→B;one13primary stop/remove/create-start wave. Sentinel stays alive |
| V4 persistence |One additional13primary Docker restart wave,distinct from cutover;cache/session observations have request/time caps,not extra restarts |
| V5 |One private synthetic dump+object snapshot+restore run;one13primary stop/remove/create-start wave to NEW restore bind paths+new db-config-restore volume. No second stack or new helper containers;DB helpers use bounded exec in existing NEW services/probe |
| V6 |Stop/remove13primary+1sentinel;remove only2owned networks and at most3owned named volumes if exact cleanup grant permits;retain specified private/sanitized evidence |

Normal totals:create40containers,remove40,explicit stop40excluding restart,plus13container restarts;two networks;at most3new named volumes;zero anonymous volumes;zero new helper containers. A failure allows at most one emergency fail-stop wave of the current exact owned IDs(max14),no restart/recreate continuation. If fail-stop itself blocks,report exact command and do not route around it. No automatic whole-stack recovery retries.

Declared budgets are not code enforcement yet. Exact full IDs are created-state readbacks,not invented now. Every exec helper,stage timer,request count,fixture cleanup and normal/failure stop must be enumerated in future execution manifest. Cleanup does not use CLIstop/prune/down-v or touch old data.

## 5. What is statically closed versus still blocked

Static:complete candidate service/name/image digest/mount specification,public image-volume projection,numeric design budgets,concrete sink/deny-control plan and finite operation accounting now exist. No claim of ready runnable manifest.

Residual blockers requiring bounded future proof or implementation:
-B1 Actual tool/platform/resources/port/name availability,cgroup/disk/time enforcement and Windows ACL/private writer:V0/V1 inside this documented new-project envelope,not additional current inspection.
-B2 Safe rendered manifest,DNS/tenant/bootstrap/read-only-bind and no-egress behavior:V2/V3. Public digests identify bytes,not source-build attestation or runtime success.
-B3 Owned A→B revocation/cache/session/restart/restore behavior:V4/V5,not shared incident keys. SQL restore-managed-schema method still absent.
-B4 Writer/guard/probe/sink/restore/cleanup implementations and full commands do not exist:PREPARATION-WO.md proposes exact files/offline DoD;planner must review before any implementation.
-B5 Host pull redirect destinations/wire accounting and independent external-host exposure proof remain UNKNOWN. Freeze acquisition destinations before execution;do not claim source metadata gives actual traffic caps or external-host proof.

Planner is informed of these blockers in this packet NOW;no permission-loop or silent waiting. User decision is architecture direction+preservation/scope,then a command-ready bounded execution package ONLY after preparation/QA. Current work grants neither implementation nor runtime consent. Shared-local incident OPEN,card20 paused,backend declaration PENDING without waiting.
