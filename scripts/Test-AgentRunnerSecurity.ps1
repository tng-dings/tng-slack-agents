[CmdletBinding()]
param(
    [string]$GatewayDataDirectory = "$env:ProgramData\AgentRunner",
    [string]$WorkerDataDirectory = "$env:ProgramData\OpenCodeWorker",
    [string]$ConfigPath = "$env:ProgramData\AgentRunner\config.json"
)

$ErrorActionPreference = "Stop"
$failures = [Collections.Generic.List[string]]::new()

function Assert-Control([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Host "PASS $Message" }
    else { Write-Host "FAIL $Message"; $failures.Add($Message) }
}

function Read-SecretNames([string]$Path) {
    $protected = [IO.File]::ReadAllBytes($Path)
    $entropy = [Text.Encoding]::UTF8.GetBytes("agent-runner-secrets-v2")
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    try {
        $value = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
        return @($value.PSObject.Properties.Name)
    }
    finally {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
}

function Test-IsWithin([string]$Candidate, [string]$Root) {
    $fullCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $fullCandidate.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-ConfiguredPath([string]$Candidate, [string]$ConfigurationPath) {
    $expanded = [Environment]::ExpandEnvironmentVariables($Candidate)
    if ([IO.Path]::IsPathRooted($expanded)) { return [IO.Path]::GetFullPath($expanded) }
    return [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ConfigurationPath) $expanded))
}

$gatewayService = Get-CimInstance Win32_Service -Filter "Name='AgentRunner'" -ErrorAction SilentlyContinue
$workerService = Get-CimInstance Win32_Service -Filter "Name='OpenCodeServer'" -ErrorAction SilentlyContinue
Assert-Control ($gatewayService -and $gatewayService.StartName -eq "NT SERVICE\AgentRunner") "AgentRunner uses its dedicated virtual identity"
Assert-Control ($workerService -and $workerService.StartName -eq "NT SERVICE\OpenCodeServer") "OpenCodeServer uses its dedicated virtual identity"

$gatewayAclNames = @((Get-Acl $GatewayDataDirectory).Access.IdentityReference.Value)
$workerAclNames = @((Get-Acl $WorkerDataDirectory).Access.IdentityReference.Value)
$worktreeAclNames = @((Get-Acl (Join-Path $WorkerDataDirectory "worktrees")).Access.IdentityReference.Value)
Assert-Control ($gatewayAclNames -notcontains "NT SERVICE\OpenCodeServer") "worker identity cannot access the gateway data directory"
Assert-Control ($workerAclNames -notcontains "NT SERVICE\AgentRunner") "gateway identity cannot access the worker control directory"
Assert-Control ($worktreeAclNames -contains "NT SERVICE\AgentRunner" -and $worktreeAclNames -contains "NT SERVICE\OpenCodeServer") "only the shared worktree area is available to both services"

$gatewaySecretPath = Join-Path $GatewayDataDirectory "gateway-secrets.bin"
$workerSecretPath = Join-Path $WorkerDataDirectory "worker-secrets.bin"
Assert-Control (Test-Path $gatewaySecretPath) "gateway secret bundle exists"
Assert-Control (Test-Path $workerSecretPath) "worker secret bundle exists"

if (Test-Path $gatewaySecretPath) {
    $names = Read-SecretNames $gatewaySecretPath
    Assert-Control (
        $names -contains "SLACK_BOT_TOKEN" -and
        ($names -contains "SLACK_APP_TOKEN" -or $names -contains "SLACK_SIGNING_SECRET")
    ) "gateway bundle contains credentials for a Slack ingress"
    $aclNames = @((Get-Acl $gatewaySecretPath).Access.IdentityReference.Value)
    Assert-Control ($aclNames -notcontains "NT SERVICE\OpenCodeServer") "worker identity cannot read gateway secret bundle"
}
if (Test-Path $workerSecretPath) {
    $names = Read-SecretNames $workerSecretPath
    Assert-Control (-not ($names | Where-Object { $_ -like "SLACK_*" })) "worker bundle contains no Slack credential"
    Assert-Control ($names -contains "OPENCODE_SERVER_PASSWORD") "worker bundle contains its server password"
    $aclNames = @((Get-Acl $workerSecretPath).Access.IdentityReference.Value)
    Assert-Control ($aclNames -notcontains "NT SERVICE\AgentRunner") "gateway identity cannot read worker secret bundle"
}

