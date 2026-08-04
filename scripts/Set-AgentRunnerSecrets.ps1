[CmdletBinding()]
param(
    [string]$DataDirectory = "$env:ProgramData\AgentRunner",
    [string]$ServiceIdentity = "NT AUTHORITY\LOCAL SERVICE",
    [string[]]$AdditionalSecretNames = @()
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

$secrets = @{
    SLACK_BOT_TOKEN = Read-PlainSecret "Slack bot token (xoxb-...)"
    SLACK_APP_TOKEN = Read-PlainSecret "Slack app token (xapp-...)"
    OPENCODE_SERVER_PASSWORD = Read-PlainSecret "OpenCode server password"
}
foreach ($secretName in $AdditionalSecretNames) {
    if ($secretName -notmatch '^[A-Z][A-Z0-9_]+$') {
        throw "Invalid environment variable name: $secretName"
    }
    $secrets[$secretName] = Read-PlainSecret "$secretName"
}

New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
$plainBytes = [Text.Encoding]::UTF8.GetBytes(($secrets | ConvertTo-Json -Compress))
$entropy = [Text.Encoding]::UTF8.GetBytes("agent-runner-secrets-v1")
try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [IO.File]::WriteAllBytes((Join-Path $DataDirectory "secrets.bin"), $protected)
}
finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    $secrets.Clear()
}

$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators", $ServiceIdentity)) {
    $rights = if ($identity -eq $ServiceIdentity) { "Modify" } else { "FullControl" }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $identity,
        $rights,
        "ContainerInherit,ObjectInherit",
        "None",
        "Allow"
    )
    $acl.AddAccessRule($rule)
}
Set-Acl -Path $DataDirectory -AclObject $acl
$secretAcl = New-Object Security.AccessControl.FileSecurity
$secretAcl.SetAccessRuleProtection($true, $false)
foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators", $ServiceIdentity)) {
    $rights = if ($identity -eq $ServiceIdentity) { "Read" } else { "FullControl" }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, "Allow")
    $secretAcl.AddAccessRule($rule)
}
Set-Acl -Path (Join-Path $DataDirectory "secrets.bin") -AclObject $secretAcl
Write-Host "Encrypted secrets written to $DataDirectory\secrets.bin"
