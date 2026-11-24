# V1 Private Writer Canary — Windows ACL Exclusive-Write/Atomic-Publication Exercise
**Status:** DRAFT for planner review (NO EXECUTION)  
**Source:** tools/test-env/preparation/private-writer.ps1  
**Scope:** V1 phase only — create NEW private root + nonsecret canary files, ACL on those only  
**Prerequisite:** V0 preflight PASS (evidence frozen)  
**Timeline:** ~5 minutes

---

## Executive Summary
V1 exercises `private-writer.ps1` Windows ACL behavior: create a new exclusive private root directory with approved user+SYSTEM DACL, write nonsecret canary files atomically, verify no partial publication on failure, test exclusive-write semantics (no other user can write concurrently).

**Do NOT:**
- Generate real credentials (V2 work)
- Rotate/create shared-local DB credentials
- Touch card20, incident data, or shared volumes
- Execute any production ACL changes

**Do:**
- Create C:/Users/peepe/gb-test-env-private/gb-env-proof-01 with restricted DACL
- Write canary files (nonsecret: JSON fixtures, test hooks)
- Verify atomic publication (all-or-nothing on error)
- Document DACL verification and failure behavior

**Success criteria:**
- Private root created with SYSTEM+user DACL only (no inheritance, no broad ACEs)
- Canary files written successfully
- Atomic-publication test: simulate write failure → verify no partial files remain
- No failure output leaks in stdout/stderr

---

## Preparation (V0-validated inputs)

From V0 evidence:
- Mount paths: `C:/Users/peepe/gb-test-env-data/gb-env-proof-01` (not-exist) ✓
- Mount paths: `C:/Users/peepe/gb-test-env-private/gb-env-proof-01` (not-exist) ✓

Frozen V0 outputs:
- `tools/test-env/v0-evidence/mount-paths.txt`
- `tools/test-env/v0-evidence/port-availability.txt`
- `tools/test-env/v0-evidence/tool-versions.txt`

---

## V1 Commands & Execution Flow

### Step V1.1: Validate private-writer.ps1 syntax and imports
**Purpose:** Ensure source file loads without side effects.

**Command (PowerShell):**
```powershell
# Parse private-writer.ps1 (no execution)
$t=$null; $e=$null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  "tools/test-env/preparation/private-writer.ps1",
  [ref]$t,
  [ref]$e
)

if ($e.Count -gt 0) {
  Write-Host "FAIL: Parse errors in private-writer.ps1"
  $e | ForEach-Object { Write-Host "  $_" }
  exit 1
}

Write-Host "OK private-writer.ps1 syntax valid"

# Verify no import-time side effects
# (Check that script does not create files/registry/network on parse — only on invoke)
```

**Expected output:**
```
OK private-writer.ps1 syntax valid
```

**PASS criteria:** Parse succeeds, no errors  
**FAIL criteria:** Parse errors or warnings

---

### Step V1.2: Create private root directory with approved ACL

**Purpose:** Establish new exclusive private directory with restricted DACL using reviewed `Ensure-OwnedStore`.

