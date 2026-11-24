# ADR-016 — Test-only explicit Supabase configuration and offline preparation

Status: ACCEPTED ONLY for test-only direction and preparation source/offline dummy fixtures,per explicit user 'อนุมัติ ทำต่อ' conveyed by planner. NOT runtime/maintenance acceptance.
Owner:gb-integrations;QA reviewer. Source snapshot1ba6430a27fde3d26fb73eb59b3b7a28dedfab0f. Number checked against baseline and docs/adr:highest existing015,no016/017 found. No commit/push authorized.

Context:CLI2.112.0 reviewed S3 path uses fixed values;old isolated is stopped,shared-local configured credential reuse incident remains OPEN. Baseline Verification requires actual pooled/RLS/cron behavior;an unverified replacement cannot close card20. Source/evidence:Task04 DECISION-PACKET-R1.md and QA task04-r1-qa-review.md;official Compose831d6302c7361c0a5115a91e953bdf084eb85330 supports explicit S3/JWT inputs,not automatic safe lifecycle.

Options:★A fresh synthetic,operator-owned official Compose-derived test candidate;B keep stopped/paused. A's gateway/images/mount ownership differ from CLI,including PostgreSQL build. No old volume reuse or physical migration assumed.

Decision:select A as TEST-ONLY direction and authorize sole-owner preparation source plus offline synthetic/no-network checks from PREPARATION-WO. Preserve original/shared data,credentials,containers/networks,worktree and transcripts by non-use. Record actual offline commands/exits and obtain QA review. R1 contract remains14services/13digests,two internal networks,three loopback candidate publications,ZERO anonymous volumes and unchanged numerical/operation budgets. No deployment is created by this decision.

Execution boundary:V0–V6,image pull/container start/restart/network mutation/DB connection,real credential inspection/generation/rotation,shared/cloud operations and commit/push/deploy remain FORBIDDEN. Offline adapters receive conspicuous dummy values only;runtime launcher must reject actual runtime invocation. Syntax/offline checks are not Windows ACL,network,revocation or restore proof. No per-gang LINE/Vault key changes or new notification worker.

Consequences:prepare manifest/guards/sinks/probes/backup-restore contracts and private-writer source without exercising real side effects. Runtime tools/ACL/egress-DNS/CDN/exposure/tenant/cache and actual restore remain open;exact command-ready runtime consent requires a later bounded package. B remains operational fallback;card20 paused/backend declaration PENDING/shared incident OPEN/cloud unknown.

Approved append only:existing baseline text/state/functions/goldens unchanged. Full preparation evidence lives at tools/test-env/. No claim that the prior unnumbered draft's future runtime recommendations are accepted.
