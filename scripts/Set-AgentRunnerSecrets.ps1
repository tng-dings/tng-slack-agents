[CmdletBinding()]
param(
    [string]$GatewayDataDirectory = "$env:ProgramData\AgentRunner",
    [string]$WorkerDataDirectory = "$env:ProgramData\OpenCodeWorker",
    [string]$GatewayServiceIdentity = "NT SERVICE\AgentRunner",
    [string]$WorkerServiceIdentity = "NT SERVICE\OpenCodeServer",
    [ValidateSet("disabled", "socket", "events-api")]
    [string]$SlackIngress = "socket",
    [switch]$EnableDiscord,
    [ValidateSet("gateway", "http")]
    [string]$DiscordIngress = "gateway",
    [Alias("AdditionalSecretNames")]
    [string[]]$WorkerSecretNames = @(),
    [ValidateSet("opencode", "claude-code")]
    [string]$Executor = "opencode",
    [ValidateSet("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")]
    [string]$ClaudeCredentialName = "ANTHROPIC_API_KEY"
)

$ErrorActionPreference = "Stop"

function Read-PlainSecret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Assert-Identity([string]$Identity) {
    try {
        [void](New-Object Security.Principal.NTAccount($Identity)).Translate([Security.Principal.SecurityIdentifier])
    }
    catch {
        if ($Executor -eq "opencode") {
            throw "Windows identity '$Identity' does not exist. Install both WinSW services before provisioning secrets."
        }
        throw "Windows identity '$Identity' does not exist. Install the AgentRunner WinSW service before provisioning secrets."
    }
}

function Set-RestrictedDirectoryAcl(
    [string]$Path,
    [string[]]$ServiceIdentities,
    [string]$ServiceRights = "Modify"
) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"
        )))
    }
    foreach ($identity in $ServiceIdentities) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $identity, $ServiceRights, "ContainerInherit,ObjectInherit", "None", "Allow"
        )))
    }
    Set-Acl -Path $Path -AclObject $acl
}

function Write-ProtectedSecrets([string]$Path, [hashtable]$Secrets, [string]$ReadIdentity) {
    $plainBytes = [Text.Encoding]::UTF8.GetBytes(($Secrets | ConvertTo-Json -Compress))
    $entropy = [Text.Encoding]::UTF8.GetBytes("agent-runner-secrets-v2")
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $entropy,
            [Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        [IO.File]::WriteAllBytes($Path, $protected)
    }
    finally {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
        $Secrets.Clear()
    }

    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")))
    }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ReadIdentity, "Read", "Allow")))
    Set-Acl -Path $Path -AclObject $acl
}

Assert-Identity $GatewayServiceIdentity
if ($Executor -eq "opencode") {
    Assert-Identity $WorkerServiceIdentity
}

foreach ($secretName in $WorkerSecretNames) {
    if ($secretName -notmatch '^[A-Z][A-Z0-9_]+$') {
        throw "Invalid environment variable name: $secretName"
    }
    $reservedNames = @(
        "APPDATA", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA",
        "NODE_OPTIONS", "NODE_PATH", "PATH", "PATHEXT", "PROGRAMDATA", "PSMODULEPATH",
        "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"
    )
    if (
        $secretName -like 'SLACK_*' -or
        $secretName -like 'DISCORD_*' -or
        $secretName -like 'OPENCODE_*' -or
        $secretName -like 'AGENT_RUNNER_*' -or
        $secretName -like 'GIT_*' -or
        $secretName -in $reservedNames
    ) {
        throw "WorkerSecretNames must contain provider credentials only: $secretName"
    }
}
if ($Executor -eq "claude-code" -and $WorkerSecretNames.Count -gt 0) {
    throw "WorkerSecretNames is available only when Executor is opencode"
}

Set-RestrictedDirectoryAcl $GatewayDataDirectory @($GatewayServiceIdentity)
if ($Executor -eq "opencode") {
    Set-RestrictedDirectoryAcl $WorkerDataDirectory @($WorkerServiceIdentity) "ReadAndExecute"
    $worktreeDirectory = Join-Path $WorkerDataDirectory "worktrees"
    Set-RestrictedDirectoryAcl $worktreeDirectory @($GatewayServiceIdentity, $WorkerServiceIdentity)
}
else {
    Set-RestrictedDirectoryAcl (Join-Path $GatewayDataDirectory "claude") @($GatewayServiceIdentity)
    Set-RestrictedDirectoryAcl (Join-Path $GatewayDataDirectory "worktrees") @($GatewayServiceIdentity)
}

$openCodePassword = $null
$gatewaySecrets = @{}
if ($Executor -eq "opencode") {
    $openCodePassword = Read-PlainSecret "OpenCode server password"
    $gatewaySecrets.OPENCODE_SERVER_PASSWORD = $openCodePassword
}
else {
    $gatewaySecrets[$ClaudeCredentialName] = Read-PlainSecret $ClaudeCredentialName
}
if ($SlackIngress -ne "disabled") {
    $gatewaySecrets.SLACK_BOT_TOKEN = Read-PlainSecret "Slack bot token (xoxb-...)"
    if ($SlackIngress -eq "socket") {
        $gatewaySecrets.SLACK_APP_TOKEN = Read-PlainSecret "Slack app token (xapp-...)"
    }
    else {
        $gatewaySecrets.SLACK_SIGNING_SECRET = Read-PlainSecret "Slack signing secret"
    }
}
if ($EnableDiscord) {
    $gatewaySecrets.DISCORD_BOT_TOKEN = Read-PlainSecret "Discord bot token"
    if ($DiscordIngress -eq "http") {
        $gatewaySecrets.DISCORD_PUBLIC_KEY = Read-PlainSecret "Discord application public key"
    }
}
$workerSecrets = $null
if ($Executor -eq "opencode") {
    $workerSecrets = @{
        OPENCODE_SERVER_PASSWORD = $openCodePassword
    }
    foreach ($secretName in $WorkerSecretNames) {
        $workerSecrets[$secretName] = Read-PlainSecret $secretName
    }
}

try {
    Write-ProtectedSecrets (Join-Path $GatewayDataDirectory "gateway-secrets.bin") $gatewaySecrets $GatewayServiceIdentity
    if ($Executor -eq "opencode") {
        Write-ProtectedSecrets (Join-Path $WorkerDataDirectory "worker-secrets.bin") $workerSecrets $WorkerServiceIdentity
    }
}
finally {
    $openCodePassword = $null
}

Write-Host "Gateway secrets written for $GatewayServiceIdentity."
if ($Executor -eq "opencode") {
    Write-Host "Worker secrets written for $WorkerServiceIdentity; no Slack or Discord credential is present in the worker bundle."
}
else {
    Write-Host "Claude credential $ClaudeCredentialName written to the AgentRunner bundle; no OpenCode worker bundle was created."
}