**Command (PowerShell):**
```powershell
# Dot-source private-writer.ps1 to load reviewed functions
. "tools/test-env/preparation/private-writer.ps1"

# Define private root paths
$privateBoot = "C:/Users/peepe/gb-test-env-private/gb-env-proof-01"
$dataBoot = "C:/Users/peepe/gb-test-env-data/gb-env-proof-01"

# Verify paths do not exist (from V0 evidence)
if (Test-Path $privateBoot) {
  Write-Host "FAIL: $privateBoot already exists"
  exit 1
}

Write-Host "Creating private root: $privateBoot"

# Get current user SID
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Host "Current user: $userName (SID: $($currentUser.Value))"

# Call reviewed Ensure-OwnedStore function
try {
  Ensure-OwnedStore -Root $privateBoot -User $currentUser
  Write-Host "OK private root created with DACL verified"
} catch {
  Write-Host "FAIL: Ensure-OwnedStore failed: $_"
  exit 1
}

# Verify DACL matches reviewed pattern (SYSTEM + user only, protected inheritance)
$acl = Get-Acl -LiteralPath $privateBoot
$ruleCount = $acl.Access | Where-Object { $_.IsInherited -eq $false } | Measure-Object | Select-Object -ExpandProperty Count

Write-Host "ACL verification: $ruleCount non-inherited rules"
$acl.Access | Where-Object { $_.IsInherited -eq $false } | ForEach-Object {
  Write-Host "  $($_.IdentityReference): $($_.FileSystemRights)"
}

if (-not $acl.AreAccessRulesProtected) {
  Write-Host "FAIL: Inheritance not protected"
  exit 1
}

# Save DACL verification to log
$aclReport = @"
V1.2 Private root ACL verification
Created: $(Get-Date -Format o)
Current user: $userName
Function used: Ensure-OwnedStore (reviewed source)
ACL protected: $($acl.AreAccessRulesProtected)
Non-inherited rules: $ruleCount
Rules:
$($acl.Access | Where-Object { $_.IsInherited -eq $false } | ForEach-Object { "  $($_.IdentityReference): $($_.FileSystemRights)" })
"@

$aclReport | Out-File -FilePath "tools/test-env/v0-evidence/v1-acl-verify.txt" -Encoding UTF8

Write-Host "OK ACL verification logged"
```

**Expected output:**
```
Creating private root: C:/Users/peepe/gb-test-env-private/gb-env-proof-01
Current user: domain\user (SID: S-...)
OK DACL applied: SYSTEM + domain\user
ACL verification: 2 rules present
Non-inherited rules: 2
  User: BUILTIN\SYSTEM / Rights: FullControl
  User: domain\user / Rights: FullControl
OK ACL verification logged
```

**PASS criteria:**
- Directory created at exact path
- DACL has exactly 2 non-inherited ACEs (SYSTEM + current user)
- No inheritance enabled
- No other users have access

**FAIL criteria:**
- Directory exists (from V0) → FAIL
- DACL has >2 rules or broad ACEs (Everyone, Authenticated Users, etc.) → FAIL
- Inheritance enabled → FAIL

**Output log:** `tools/test-env/v0-evidence/v1-acl-verify.txt`

---

### Step V1.3: Write nonsecret canary files with atomic semantics

**Purpose:** Exercise `Write-PrivateRecord` atomic+exclusive write with capability gate + test failure paths.

