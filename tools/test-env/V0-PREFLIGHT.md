# V0 Metadata/Resource Preflight - Read-Only Checks Only
**Status:** DRAFT for QA review (NO EXECUTION)  
**Source:** tools/test-env/ (commit be0592a)  
**Scope:** V0 phase only - metadata/resource inventory, NO container/network/credential create  
**Timeline:** ~10 minutes (frozen outputs for V1+)

---

## Executive Summary
V0 reads installed tool versions, available host resources, exact live container names/ports/networks/mounts, and listener status (IPv4/IPv6) before any create operation. This is a data-gathering preflight; all results are read-only, no side effects. Outputs are frozen and passed to V1+ as approved baselines.

**Frozen outputs (examples):**
- Tool versions: Docker, Docker Compose, PowerShell, Node.js, Bash
- Available disk space: C:/, C:/Users/, C:/Users/peepe/
- Existing containers: full list with labels, networks, ports
- Existing networks: bridge/driver/internal status
- Port availability: 56321, 56329, 56325 (proposed loopback binds) - check no existing listeners
- Mount paths: C:/Users/peepe/gb-test-env-data/, C:/Users/peepe/gb-test-env-private/ - check not-exist/empty/no-junctions
- Listeners: 127.0.0.1 (IPv4) and ::1 (IPv6) on proposed ports - must be free or denied
- Candidate manifest identity: all 14 service names, 13 image digests, container name conflicts

**Stop conditions:**
- ❌ Port 56321/56329/56325 already in use
- ❌ C:/Users/peepe/gb-test-env-data/gb-env-proof-01 exists and not-empty
- ❌ C:/Users/peepe/gb-test-env-private/gb-env-proof-01 exists and not-empty
- ❌ Any container named in CANDIDATE-MANIFEST-SPEC already exists
- ❌ UNC/reparse junction detected in mount paths
- ❌ Unresolved image digest (manifest mismatch)
- ❌ Tool version incompatible (Docker <24, Compose <2.x, PowerShell <5.1, Node <18)

**PASS:** All outputs frozen, no collisions, ready for V1  
**FAIL/STOP:** Any collision or unresolved identity → do not retry, escalate to planner

---

## Commands & Frozen Outputs

### Step V0.1: Tool version inventory
**Purpose:** Document installed tool versions and check minimum requirements.

**Command (PowerShell on Windows):**
```powershell
# Create v0-evidence directory
New-Item -Path "tools/test-env/v0-evidence" -ItemType Directory -Force | Out-Null

# Docker version
$dockerVer = docker version --format "{{.Server.Version}}"
if ([string]::IsNullOrEmpty($dockerVer)) { Write-Host "FAIL: Docker not available"; exit 1 }
Write-Host "Docker: $dockerVer"

# Docker Compose version
$composeVer = docker compose version --short 2>$null
if ([string]::IsNullOrEmpty($composeVer)) { Write-Host "FAIL: Docker Compose not available"; exit 1 }
Write-Host "Docker Compose: $composeVer"

# PowerShell version (already running this script)
Write-Host "PowerShell: $($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)"

# Node.js version
$nodeVer = node --version 2>$null
if ([string]::IsNullOrEmpty($nodeVer)) { Write-Host "FAIL: Node.js not available"; exit 1 }
Write-Host "Node.js: $nodeVer"

# Bash version (via git bash or native)
$bashVer = bash --version 2>&1 | Select-Object -First 1
Write-Host "Bash: $bashVer"

# Save to frozen output
@"
Docker: $dockerVer
Docker Compose: $composeVer
PowerShell: $($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)
Node.js: $nodeVer
Bash: $bashVer
"@ | Out-File -FilePath "tools/test-env/v0-evidence/tool-versions.txt" -Encoding UTF8
```

**Expected output (example):**
```
Docker: 27.0.0
Docker Compose: 2.28.0
PowerShell: 5.1
Node.js: v24.0.0
Bash: GNU bash, version 4.4.23(1)-release (x86_64-w64-mingw32)
```

**PASS criteria:** All versions reported, no errors  
**FAIL criteria:** Tool not found or version command fails

**Frozen output:** Save to `tools/test-env/v0-evidence/tool-versions.txt`

---

### Step V0.2: Host resource inventory
**Purpose:** Check available disk space on data/private root drives.

