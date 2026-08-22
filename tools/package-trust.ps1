function Get-AetherOpsSHA256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-AetherOpsRuntimeTrustExpectation {
    $feedURL = [string][Environment]::GetEnvironmentVariable('AETHEROPS_RUNTIME_FEED_URL', 'Process')
    $keyID = [string][Environment]::GetEnvironmentVariable('AETHEROPS_RUNTIME_KEY_ID', 'Process')
    $publicKey = [string][Environment]::GetEnvironmentVariable('AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64', 'Process')
    foreach ($entry in @(
        @{ Name = 'AETHEROPS_RUNTIME_FEED_URL'; Value = $feedURL },
        @{ Name = 'AETHEROPS_RUNTIME_KEY_ID'; Value = $keyID },
        @{ Name = 'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64'; Value = $publicKey }
    )) {
        if ([string]::IsNullOrWhiteSpace($entry.Value)) {
            throw "Release packaging requires $($entry.Name) so stable runtime updates cannot ship disabled."
        }
        if ($entry.Value -ne $entry.Value.Trim()) {
            throw "$($entry.Name) must not contain leading or trailing whitespace."
        }
    }
    $uri = $null
    if (-not [Uri]::TryCreate($feedURL, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment) {
        throw 'AETHEROPS_RUNTIME_FEED_URL must be an HTTPS URL without credentials or fragment.'
    }
    if ($keyID -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
        throw 'AETHEROPS_RUNTIME_KEY_ID is invalid.'
    }
    try {
        [byte[]]$decodedKey = [Convert]::FromBase64String($publicKey)
    } catch {
        throw 'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64 is not valid base64.'
    }
    if ($decodedKey.Length -ne 32) {
        throw 'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64 must contain exactly one Ed25519 public key.'
    }
    return [pscustomobject]@{
        schema = 'aetherops_runtime_update_trust_v2'
        configured = $true
        key_id = $keyID
        feed_url_sha256 = Get-AetherOpsSHA256Hex ([Text.Encoding]::UTF8.GetBytes($feedURL))
        public_key_sha256 = Get-AetherOpsSHA256Hex $decodedKey
        build_mode = 'release'
    }
}

function ConvertFrom-AetherOpsRuntimeTrustDiagnostic {
    param([Parameter(Mandatory = $true)][string]$JSON)
    try {
        $diagnostic = $JSON | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "AetherOps runtime trust diagnostic is not valid JSON: $($_.Exception.Message)"
    }
    if ($null -eq $diagnostic -or $diagnostic -is [Array]) {
        throw 'AetherOps runtime trust diagnostic must be one JSON object.'
    }
    $properties = @($diagnostic.psobject.Properties.Name | Sort-Object)
    $expectedProperties = @('build_mode', 'configured', 'feed_url_sha256', 'key_id', 'public_key_sha256', 'schema')
    if (Compare-Object $expectedProperties $properties) {
        throw 'AetherOps runtime trust diagnostic has a missing or unreviewed field.'
    }
    if ($diagnostic.schema -cne 'aetherops_runtime_update_trust_v2' -or
        $diagnostic.configured -isnot [bool] -or -not $diagnostic.configured) {
        throw 'AetherOps executable does not report configured embedded runtime update trust.'
    }
    if ($diagnostic.build_mode -cne 'release') {
        throw 'AetherOps executable is not a release-mode build.'
    }
    if (([string]$diagnostic.key_id) -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
        throw 'AetherOps runtime trust diagnostic key id is invalid.'
    }
    foreach ($name in @('feed_url_sha256', 'public_key_sha256')) {
        $value = [string]$diagnostic.$name
        if ($value -cnotmatch '^[0-9a-f]{64}$') {
            throw "AetherOps runtime trust diagnostic $name is invalid."
        }
    }
    return $diagnostic
}

function Assert-AetherOpsRuntimeTrustMatch {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )
    foreach ($name in @('schema', 'configured', 'key_id', 'feed_url_sha256', 'public_key_sha256', 'build_mode')) {
        if ($Expected.$name -cne $Actual.$name) {
            throw "AetherOps executable embedded runtime trust does not match packaging input: $name"
        }
    }
}

function Read-AetherOpsEmbeddedRuntimeTrust {
    param([Parameter(Mandatory = $true)][string]$Executable)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "AetherOps executable is missing: $Executable"
    }
    $stdout = [IO.Path]::GetTempFileName()
    $stderr = [IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $Executable -ArgumentList 'runtime-trust-diagnostic' `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
            -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            $detail = (Get-Content -Raw -LiteralPath $stderr -ErrorAction SilentlyContinue).Trim()
            throw "AetherOps runtime trust diagnostic exited $($process.ExitCode): $detail"
        }
        $json = Get-Content -Raw -LiteralPath $stdout
        return ConvertFrom-AetherOpsRuntimeTrustDiagnostic $json
    } finally {
        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    }
}
