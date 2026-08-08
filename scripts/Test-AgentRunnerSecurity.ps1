[CmdletBinding()]
param(
    [string]$GatewayDataDirectory = "$env:ProgramData\AgentRunner",
    [string]$WorkerDataDirectory = "$env:ProgramData\OpenCodeWorker",
    [string]$ConfigPath = "$env:ProgramData\AgentRunner\config.json",
    [string]$EdgeConfigPath = "",
    [string]$NginxPath = "nginx"
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
    Assert-Control ($names -contains "OPENCODE_SERVER_PASSWORD") "gateway bundle contains its OpenCode client credential"
    $aclNames = @((Get-Acl $gatewaySecretPath).Access.IdentityReference.Value)
    Assert-Control ($aclNames -notcontains "NT SERVICE\OpenCodeServer") "worker identity cannot read gateway secret bundle"
}
if (Test-Path $workerSecretPath) {
    $names = Read-SecretNames $workerSecretPath
    Assert-Control (-not ($names | Where-Object { $_ -like "SLACK_*" })) "worker bundle contains no Slack credential"
    Assert-Control (-not ($names | Where-Object { $_ -like "DISCORD_*" })) "worker bundle contains no Discord credential"
    Assert-Control ($names -contains "OPENCODE_SERVER_PASSWORD") "worker bundle contains its server password"
    $aclNames = @((Get-Acl $workerSecretPath).Access.IdentityReference.Value)
    Assert-Control ($aclNames -notcontains "NT SERVICE\AgentRunner") "gateway identity cannot read worker secret bundle"
}

