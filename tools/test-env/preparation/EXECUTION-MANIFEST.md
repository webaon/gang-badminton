# Preparation execution manifest — OFFLINE ONLY

Explicit user/planner preparation grant covers these local synthetic checks. None is a V0–V6 command. No dependencies installed. Node observedv24.15.0. PowerShell parser is used without invoking writer functions. No Docker/Compose/DB/real-key/ACL side effects.

## Exact approved offline gates

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/backup-restore.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/cleanup.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/egress-policy.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/lifecycle-budget.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/model-builder.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/output-boundary.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/probes/deny-sentinel.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/probes/egress-probes.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/probes/http-sink.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/probes/verifier-probes.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/runtime-launcher.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/target-guard.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/tests/static-contract.test.cjs

Expected exit 0:

    node --check C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/functions/main/index.ts

Expected exit 0:

    node --test C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/tests/static-contract.test.cjs

Expected exit 0:

    node C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/runtime-launcher.cjs --offline-check

Expected exit 2:

    node C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/runtime-launcher.cjs --invalid-offline-flag

Expected exit 0:

    powershell.exe -NoProfile -NonInteractive -Command '$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("C:/Users/peepe/.hermes/profiles/gb-integrations/cache/scratch/test-environment-proposal/preparation/private-writer.ps1",[ref]$t,[ref]$e); if($e.Count -gt 0){exit 1}; Write-Output "writer_parse=PASS; writer_execution=NOT_RUN"'

## Status boundaries / real operations deliberately absent

The CLI supports --offline-check ONLY;other arguments are rejected with exit2/metadata BLOCKED. No runtime adapter is wired. APIs are transport-independent pure contracts and request/transcript evaluators,not a real network verifier. Injected adapters in tests are counters/CAS memory fixtures only. HTTP/sentinel request handlers are not bound to sockets. Windows writer is source+syntax only,not invoked or ACL-proven.

backup-restore.cjs currently supports the owned proof_fixture schema contract only and rejects auth/storage/other managed-schema restoration. A full selective managed-row/object/role restore recipe and exact live tools/flags remain BLOCKED rather than guessed. Real disk CAS storage,private source-copy/render transport,physical worker propagation,actual SMTP/TCP/every-verifier probes,CDN/acquisition and source-build attestation remain later readiness items. No fake live API results are supplied.

Do NOT infer runtime readiness from offline PASS. A later command-ready V0–V6 manifest requires separately reviewed adapters,actual tool/version/target compatibility,exact commands and user execution approval. No placeholder command is preapproved here.