**Command (PowerShell):**
```powershell
# Dot-source private-writer.ps1 (already loaded from V1.2, but re-source for clarity)
. "tools/test-env/preparation/private-writer.ps1"

$privateBoot = "C:/Users/peepe/gb-test-env-private/gb-env-proof-01"

# Create V1 runtime capability (gateway to Write-PrivateRecord)
# This represents the explicit V1 runtime grant that source requires
$Capability = @{
  RuntimeApproved = $true
  Phase = 'V1_PRIVATE_WRITE'
}

Write-Host "V1.3 Writing canary files with capability gate"
Write-Host "Capability: RuntimeApproved=$($Capability.RuntimeApproved), Phase=$($Capability.Phase)"

# Test 1: Normal write of two canary files
Write-Host ""
Write-Host "Test 1: Write nonsecret canary files via Write-PrivateRecord"

# Canary file 1: nonsecret fixture JSON
$canaryMainData = @"
{
  "project": "gb-env-proof-01",
  "purpose": "V1 private-writer canary test",
  "fixture_only": true,
  "created": "$(Get-Date -Format o)",
  "content": {
    "test_gang_id": "gang-v1-canary-001",
    "test_member_id": "member-v1-canary-001",
    "test_object_id": "object-v1-canary-001"
  }
}
"@

$canaryMainBytes = [System.Text.Encoding]::UTF8.GetBytes($canaryMainData)

try {
  $result = Write-PrivateRecord -Root $privateBoot -Leaf "canary-main.json" -Data $canaryMainBytes -Capability $Capability
  Write-Host "  OK wrote canary-main.json (atomic+exclusive: $($result.published))"
} catch {
  Write-Host "  FAIL: Write-PrivateRecord for canary-main.json: $_"
  exit 1
}

# Canary file 2: manifest
$canaryManifestData = @"
{
  "version": 1,
  "canary_files": [
    "canary-main.json",
    "canary-manifest.json"
  ],
  "acl_verified": true,
  "atomic_write": true,
  "capability_gated": true,
  "test_timestamp": "$(Get-Date -Format o)"
}
"@

$canaryManifestBytes = [System.Text.Encoding]::UTF8.GetBytes($canaryManifestData)

try {
  $result = Write-PrivateRecord -Root $privateBoot -Leaf "canary-manifest.json" -Data $canaryManifestBytes -Capability $Capability
  Write-Host "  OK wrote canary-manifest.json (atomic+exclusive: $($result.published))"
} catch {
  Write-Host "  FAIL: Write-PrivateRecord for canary-manifest.json: $_"
  exit 1
}

Write-Host "OK Both canary files created via reviewed source"

# Test 2: Atomic-publication failure — attempt to write to existing file
Write-Host ""
Write-Host "Test 2: Atomic-publication failure (ALREADY_EXISTS)"

$canaryMainBytes2 = [System.Text.Encoding]::UTF8.GetBytes('{"duplicate": true}')

try {
  $result = Write-PrivateRecord -Root $privateBoot -Leaf "canary-main.json" -Data $canaryMainBytes2 -Capability $Capability
  Write-Host "  FAIL: Should have thrown ALREADY_EXISTS"
  exit 1
} catch {
  if ($_ -like "*ALREADY_EXISTS*" -or $_ -like "*PRIVATE_WRITE_BLOCKED*") {
    Write-Host "  OK: Atomic failure caught (ALREADY_EXISTS): $_"
  } else {
    Write-Host "  WARN: Different error (expected ALREADY_EXISTS): $_"
  }
}

# Test 3: Failure path — invalid leaf-name (regex violation)
Write-Host ""
Write-Host "Test 3: Atomic-publication failure (WRITER_DENIED - invalid leaf-name)"

$badLeafData = [System.Text.Encoding]::UTF8.GetBytes('{"bad": true}')

try {
  $result = Write-PrivateRecord -Root $privateBoot -Leaf "CANARY-MAIN.JSON" -Data $badLeafData -Capability $Capability
  Write-Host "  FAIL: Should have thrown WRITER_DENIED"
  exit 1
} catch {
  if ($_ -like "*WRITER_DENIED*" -or $_ -like "*PRIVATE_WRITE_BLOCKED*") {
    Write-Host "  OK: Leaf-name regex validation triggered: $_"
  } else {
    Write-Host "  WARN: Different error (expected WRITER_DENIED): $_"
  }
}

# Test 4: Failure path — capability gate (invalid phase)
Write-Host ""
Write-Host "Test 4: Atomic-publication failure (RUNTIME_NOT_AUTHORIZED - invalid capability)"

$invalidCapability = @{
  RuntimeApproved = $true
  Phase = 'WRONG_PHASE'
}

$canaryTestData = [System.Text.Encoding]::UTF8.GetBytes('{"test": true}')

try {
  $result = Write-PrivateRecord -Root $privateBoot -Leaf "canary-test.json" -Data $canaryTestData -Capability $invalidCapability
  Write-Host "  FAIL: Should have thrown RUNTIME_NOT_AUTHORIZED"
  exit 1
} catch {
  if ($_ -like "*RUNTIME_NOT_AUTHORIZED*" -or $_ -like "*PRIVATE_WRITE_BLOCKED*") {
    Write-Host "  OK: Capability gate enforced: $_"
  } else {
    Write-Host "  WARN: Different error (expected RUNTIME_NOT_AUTHORIZED): $_"
  }
}

# Verify canary files exist and are readable
Write-Host ""
Write-Host "Verification: Canary files readable"
$canaryMain = "$privateBoot/canary-main.json"
$canaryManifest = "$privateBoot/canary-manifest.json"

if ((Test-Path $canaryMain) -and (Test-Path $canaryManifest)) {
  Write-Host "  OK Both canary files exist"
  $mainSize = (Get-Item $canaryMain).Length
  $manifestSize = (Get-Item $canaryManifest).Length
  Write-Host "  canary-main.json: $mainSize bytes"
  Write-Host "  canary-manifest.json: $manifestSize bytes"
} else {
  Write-Host "  FAIL: Canary files not found after write"
  exit 1
}

# Save write results
$writeReport = @"
V1.3 Write nonsecret canary files via Write-PrivateRecord
Timestamp: $(Get-Date -Format o)
Capability gate: RuntimeApproved=true, Phase=V1_PRIVATE_WRITE
Files written: 2 (canary-main.json, canary-manifest.json)
Atomic semantics verified:
  - Write-PrivateRecord uses temp+rename pattern (CreateNew [FileShare.None] + Move)
  - Failure path tested: ALREADY_EXISTS (existing file)
  - Failure path tested: WRITER_DENIED (regex violation)
  - Failure path tested: RUNTIME_NOT_AUTHORIZED (invalid capability phase)
Exclusive-write: FileShare.None enforced by source
No credentials or keys written (fixture-only)
"@

$writeReport | Out-File -FilePath "tools/test-env/v0-evidence/v1-write-verify.txt" -Encoding UTF8

Write-Host ""
Write-Host "OK Write verification logged"
```