if (Test-Path $ConfigPath) {
    $config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
    $slackEnabled = $config.slack.enabled -ne $false
    $discordEnabled = $config.discord.enabled -eq $true
    $slackIngress = if ($config.slack.ingress) { [string]$config.slack.ingress } else { "socket" }
    $discordIngress = if ([string]::IsNullOrWhiteSpace([string]$config.discord.ingress)) { "gateway" } else { [string]$config.discord.ingress }
    if (Test-Path $gatewaySecretPath) {
        $gatewayNames = Read-SecretNames $gatewaySecretPath
        if ($slackEnabled -and $slackIngress -eq "events-api") {
            Assert-Control ($gatewayNames -contains "SLACK_SIGNING_SECRET") "Events API gateway bundle contains the Slack signing secret"
            Assert-Control ($gatewayNames -notcontains "SLACK_APP_TOKEN") "Events API gateway bundle excludes the Slack app token"
        }
        elseif ($slackEnabled) {
            Assert-Control ($gatewayNames -contains "SLACK_APP_TOKEN") "Socket Mode gateway bundle contains the Slack app token"
        }
        if ($discordEnabled) {
            Assert-Control ($gatewayNames -contains "DISCORD_BOT_TOKEN") "gateway bundle contains the Discord bot token"
            if ($discordIngress -eq "http") {
                Assert-Control ($gatewayNames -contains "DISCORD_PUBLIC_KEY") "HTTP gateway bundle contains the Discord application public key"
            }
            else {
                Assert-Control ($gatewayNames -notcontains "DISCORD_PUBLIC_KEY") "Gateway-mode bundle excludes the unused Discord application public key"
            }
        }
    }
    $resolvedConfigPath = [IO.Path]::GetFullPath($ConfigPath)
    $baseUrl = [Uri]$config.openCode.baseUrl
    Assert-Control ($baseUrl.Scheme -eq "http" -and $baseUrl.Host -in @("127.0.0.1", "::1")) "OpenCode endpoint is a loopback literal"
    if ($slackEnabled) {
        Assert-Control (@($config.slack.allowedWorkspaceIds).Count -gt 0) "Slack workspace allowlist is configured"
        Assert-Control (@($config.slack.allowedUserIds).Count -gt 0) "Slack user allowlist is configured"
    }
    if ($discordEnabled) {
        Assert-Control (@($config.discord.allowedGuildIds).Count -gt 0) "Discord guild allowlist is configured"
        Assert-Control (@($config.discord.allowedUserIds).Count -gt 0) "Discord user allowlist is configured"
    }
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

    if ($slackEnabled -and $slackIngress -eq "events-api") {
        $http = $config.slack.http
        Assert-Control ($http.host -eq "127.0.0.1") "Events API listener uses the reviewed loopback IPv4 address"
        Assert-Control ([int]$http.maxBodyBytes -gt 0 -and [int]$http.maxBodyBytes -le 262144) "private request-body limit is at most 256 KiB"
        Assert-Control ([int]$http.maxHeaderBytes -gt 0 -and [int]$http.maxHeaderBytes -le 16384) "private request-header limit is at most 16 KiB"
        Assert-Control ([int]$http.requestTimeoutMs -gt 0 -and [int]$http.requestTimeoutMs -le 5000) "private request timeout is at most five seconds"
        Assert-Control ([int]$http.headersTimeoutMs -gt 0 -and [int]$http.headersTimeoutMs -le 5000) "private header timeout is at most five seconds"
        Assert-Control ([int]$http.headersTimeoutMs -le [int]$http.requestTimeoutMs) "private header timeout does not exceed the request timeout"
        Assert-Control ([int]$http.maxConnections -gt 0 -and [int]$http.maxConnections -le 100) "private listener accepts at most 100 connections"

        $listeners = @(Get-NetTCPConnection -LocalPort ([int]$http.port) -State Listen -ErrorAction SilentlyContinue)
        Assert-Control (@($listeners | Where-Object { $_.LocalAddress -eq "127.0.0.1" }).Count -gt 0) "Events API private listener is running on the configured IPv4 loopback"
        Assert-Control (
            $listeners.Count -gt 0 -and
            @($listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }).Count -eq 0
        ) "Events API port has no non-loopback listener"

        $hasEdgeConfigPath = -not [string]::IsNullOrWhiteSpace($EdgeConfigPath)
        Assert-Control $hasEdgeConfigPath "installed NGINX configuration path is supplied explicitly"
        $edgeConfigExists = $false
        if ($hasEdgeConfigPath) {
            $resolvedEdgeConfigPath = [IO.Path]::GetFullPath($EdgeConfigPath)
            $edgeConfigExists = Test-Path -LiteralPath $resolvedEdgeConfigPath -PathType Leaf
        }
        Assert-Control $edgeConfigExists "installed NGINX configuration exists"

        $nginxCommand = Get-Command $NginxPath -ErrorAction SilentlyContinue
        Assert-Control ($null -ne $nginxCommand) "NGINX executable is available for effective-configuration validation"
        if ($edgeConfigExists -and $nginxCommand) {
            $edgeOutput = @(& $nginxCommand.Source -T -c $resolvedEdgeConfigPath 2>&1)
            $nginxConfigIsValid = $LASTEXITCODE -eq 0
            Assert-Control $nginxConfigIsValid "installed NGINX configuration passes nginx -T"
            $edge = $edgeOutput -join [Environment]::NewLine
            $eventsPathPattern = [regex]::Escape([string]$http.eventsPath)
            $healthPathPattern = [regex]::Escape([string]$http.healthPath)
            Assert-Control ($edge -match '(?m)^\s*listen\s+443\s+ssl;') "edge terminates public TLS"
            Assert-Control ($edge -match "(?m)^\s*location\s+=\s+$eventsPathPattern\s+\{") "edge exposes the configured exact Slack event route"
            Assert-Control ($edge -match "(?m)^\s*location\s+=\s+$healthPathPattern\s+\{") "edge exposes the configured exact health route"
            Assert-Control ($edge -match '(?m)^\s*client_max_body_size\s+256k;') "edge limits request bodies before Bolt"
            Assert-Control ($edge -match '(?m)^\s*proxy_request_buffering\s+on;') "edge buffers requests before Bolt"
            Assert-Control ($edge -match '(?m)^\s*limit_req\s+zone=global_requests') "edge applies global rate limiting"
            Assert-Control ($edge -match '(?m)^\s*access_log\s+off;') "edge request logging is disabled against log floods"
            $expectedUpstream = "(?m)^\s*server\s+127\.0\.0\.1:$([int]$http.port);"
            Assert-Control ($edge -match $expectedUpstream) "edge upstream is the configured loopback Bolt listener"
        }

        $timeService = Get-Service W32Time -ErrorAction SilentlyContinue
        Assert-Control ($timeService -and $timeService.Status -eq "Running") "Windows Time is running for Slack replay protection"
    }
    if ($discordEnabled) {
        Assert-Control ($discordIngress -in @("gateway", "http")) "Discord ingress is gateway or http"
        $discordHttp = $config.discord.http
        if ($discordIngress -eq "gateway") {
            $discordListeners = @(Get-NetTCPConnection -LocalPort ([int]$discordHttp.port) -State Listen -ErrorAction SilentlyContinue)
            Assert-Control ($discordListeners.Count -eq 0) "Discord Gateway mode opens no HTTP listener"
        }
        else {
            Assert-Control ($discordHttp.host -eq "127.0.0.1") "Discord listener uses the reviewed loopback IPv4 address"
            Assert-Control ([int]$discordHttp.maxBodyBytes -gt 0 -and [int]$discordHttp.maxBodyBytes -le 262144) "Discord request-body limit is at most 256 KiB"
            Assert-Control ([int]$discordHttp.maxHeaderBytes -gt 0 -and [int]$discordHttp.maxHeaderBytes -le 16384) "Discord request-header limit is at most 16 KiB"
            Assert-Control ([int]$discordHttp.requestTimeoutMs -gt 0 -and [int]$discordHttp.requestTimeoutMs -le 2500) "Discord request timeout is at most 2.5 seconds"
            Assert-Control ([int]$discordHttp.headersTimeoutMs -le [int]$discordHttp.requestTimeoutMs) "Discord header timeout does not exceed its request timeout"
            Assert-Control ([int]$discordHttp.maxConnections -gt 0 -and [int]$discordHttp.maxConnections -le 100) "Discord listener accepts at most 100 connections"
            $discordListeners = @(Get-NetTCPConnection -LocalPort ([int]$discordHttp.port) -State Listen -ErrorAction SilentlyContinue)
            Assert-Control (@($discordListeners | Where-Object { $_.LocalAddress -eq "127.0.0.1" }).Count -gt 0) "Discord private listener is running on IPv4 loopback"
            Assert-Control (
                $discordListeners.Count -gt 0 -and
                @($discordListeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") }).Count -eq 0
            ) "Discord port has no non-loopback listener"
            $discordEdgeConfigExists = $false
            if (-not [string]::IsNullOrWhiteSpace($EdgeConfigPath)) {
                $resolvedDiscordEdgeConfigPath = [IO.Path]::GetFullPath($EdgeConfigPath)
                $discordEdgeConfigExists = Test-Path -LiteralPath $resolvedDiscordEdgeConfigPath -PathType Leaf
            }
            Assert-Control $discordEdgeConfigExists "installed NGINX configuration exists for Discord"
            $discordNginxCommand = Get-Command $NginxPath -ErrorAction SilentlyContinue
            Assert-Control ($null -ne $discordNginxCommand) "NGINX executable is available for Discord edge validation"
            if ($discordEdgeConfigExists -and $discordNginxCommand) {
                $discordEdgeOutput = @(& $discordNginxCommand.Source -T -c $resolvedDiscordEdgeConfigPath 2>&1)
                Assert-Control ($LASTEXITCODE -eq 0) "installed NGINX configuration passes Discord edge validation"
                $discordEdge = $discordEdgeOutput -join [Environment]::NewLine
                $interactionsPathPattern = [regex]::Escape([string]$discordHttp.interactionsPath)
                Assert-Control ($discordEdge -match "(?m)^\s*location\s+=\s+$interactionsPathPattern\s+\{") "edge exposes the configured exact Discord interaction route"
                $expectedDiscordUpstream = "(?m)^\s*server\s+127\.0\.0\.1:$([int]$discordHttp.port);"
                Assert-Control ($discordEdge -match $expectedDiscordUpstream) "edge upstream is the configured loopback Discord listener"
            }
            $timeService = Get-Service W32Time -ErrorAction SilentlyContinue
            Assert-Control ($timeService -and $timeService.Status -eq "Running") "Windows Time is running for Discord replay protection"
        }
    }
}
else {
    Assert-Control $false "configuration file exists"
}

if ($failures.Count) {
    Write-Error "$($failures.Count) security control(s) failed."
}
Write-Host "All deploy-time security controls passed."
