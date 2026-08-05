[CmdletBinding()]
param(
    [string]$DataDirectory = "$env:ProgramData\AgentRunner",
    [string]$ConfigPath = "$env:ProgramData\AgentRunner\config.json"
)

$ErrorActionPreference = "Stop"
$secretPath = Join-Path $DataDirectory "gateway-secrets.bin"
$protected = [IO.File]::ReadAllBytes($secretPath)
$entropy = [Text.Encoding]::UTF8.GetBytes("agent-runner-secrets-v2")
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::LocalMachine
)
try {
    $secrets = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
    foreach ($property in $secrets.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
    }
    $env:AGENT_RUNNER_CONFIG = $ConfigPath
    $nodePathFile = Join-Path $DataDirectory "node-path.txt"
    $node = if ($env:AGENT_RUNNER_NODE_PATH) {
        $env:AGENT_RUNNER_NODE_PATH
    } elseif (Test-Path $nodePathFile) {
        [IO.File]::ReadAllText($nodePathFile).Trim()
    } else {
        "node"
    }
    $root = Split-Path -Parent $PSScriptRoot
    & $node (Join-Path $root "dist\src\index.js")
    exit $LASTEXITCODE
}
finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    if ($secrets) {
        foreach ($property in $secrets.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable($property.Name, $null, "Process")
        }
    }
}