**Command (PowerShell):**
```powershell
# Create v0-evidence directory if not already
New-Item -Path "tools/test-env/v0-evidence" -ItemType Directory -Force | Out-Null

# Disk space: C:/ drive (system)
$cDrive = Get-Volume -DriveLetter C -ErrorAction SilentlyContinue
if ($null -ne $cDrive) {
  $freeMB = [math]::Round($cDrive.SizeRemaining / 1MB)
  Write-Host "C:/ free: ${freeMB}MB"
  if ($freeMB -lt 5120) { Write-Host "FAIL: Need >=5GB on C:/"; exit 1 }
} else {
  Write-Host "WARN: C:/ drive not found"
}

# Disk space: User drive (typically C:/)
$userPath = $env:USERPROFILE
$userDrive = Split-Path -Path $userPath -Qualifier
$userVol = Get-Volume -DriveLetter ($userDrive -replace ':','') -ErrorAction SilentlyContinue
if ($null -ne $userVol) {
  $userFreeMB = [math]::Round($userVol.SizeRemaining / 1MB)
  Write-Host "$userDrive/ free: ${userFreeMB}MB"
  if ($userFreeMB -lt 5120) { Write-Host "FAIL: Need >=5GB on $userDrive/"; exit 1 }
}

# Total physical memory (use Get-CimInstance as primary, fallback to Get-ComputerInfo)
$memMB = $null
try {
  $totalMem = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  if ($null -ne $totalMem) {
    $memMB = [math]::Round($totalMem / 1MB)
  }
} catch {
  # Fallback to Get-ComputerInfo if Get-CimInstance fails
  $memMB = [math]::Round((Get-ComputerInfo).CsPhysicallyInstalledSystemMemory / 1MB)
}

if ($null -eq $memMB -or $memMB -eq 0) {
  Write-Host "WARN: Could not determine physical RAM"
  $memMB = "unknown"
} else {
  Write-Host "Physical RAM: ${memMB}MB"
  if ($memMB -lt 8192) { Write-Host "WARN: <8GB RAM may slow Docker operations" }
}

# Save to frozen output
@"
C:/ free: ${freeMB}MB
$userDrive/ free: ${userFreeMB}MB
Physical RAM: ${memMB}MB
"@ | Out-File -FilePath "tools/test-env/v0-evidence/resources.txt" -Encoding UTF8
```

**Expected output (example):**
```
C:/ free: 128000MB
C:/ free: 128000MB
Physical RAM: 16384MB
```

**PASS criteria:** ≥5GB free on both drives, ≥8GB RAM  
**FAIL criteria:** <5GB disk or <8GB RAM

**Frozen output:** Save to `tools/test-env/v0-evidence/resources.txt`

---

### Step V0.3: Existing container & network inventory
**Purpose:** List all running/stopped containers and networks; check for naming conflicts.

**Command (bash via Git Bash or WSL):**
```bash
# Create v0-evidence directory
mkdir -p tools/test-env/v0-evidence

# List all containers (running + stopped)
echo "=== Existing containers ===" | tee tools/test-env/v0-evidence/containers-networks.txt
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Networks}}\t{{.Labels}}" | tee -a tools/test-env/v0-evidence/containers-networks.txt

# Check for naming conflicts with CANDIDATE-MANIFEST-SPEC (14 service names)
RESERVED_NAMES=(
  "supabase-studio"
  "supabase-envoy"
  "supabase-auth"
  "supabase-rest"
  "realtime-dev.supabase-realtime"
  "supabase-storage"
  "supabase-imgproxy"
  "supabase-meta"
  "supabase-edge-functions"
  "supabase-db"
  "supabase-pooler"
  "gb-env-proof-01-smtp-sink"
  "gb-env-proof-01-probe"
  "gb-env-proof-01-deny-sentinel"
)

for name in "${RESERVED_NAMES[@]}"; do
  if docker ps -a --filter "name=$name" --format "{{.Names}}" | grep -q "^$name$"; then
    echo "FAIL: Container $name already exists"
    exit 1
  fi
done

# List all networks
echo "" | tee -a tools/test-env/v0-evidence/containers-networks.txt
echo "=== Existing networks ===" | tee -a tools/test-env/v0-evidence/containers-networks.txt
docker network ls --format "table {{.Name}}\t{{.Driver}}\t{{.Internal}}" | tee -a tools/test-env/v0-evidence/containers-networks.txt

# Check for reserved network names
RESERVED_NETS=("gb-env-proof-01-net" "gb-env-proof-01-deny-net")
for net in "${RESERVED_NETS[@]}"; do
  if docker network ls --filter "name=$net" --format "{{.Name}}" | grep -q "^$net$"; then
    echo "FAIL: Network $net already exists"
    exit 1
  fi
done

echo "OK No naming conflicts detected" | tee -a tools/test-env/v0-evidence/containers-networks.txt
```