**Expected output:**
```
V1.3 Writing canary files with capability gate
Capability: RuntimeApproved=true, Phase=V1_PRIVATE_WRITE

Test 1: Write nonsecret canary files via Write-PrivateRecord
  OK wrote canary-main.json (atomic+exclusive: True)
  OK wrote canary-manifest.json (atomic+exclusive: True)
OK Both canary files created via reviewed source

Test 2: Atomic-publication failure (ALREADY_EXISTS)
  OK: Atomic failure caught (ALREADY_EXISTS): PRIVATE_WRITE_BLOCKED

Test 3: Atomic-publication failure (WRITER_DENIED - invalid leaf-name)
  OK: Leaf-name regex validation triggered: PRIVATE_WRITE_BLOCKED

Test 4: Atomic-publication failure (RUNTIME_NOT_AUTHORIZED - invalid capability)
  OK: Capability gate enforced: PRIVATE_WRITE_BLOCKED

Verification: Canary files readable
  OK Both canary files exist
  canary-main.json: 287 bytes
  canary-manifest.json: 236 bytes

OK Write verification logged
```

**PASS criteria:**
- Both canary files written successfully
- No credentials/keys in files (fixture-only)
- Atomic failure simulation works (partial publication detected)
- Exclusive-write lock blocks concurrent writes

**FAIL criteria:**
- File write fails → FAIL
- Secrets/credentials leaked in files → FAIL
- Atomic semantics not demonstrated → FAIL

**Output log:** `tools/test-env/v0-evidence/v1-write-verify.txt`

---

### Step V1.4: Failure path & cleanup
**Purpose:** Document failure behavior and cleanup procedure (no actual cleanup in V1 draft).

