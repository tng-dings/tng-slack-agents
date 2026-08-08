[CmdletBinding()]
param(
    [string]$DataDirectory = "$env:ProgramData\OpenCodeWorker",
    [int]$Port = 4096
)

$ErrorActionPreference = "Stop"
$protected = [IO.File]::ReadAllBytes((Join-Path $DataDirectory "worker-secrets.bin"))
$entropy = [Text.Encoding]::UTF8.GetBytes("agent-runner-secrets-v2")
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::LocalMachine
)
try {
    $secrets = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
    foreach ($property in $secrets.PSObject.Properties) {
        if ($property.Name -like "SLACK_*" -or $property.Name -like "DISCORD_*") {
            throw "Refusing to inject an integration credential into the OpenCode worker"
        }
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
    }
    $securityConfig = @{
        autoupdate = $false
        plugin = @()
        permission = @{
            "*" = "ask"
            read = "allow"
            edit = "allow"
            glob = "allow"
            grep = "allow"
            list = "allow"
            lsp = "allow"
            bash = "allow"
            external_directory = "deny"
            webfetch = "deny"
            websearch = "deny"
            task = "deny"
            skill = "deny"
            question = "deny"
        }
    } | ConvertTo-Json -Compress -Depth 5
    [Environment]::SetEnvironmentVariable("OPENCODE_CONFIG_CONTENT", $securityConfig, "Process")
    [Environment]::SetEnvironmentVariable("OPENCODE_DISABLE_CLAUDE_CODE", "1", "Process")
    $pathFile = Join-Path $DataDirectory "opencode-path.txt"
    $opencode = if ($env:AGENT_RUNNER_OPENCODE_PATH) {
        $env:AGENT_RUNNER_OPENCODE_PATH
    } elseif (Test-Path $pathFile) {
        [IO.File]::ReadAllText($pathFile).Trim()
    } else {
        "opencode"
    }
    & $opencode serve --hostname 127.0.0.1 --port $Port
    exit $LASTEXITCODE
}
finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    [Environment]::SetEnvironmentVariable("OPENCODE_CONFIG_CONTENT", $null, "Process")
    [Environment]::SetEnvironmentVariable("OPENCODE_DISABLE_CLAUDE_CODE", $null, "Process")
    if ($secrets) {
        foreach ($property in $secrets.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable($property.Name, $null, "Process")
        }
    }
}