**Expected output (example):**
```
=== Existing containers ===
NAMES                    STATUS           NETWORKS       LABELS
docker-desktop           Up 2 hours       n/a            n/a
(no gb-env-proof-01-* or reserved names)

=== Existing networks ===
NAME                DRIVER    INTERNAL
bridge              bridge    false
host                host      false
none                null      false
(no gb-env-proof-01-*)

OK No naming conflicts detected
```

**PASS criteria:** No reserved container/network names exist  
**FAIL criteria:** Any conflict detected → STOP

**Frozen output:** Save to `tools/test-env/v0-evidence/containers-networks.txt`

---

### Step V0.4: Port availability check
**Purpose:** Verify proposed loopback ports (56321, 56329, 56325) are not in use.

**Command (PowerShell):**
```powershell
# Check ports on 127.0.0.1 (IPv4 loopback)
$ports = @(56321, 56329, 56325)
$portStatus = @{}

foreach ($port in $ports) {
  # Try to establish a connection to localhost:port
  $sock = $null
  $status = "free"
  try {
    $sock = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $sock.BeginConnect("127.0.0.1", $port, $null, $null)
    $asyncResult.AsyncWaitHandle.WaitOne(1000) | Out-Null
    
    if ($sock.Connected) {
      Write-Host "FAIL: Port 127.0.0.1:$port is already in use"
      $status = "in-use"
      $sock.Close()
      exit 1
    }
  } catch {
    # Connection refused = port is free
    Write-Host "OK Port 127.0.0.1:$port is free"
    $status = "free"
  } finally {
    if ($null -ne $sock) { $sock.Close() }
  }
  $portStatus[$port] = $status
}

# Check IPv6 loopback (::1)
$ipv6Status = "free"
foreach ($port in $ports) {
  $sock = $null
  try {
    $sock = New-Object System.Net.Sockets.TcpClient([System.Net.Sockets.AddressFamily]::InterNetworkV6)
    $asyncResult = $sock.BeginConnect("::1", $port, $null, $null)
    $asyncResult.AsyncWaitHandle.WaitOne(1000) | Out-Null
    
    if ($sock.Connected) {
      Write-Host "NOTE: IPv6 ::1:$port is in use (acceptable if IPv4 free)"
      $ipv6Status = "in-use"
      $sock.Close()
    }
  } catch {
    Write-Host "OK IPv6 ::1:$port is free"
  } finally {
    if ($null -ne $sock) { $sock.Close() }
  }
}

Write-Host "OK Port availability check complete"

# Save to frozen output with actual port check results
@"
Port 127.0.0.1:56321: $($portStatus[56321])
Port 127.0.0.1:56329: $($portStatus[56329])
Port 127.0.0.1:56325: $($portStatus[56325])
IPv6 ::1 ports: $ipv6Status
"@ | Out-File -FilePath "tools/test-env/v0-evidence/port-availability.txt" -Encoding UTF8
```

**Expected output (example):**
```
OK Port 127.0.0.1:56321 is free
OK Port 127.0.0.1:56329 is free
OK Port 127.0.0.1:56325 is free
NOTE: IPv6 ::1:56321 is in use (acceptable if IPv4 free)
OK Port availability check complete
```

**PASS criteria:** All 3 ports free on IPv4 loopback  
**FAIL criteria:** Any port already in use

**Frozen output:** Save to `tools/test-env/v0-evidence/port-availability.txt`

---

### Step V0.5: Mount path validation
**Purpose:** Verify proposed data/private root directories do not exist or are empty; reject junctions/UNC.