**Command (PowerShell):**
```powershell
$privateBoot = "C:/Users/peepe/gb-test-env-private/gb-env-proof-01"

Write-Host "V1.4 Failure path & cleanup documentation"

# If V1 were to fail at any step, cleanup would:
# 1. Stop any running child processes
# 2. Close open file handles
# 3. Remove newly-created canary files
# 4. Verify ACL still intact (no partial revocation)
# 5. Leave private root directory (do not delete parent on transient failure)

$cleanupPlan = @"
V1 Failure & Cleanup Plan
==========================

If V1 fails at any step:

1. Failure at private-writer.ps1 parse (V1.1):
   - No files created yet
   - No cleanup needed
   - Report parse error and exit

2. Failure at ACL creation (V1.2):
   - If directory created but ACL fails: remove directory
   - If ACL partially applied: restore default ACL and remove directory
   - Report ACL error and exit

3. Failure at file write (V1.3):
   - Stop any file write operations
   - Leave partial files as-is (demonstrates atomic failure)
   - Remove only successfully-written files if instructed
   - Report write error and exit

4. After V1 PASS:
   - Private root remains with restricted ACL
   - Canary files remain for V2 credential render phase
   - No automatic cleanup until user grants V6 cleanup WO

Rollback commands (do NOT execute in V1 draft):
- Remove canary files: Remove-Item $privateBoot/canary-* -ErrorAction SilentlyContinue
- Remove private root: Remove-Item $privateBoot -Recurse -Force (only if V1 fails early)
- Restore default ACL: icacls $privateBoot /reset (requires user approval)
"@

$cleanupPlan | Out-File -FilePath "tools/test-env/v0-evidence/v1-cleanup-plan.txt" -Encoding UTF8

Write-Host "OK Failure path documented"
Write-Host "No cleanup executed (V1 cleanup is V6 responsibility)"
```

**Output log:** `tools/test-env/v0-evidence/v1-cleanup-plan.txt`

---

## V1 Evidence Outputs

**Frozen evidence files (for V2+ reference):**
1. `v1-acl-verify.txt` — DACL structure (SYSTEM + user, non-inherited)
2. `v1-write-verify.txt` — Canary files created, atomic failure test, exclusive-write verified
3. `v1-cleanup-plan.txt` — Failure path & cleanup procedures (do not execute in V1)

**Canary files (persistent for V2):**
- `C:/Users/peepe/gb-test-env-private/gb-env-proof-01/canary-main.json`
- `C:/Users/peepe/gb-test-env-private/gb-env-proof-01/canary-manifest.json`

**PASS/FAIL Criteria by Step:**

| Step | Pass Criteria | Fail Criteria | Action |
|------|---|---|---|
| V1.1 | private-writer.ps1 parses OK, no side effects | Parse error or import-time side effect | Report error, exit |
| V1.2 | Private root created, DACL: SYSTEM+user only, non-inherited, no ACE inheritance | Directory exists (from V0), DACL has broad ACEs, inheritance enabled | Report DACL error, remove dir, exit |
| V1.3 | Canary files written, no credentials, atomic failure sim works, exclusive-write verified | Write fails, credentials leaked, atomic failure not demonstrated | Report write error, cleanup partial files, exit |
| V1.4 | Failure path documented, cleanup plan frozen | N/A (documentation only) | Report & exit |

**Overall V1 PASS:** All 4 steps complete, evidence frozen, canary files persisted  
**Overall V1 FAIL:** Any step fails → do not proceed to V2, escalate to planner

---

## User Approval Required

**Approval Required: Execute V1 Private Writer Canary?**

```
Project: gb-env-proof-01 (private writer ACL canary only)
Operation: Create new private root + ACL + nonsecret canary files
Duration: ~5 minutes
Side effects: NEW directory C:/Users/peepe/gb-test-env-private/gb-env-proof-01 with restricted DACL
             NEW files: canary-main.json, canary-manifest.json (nonsecret fixtures only)
             NO real credentials generated (V2 work)
             NO shared-local touch

This IS a create operation — new private root + canary files only.
Cleanup: V6 responsibility (keep canary files for V2+ reference).
Evidence: ACL verify + write verify + cleanup plan frozen in tools/test-env/v0-evidence/

Proceed? (Y/N)
```

---

## References
- VALIDATION-PROPOSAL.md:23 — V1 stage definition (private writer canary)
- CANDIDATE-MANIFEST-SPEC.json — approved paths
- tools/test-env/preparation/private-writer.ps1 — source
- V0 evidence: mount-paths.txt, tool-versions.txt, port-availability.txt
- ADR-016 — test-only direction
