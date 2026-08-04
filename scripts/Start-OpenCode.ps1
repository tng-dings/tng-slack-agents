[CmdletBinding()]
param(
    [string]$DataDirectory = "$env:ProgramData\AgentRunner",
    [int]$Port = 4096
)

$ErrorActionPreference = "Stop"
$protected = [IO.File]::ReadAllBytes((Join-Path $DataDirectory "secrets.bin"))
$entropy = [Text.Encoding]::UTF8.GetBytes("agent-runner-secrets-v1")
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
    if ($secrets) {
        foreach ($property in $secrets.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable($property.Name, $null, "Process")
        }
    }
}