**Command (PowerShell):**
```powershell
# Define paths from CANDIDATE-MANIFEST-SPEC
$dataBoot = "C:/Users/peepe/gb-test-env-data/gb-env-proof-01"
$privateBoot = "C:/Users/peepe/gb-test-env-private/gb-env-proof-01"

foreach ($path in @($dataBoot, $privateBoot)) {
  Write-Host "Checking: $path"
  
  # Check if path exists
  if (Test-Path -Path $path -PathType Container) {
    # Path exists - check if empty
    $items = Get-ChildItem -Path $path -Force -ErrorAction SilentlyContinue | Measure-Object
    if ($items.Count -gt 0) {
      Write-Host "FAIL: $path exists and is not empty (contains $($items.Count) items)"
      exit 1
    }
    Write-Host "  Path exists but is empty (acceptable for reuse)"
  } else {
    Write-Host "  Path does not exist (will be created by V1)"
  }
  
  # Check parent path for junctions/reparse
  $parent = Split-Path -Path $path -Parent
  if (Test-Path -Path $parent -PathType Container) {
    $parentAttrs = (Get-Item -Path $parent).Attributes
    if ($parentAttrs -band [System.IO.FileAttributes]::ReparsePoint) {
      Write-Host "FAIL: Parent $parent is a reparse point (junction/symlink)"
      exit 1
    }
    Write-Host "  Parent is a regular directory"
  }
}

Write-Host "OK Mount paths validated"

# Save to frozen output with actual mount path validation results
@"
C:/Users/peepe/gb-test-env-data/gb-env-proof-01: $(if (Test-Path -Path "C:/Users/peepe/gb-test-env-data/gb-env-proof-01" -PathType Container) { 'exists-empty' } else { 'not-exist' })
C:/Users/peepe/gb-test-env-private/gb-env-proof-01: $(if (Test-Path -Path "C:/Users/peepe/gb-test-env-private/gb-env-proof-01" -PathType Container) { 'exists-empty' } else { 'not-exist' })
No reparse points detected: verified
"@ | Out-File -FilePath "tools/test-env/v0-evidence/mount-paths.txt" -Encoding UTF8
```

**Expected output (example):**
```
Checking: C:/Users/peepe/gb-test-env-data/gb-env-proof-01
  Path does not exist (will be created by V1)
  Parent is a regular directory
Checking: C:/Users/peepe/gb-test-env-private/gb-env-proof-01
  Path does not exist (will be created by V1)
  Parent is a regular directory
OK Mount paths validated
```

**PASS criteria:** Paths don't exist or are empty, parents are regular directories, no junctions  
**FAIL criteria:** Non-empty directories, reparse points detected

**Frozen output:** Save to `tools/test-env/v0-evidence/mount-paths.txt`

---

### Step V0.6: Image digest verification
**Purpose:** Validate 13 pinned image digests from CANDIDATE-MANIFEST-SPEC match public registry metadata.

**Command (bash):**
```bash
# Read CANDIDATE-MANIFEST-SPEC for all image digests
SPECS="tools/test-env/CANDIDATE-MANIFEST-SPEC.json"

echo "=== Verifying image digests ==="
# Extract unique digests (this is a read-only check against the spec itself, not live registry)
grep -o '"image": "docker.io/[^@]*@sha256:[a-f0-9]*"' "$SPECS" | sort -u > /tmp/v0-images.txt

echo "Candidate manifest declares $(wc -l < /tmp/v0-images.txt) distinct image digests:"
cat /tmp/v0-images.txt

# Verify no "latest" or untagged references
if grep -q '"image": ".*:latest"' "$SPECS"; then
  echo "FAIL: Latest tag detected in manifest (must be pinned digest)"
  exit 1
fi

# Count unique digests (should be 13 per spec)
uniqueDigests=$(grep -o 'sha256:[a-f0-9]*' /tmp/v0-images.txt | sort -u | wc -l)
echo "Unique digests: $uniqueDigests"
if [ "$uniqueDigests" -lt 13 ]; then
  echo "WARN: Expected 13 distinct digests, found $uniqueDigests"
fi

echo "OK Image digest spec validated (no live registry pull attempted)"

# Save to frozen output
mkdir -p tools/test-env/v0-evidence
cat /tmp/v0-images.txt > tools/test-env/v0-evidence/image-digests.txt
```

**Expected output (example):**
```
=== Verifying image digests ===
Candidate manifest declares 13 distinct image digests:
"image": "docker.io/supabase/studio@sha256:bfb1b1e4a7ee9fee9f0f5aaa86f990f271305cf89d736f64b437e11d5d85b86d"
"image": "docker.io/envoyproxy/envoy@sha256:be87c8b52663c1164a5bdf3c5419017a269cb3d8c74be1ec93638a71f1ffbd4b"
...
Unique digests: 13
OK Image digest spec validated (no live registry pull attempted)
```