if (Test-Path $ConfigPath) {
    $config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
    $slackIngress = if ($config.slack.ingress) { [string]$config.slack.ingress } else { "socket" }
    if (Test-Path $gatewaySecretPath) {
        $gatewayNames = Read-SecretNames $gatewaySecretPath
        if ($slackIngress -eq "events-api") {
            Assert-Control ($gatewayNames -contains "SLACK_SIGNING_SECRET") "Events API gateway bundle contains the Slack signing secret"
        }
        else {
            Assert-Control ($gatewayNames -contains "SLACK_APP_TOKEN") "Socket Mode gateway bundle contains the Slack app token"
        }
    }
    $resolvedConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    $baseUrl = [Uri]$config.openCode.baseUrl
    Assert-Control ($baseUrl.Scheme -eq "http" -and $baseUrl.Host -in @("127.0.0.1", "::1")) "OpenCode endpoint is a loopback literal"
    Assert-Control (@($config.slack.allowedWorkspaceIds).Count -gt 0) "Slack workspace allowlist is configured"
    Assert-Control (@($config.slack.allowedUserIds).Count -gt 0) "Slack user allowlist is configured"
    Assert-Control ($config.slack.liveUpdates -ne $true) "live Slack output is disabled"
    Assert-Control ($config.slack.nativeStreaming -ne $true) "native Slack streaming is disabled"
    Assert-Control ([int]$config.limits.maxConcurrentJobsPerUser -le 1) "per-user concurrency is at most one"
    Assert-Control ([int]$config.limits.maxConcurrentJobsGlobal -le 1) "global concurrency is at most one"
    Assert-Control ([int]$config.limits.maxQueuedJobsPerUser -le 3) "per-user queue is at most three"
    Assert-Control ([int]$config.limits.jobTimeoutSeconds -le 1800) "job timeout is at most 30 minutes"
    Assert-Control ([double]$config.limits.dailyCostCap -le 5) "daily reported-cost cap is at most five"
    Assert-Control ([int]$config.limits.maxPromptCharacters -le 12000) "prompt limit is at most 12,000 characters"
    Assert-Control ([int]$config.limits.maxOutputCharacters -le 100000) "output limit is at most 100,000 characters"
    Assert-Control ([int]$config.limits.maxAuditEventCharacters -le 32000) "audit-event limit is at most 32,000 characters"
    Assert-Control ([int]$config.limits.maxToolEventsPerJob -le 500) "tool-event limit is at most 500"
    Assert-Control ($config.storage.retainJobContent -ne $true) "completed job content retention is disabled"
    Assert-Control ([int]$config.storage.retentionDays -le 30) "retention is at most 30 days"
    Assert-Control (Test-IsWithin (Resolve-ConfiguredPath $config.storage.databasePath $resolvedConfigPath) $GatewayDataDirectory) "SQLite storage is inside the gateway data directory"
    Assert-Control (Test-IsWithin (Resolve-ConfiguredPath $config.storage.auditLogPath $resolvedConfigPath) $GatewayDataDirectory) "JSONL audit storage is inside the gateway data directory"
    Assert-Control (Test-IsWithin (Resolve-ConfiguredPath $config.storage.worktreeRoot $resolvedConfigPath) $WorkerDataDirectory) "worktree storage is inside the worker data directory"
}
else {
    Assert-Control $false "configuration file exists"
}

if ($failures.Count) {
    Write-Error "$($failures.Count) security control(s) failed."
}
Write-Host "All deploy-time security controls passed."
