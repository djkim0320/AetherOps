$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'package-trust.ps1'
. $helper

$digestA = 'a' * 64
$digestB = 'b' * 64
$valid = @"
{"schema":"aetherops_runtime_update_trust_v2","configured":true,"key_id":"release-key","feed_url_sha256":"$digestA","public_key_sha256":"$digestB","build_mode":"release"}
"@
$parsed = ConvertFrom-AetherOpsRuntimeTrustDiagnostic $valid
Assert-AetherOpsRuntimeTrustMatch $parsed $parsed

$invalid = @(
    '{"schema":"aetherops_runtime_update_trust_v2","configured":false,"build_mode":"release"}',
    "{`"schema`":`"aetherops_runtime_update_trust_v2`",`"configured`":true,`"key_id`":`"release-key`",`"feed_url_sha256`":`"$digestA`",`"public_key_sha256`":`"$digestB`",`"build_mode`":`"release`",`"feed_url`":`"https://secret.invalid`"}",
    "{`"schema`":`"aetherops_runtime_update_trust_v2`",`"configured`":true,`"key_id`":`"release-key`",`"feed_url_sha256`":`"$('A' * 64)`",`"public_key_sha256`":`"$digestB`",`"build_mode`":`"release`"}",
    "{`"schema`":`"aetherops_runtime_update_trust_v2`",`"configured`":true,`"key_id`":`"release-key`",`"feed_url_sha256`":`"$digestA`",`"public_key_sha256`":`"$digestB`",`"build_mode`":`"development`"}",
    '{not-json}'
)
foreach ($json in $invalid) {
    $rejected = $false
    try { $null = ConvertFrom-AetherOpsRuntimeTrustDiagnostic $json } catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid runtime trust diagnostic was accepted: $json" }
}

$actual = ConvertFrom-AetherOpsRuntimeTrustDiagnostic $valid
$mismatched = [pscustomobject]@{
    schema = $actual.schema; configured = $actual.configured; key_id = 'other-key'
    feed_url_sha256 = $actual.feed_url_sha256; public_key_sha256 = $actual.public_key_sha256
    build_mode = $actual.build_mode
}
$rejected = $false
try { Assert-AetherOpsRuntimeTrustMatch $actual $mismatched } catch { $rejected = $true }
if (-not $rejected) { throw 'Mismatched embedded runtime trust was accepted.' }

$names = @('AETHEROPS_RUNTIME_FEED_URL', 'AETHEROPS_RUNTIME_KEY_ID', 'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    [Environment]::SetEnvironmentVariable('AETHEROPS_RUNTIME_FEED_URL', 'https://updates.example.test/stable.json', 'Process')
    [Environment]::SetEnvironmentVariable('AETHEROPS_RUNTIME_KEY_ID', 'release-key', 'Process')
    [Environment]::SetEnvironmentVariable('AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64', [Convert]::ToBase64String([byte[]](1..32)), 'Process')
    $expected = Get-AetherOpsRuntimeTrustExpectation
    if (-not $expected.configured -or $expected.feed_url_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $expected.public_key_sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Runtime trust expectation did not produce canonical digests.'
    }
    [Environment]::SetEnvironmentVariable('AETHEROPS_RUNTIME_KEY_ID', ' release-key', 'Process')
    $rejected = $false
    try { $null = Get-AetherOpsRuntimeTrustExpectation } catch { $rejected = $true }
    if (-not $rejected) { throw 'Whitespace-altered packaging trust input was accepted.' }
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}

Write-Host 'Package runtime-trust parser and mismatch tests passed.'