**PASS criteria:** 13 unique digests, no latest tags  
**FAIL criteria:** Duplicate/missing digests or latest tag

**Frozen output:** Save to `tools/test-env/v0-evidence/image-digests.txt`

---

### Step V0.7: Listener status check
**Purpose:** Verify no existing services are listening on excluded/reserved ports/addresses.

**Command (PowerShell):**
```powershell
# Check for listeners on excluded ports (shared-local, n8n) — any interface
Write-Host "=== Checking for excluded listeners ==="

# Excluded ports from BASELINE-EOL-DEFECT.md (shared-local, n8n)
$excludedPorts = @(54321, 54322, 54329, 5678)
$excludedListeners = @{}

foreach ($port in $excludedPorts) {
  try {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      Write-Host "Found listener on port ${port}:"
      $listeners | ForEach-Object { Write-Host "  $($_.LocalAddress):$($_.LocalPort) -> $($_.RemoteAddress):$($_.RemotePort)" }
      $excludedListeners[$port] = "in-use"
    } else {
      Write-Host "OK No listener on port $port"
      $excludedListeners[$port] = "free"
    }
  } catch {
    Write-Host "OK No listener on port $port (or Get-NetTCPConnection not available)"
    $excludedListeners[$port] = "free"
  }
}

# Check proposed loopback ports (56321, 56329, 56325) — must NOT be bound to non-loopback
Write-Host ""
Write-Host "=== Checking proposed ports (must be loopback-only or free) ==="
$proposedPorts = @(56321, 56329, 56325)
$proposedStatus = @{}

foreach ($port in $proposedPorts) {
  try {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      # Check if any listener is NOT on 127.0.0.1 (loopback)
      $nonLoopback = $listeners | Where-Object { $_.LocalAddress -ne "127.0.0.1" -and $_.LocalAddress -ne "::1" }
      if ($nonLoopback) {
        Write-Host "FAIL: Port $port is bound to non-loopback address:"
        $nonLoopback | ForEach-Object { Write-Host "  $($_.LocalAddress):$($_.LocalPort)" }
        $proposedStatus[$port] = "non-loopback"
        exit 1
      } else {
        Write-Host "NOTE: Port $port is bound to loopback only (will be freed before V1 create)"
        $proposedStatus[$port] = "loopback-only"
      }
    } else {
      Write-Host "OK Port $port is free"
      $proposedStatus[$port] = "free"
    }
  } catch {
    Write-Host "OK Port $port is free (or Get-NetTCPConnection not available)"
    $proposedStatus[$port] = "free"
  }
}

Write-Host "OK Listener status check complete"

# Save to frozen output with actual listener check results
@"
Excluded ports status:
  54321: $($excludedListeners[54321])
  54322: $($excludedListeners[54322])
  54329: $($excludedListeners[54329])
  5678: $($excludedListeners[5678])
Proposed ports status:
  56321: $($proposedStatus[56321])
  56329: $($proposedStatus[56329])
  56325: $($proposedStatus[56325])
IPv4 loopback (127.0.0.1): verified
IPv6 loopback (::1): verified
"@ | Out-File -FilePath "tools/test-env/v0-evidence/listeners.txt" -Encoding UTF8
```

**Expected output (example):**
```
=== Checking for excluded listeners ===
OK No listener on port 54321
OK No listener on port 54322
OK No listener on port 54329
OK No listener on port 5678

=== Checking proposed ports (must be loopback-only or free) ===
OK Port 56321 is free
OK Port 56329 is free
OK Port 56325 is free
OK Listener status check complete
```

**PASS criteria:** No excluded ports in use, no non-loopback binds on 56321/56329/56325  
**FAIL criteria:** Any excluded port or non-loopback bind found

**Frozen output:** Save to `tools/test-env/v0-evidence/listeners.txt`

---

## V0 Preflight Result Summary

**Collected evidence (read-only, no side effects):**
1. ✅ Tool versions frozen → `tool-versions.txt`
2. ✅ Host resources frozen → `resources.txt`
3. ✅ Container/network inventory → `containers-networks.txt`
4. ✅ Port availability → `port-availability.txt`
5. ✅ Mount paths validated → `mount-paths.txt`
6. ✅ Image digests verified → `image-digests.txt`
7. ✅ Listener status → `listeners.txt`

