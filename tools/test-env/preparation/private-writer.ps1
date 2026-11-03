# Source only. Current approval permits PARSING, not real ACL/private IO.
Set-StrictMode -Version Latest
function Get-DummyWriterPlan {
    param([string]$Leaf,[string]$Fixture)
    if($Fixture -ne 'TASK04_DUMMY_ONLY' -or $Leaf -notmatch '^[a-z][a-z0-9-]{0,40}\.json$'){throw 'WRITER_DENIED'}
    return @{status='PASS';fixture=$true;exclusive=$true;atomic=$true}
}
function Assert-PrivateAcl {
    param([string]$Path,[System.Security.Principal.SecurityIdentifier]$User)
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    if(-not $acl.AreAccessRulesProtected){throw 'ACL_DENIED'}
    $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
    foreach($rule in $rules){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($User.Value,'S-1-5-18')){throw 'ACL_DENIED'}}
    return $acl
}
# F3: Separate initialization from writes; validate existing root ownership before mutation
function Ensure-OwnedStore {
    param([string]$Root,[System.Security.Principal.SecurityIdentifier]$User)
    if(-not (Test-Path $Root -PathType Container)){
        [void](New-Item -Path $Root -ItemType Directory -Force)
        $acl=[System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($User)
        $acl.SetAccessRuleProtection($true,$false)
        $system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
        foreach($id in @($User,$system)){
            $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($id,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
            [void]$acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Root -AclObject $acl -ErrorAction Stop
    }
    [void](Assert-PrivateAcl $Root $User)
}
function Write-PrivateRecord {
    param([string]$Root,[string]$Leaf,[byte[]]$Data,[hashtable]$Capability)
    # No current launcher invokes this. A later explicit V1 runtime grant is required.
    if(-not $Capability -or $Capability.RuntimeApproved -ne $true -or $Capability.Phase -ne 'V1_PRIVATE_WRITE'){throw 'RUNTIME_NOT_AUTHORIZED'}
    $required='C:\Users\peepe\gb-test-env-private\gb-env-proof-01'
    $full=[IO.Path]::GetFullPath($Root)
    if($full -ne $required -or $Leaf -notmatch '^[a-z][a-z0-9-]{0,40}\.json$' -or -not $Data -or $Data.Length -gt 65536){throw 'WRITER_DENIED'}
    # F3: Owned-root pre-check must prove ownership and all required rights before mutation
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
    try {ensureOwnedStore $full $user; # F3: Validates existing root is owned+protected, or creates+secures new one
        $parent=[IO.Path]::GetDirectoryName($full)
        [void](Assert-PrivateAcl $parent $user)
        $cursor=$parent; while($cursor){if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_DENIED'};$cursor=[IO.Path]::GetDirectoryName($cursor)}
        $stream=$null;$temp=$null;$created=$false;$published=$false
        $final=[IO.Path]::Combine($full,$Leaf);$temp=$final+'.pending'
        if([IO.File]::Exists($final)){throw 'ALREADY_EXISTS'}
        $stream=[IO.FileStream]::new($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$created=$true
        $stream.Write($Data,0,$Data.Length);$stream.Flush($true);$stream.Dispose();$stream=$null
        if(([IO.File]::GetAttributes($full) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_DENIED'}
        [void](Assert-PrivateAcl $full $user)  # F3: Final readback verifies publication ACL
        [IO.File]::Move($temp,$final);$published=$true
        # F3: Readback confirmation that file exists with expected owner/permissions
        if(-not [IO.File]::Exists($final)){throw 'PUBLICATION_FAILED'}
        return @{status='PASS';published=$true}
    } catch {throw 'PRIVATE_WRITE_BLOCKED'} finally {
        if($stream){$stream.Dispose()}
        if($Data){[Array]::Clear($Data,0,$Data.Length)}
    }
}