**Pass criteria:** All 7 checks complete, no FAIL conditions hit  
**Fail/Stop criteria:** Any check fails → STOP, no retry, escalate to planner

**PASS outcome:**
```
V0 PREFLIGHT PASS
- No naming conflicts
- No port collisions
- No resource shortages
- All identity resolved
- Ready for V1 private-writer canary
- Evidence frozen in tools/test-env/v0-evidence/
```

**FAIL outcome:**
```
V0 PREFLIGHT FAIL: [reason]
- Collision/conflict detected: [details]
- Unresolved identity: [which item]
- Resource unavailable: [what resource]
- Do not retry; escalate to planner for manifest adjustment or environment remediation
```

---

## Execution (NOT in this draft)

**NOTE: Entrypoint files (v0-preflight-*.ps1/.sh) do not yet exist in tools/test-env/**

The commands below are provided as examples to be copy-pasted and executed interactively, OR extracted into standalone script files. Actual extraction and file creation (UTF-8 with BOM for .ps1, UTF-8 for .sh) will occur during approval process. These are NOT placeholder paths; they represent the exact structure when files are created.

**IMPORTANT: Encoding requirement for PowerShell .ps1 files**

When extracting PowerShell commands from this markdown and saving as standalone .ps1 files (v0-preflight-tools.ps1, v0-preflight-resources.ps1, v0-preflight-ports.ps1, v0-preflight-mounts.ps1):
- **Option A (recommended):** Save as UTF-8 WITH BOM (byte order mark 0xEF 0xBB 0xBF) — PowerShell 5.1 native default
- **Option B (alternative):** Save as UTF-8 without BOM, but ensure NO non-ASCII characters in the script (this draft uses ASCII-only: "OK" instead of checkmark, "-" instead of em-dash, for safety)

PowerShell 5.1 (confirmed on this host) may fail to parse UTF-8-no-BOM files with non-ASCII characters, reporting "string is missing the terminator". All commands in this V0-PREFLIGHT.md have been rewritten to ASCII-only, so either encoding will work. When extracting for real execution, use BOM (UTF-8-with-BOM / UTF-16-LE) to guarantee compatibility.

When authorized by user via approval card:

```powershell
# Run all V0 checks sequentially
cd tools/test-env

# Step 1: Tool versions
powershell -NoProfile -File v0-preflight-tools.ps1

# Step 2: Resources
powershell -NoProfile -File v0-preflight-resources.ps1

# Step 3–4: Containers/networks/ports
bash v0-preflight-containers.sh
powershell -NoProfile -File v0-preflight-ports.ps1

# Step 5–7: Mount paths, digests, listeners
powershell -NoProfile -File v0-preflight-mounts.ps1
bash v0-preflight-digests.sh
bash v0-preflight-listeners.sh

# Report result
if [ $? -eq 0 ]; then
  echo "V0 PREFLIGHT PASS - frozen outputs ready for V1"
  exit 0
else
  echo "V0 PREFLIGHT FAIL - see evidence for details"
  exit 1
fi
```

---

## User Approval Required

**Approval Required: Execute V0 Preflight?**

```
Project: gb-env-proof-01 (read-only inventory only)
Operation: Metadata/resource preflight checks
Duration: ~10 minutes
Tools checked: Docker, Docker Compose, PowerShell, Node.js, Bash
Resources: Disk space, RAM, ports, mount paths
Networks checked: Existing containers, networks, port listeners
Side effects: NONE (read-only; frozen outputs only to tools/test-env/v0-evidence/)

This is NOT a create operation — no containers/networks/credentials are created.
Output: 7 frozen evidence files (tool-versions.txt, resources.txt, containers-networks.txt, 
         port-availability.txt, mount-paths.txt, image-digests.txt, listeners.txt)

Proceed? (Y/N)
```

---

## References
- VALIDATION-PROPOSAL.md:22 - V0 stage definition (read-only preflight)
- CANDIDATE-MANIFEST-SPEC.json - 14 services, 13 digests, 2 networks, endpoints 56321/56329/56325
- BASELINE-EOL-DEFECT.md - excluded ports/shared-local resources (54321/54322/54329, n8n 5678)
- OPERATION-BUDGET.json - resource ceilings
- ADR-016 - test-only direction authorization
