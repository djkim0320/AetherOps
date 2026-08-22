[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$buildRoot = [IO.Path]::GetFullPath((Join-Path $root 'build')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot ('license-policy-test-' + [Guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith($buildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'License policy fixture escaped the build directory.'
}

$checker = Join-Path $PSScriptRoot 'notices-check.ps1'
$engine = Join-Path $PSHOME $(if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' })
if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) {
    throw "Could not locate the current PowerShell engine: $engine"
}
$utf8 = [Text.UTF8Encoding]::new($false)
$sourceNotice = Join-Path $root 'THIRD_PARTY_NOTICES.md'
$sourceManifest = Join-Path $root 'sbom\license-manifest.json'
$sourceLicenses = Join-Path $root 'sbom\licenses'
$runtimeRoot = Join-Path $root '.runtime'
$checkedPayloadRelative = 'sbom\licenses\common\Apache-2.0.txt'

function Write-Fixture([scriptblock]$Mutation = $null) {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot 'sbom') | Out-Null
    Copy-Item -LiteralPath $sourceNotice -Destination (Join-Path $fixtureRoot 'THIRD_PARTY_NOTICES.md')
    Copy-Item -LiteralPath $sourceLicenses -Destination (Join-Path $fixtureRoot 'sbom\licenses') -Recurse
    $manifest = Get-Content -Raw -LiteralPath $sourceManifest | ConvertFrom-Json
    if ($Mutation) { & $Mutation $manifest }
    [IO.File]::WriteAllText(
        (Join-Path $fixtureRoot 'sbom\license-manifest.json'),
        ($manifest | ConvertTo-Json -Depth 8),
        $utf8
    )
}

function Invoke-PolicyCheck {
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell surfaces a native child's redirected stderr as an
        # ErrorRecord. The exit code is the assertion under test here.
        $ErrorActionPreference = 'SilentlyContinue'
        $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $checker, '-Root', $fixtureRoot, '-PolicyOnly', '-SkipSBOMCheck')
        if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
            $arguments += @('-RuntimeRoot', $runtimeRoot)
        }
        & $engine @arguments > $null 2> $null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return $exitCode
}

function Assert-Rejected([string]$Name, [scriptblock]$Mutation = $null, [scriptblock]$AfterWrite = $null) {
    Write-Fixture $Mutation
    if ($AfterWrite) { & $AfterWrite }
    $exitCode = Invoke-PolicyCheck
    if ($exitCode -eq 0) { throw "License policy accepted invalid fixture: $Name" }
    Write-Verbose "Rejected invalid fixture: $Name"
}

try {
    Write-Fixture
    if ((Invoke-PolicyCheck) -ne 0) { throw 'License policy rejected the valid baseline fixture.' }

    Assert-Rejected 'missing license payload' $null {
        Remove-Item -LiteralPath (Join-Path $fixtureRoot $checkedPayloadRelative) -Force
    }
    Assert-Rejected 'tampered license payload' $null {
        Add-Content -LiteralPath (Join-Path $fixtureRoot $checkedPayloadRelative) -Value 'tampered'
    }
    Assert-Rejected 'unreviewed production license' {
        param($manifest)
        $manifest.production[0].license_expression = 'NOASSERTION'
    }
    Assert-Rejected 'missing third-party notice file' $null {
        Remove-Item -LiteralPath (Join-Path $fixtureRoot 'THIRD_PARTY_NOTICES.md') -Force
    }
    Assert-Rejected 'tampered third-party notice token' $null {
        $noticePath = Join-Path $fixtureRoot 'THIRD_PARTY_NOTICES.md'
        $notice = Get-Content -Raw -LiteralPath $noticePath
        [IO.File]::WriteAllText($noticePath, $notice.Replace('Node.js 24.19.0', 'Node.js 24.19.1'), $utf8)
    }
    Assert-Rejected 'empty source receipt' {
        param($manifest)
        $manifest.production[0].source_receipts[0].value = ''
    }
    Assert-Rejected 'development dependency marked distributed' {
        param($manifest)
        $manifest.development_sets[0].distributed = $true
    }
    Assert-Rejected 'forbidden first-party license' $null {
        [IO.File]::WriteAllText((Join-Path $fixtureRoot 'LICENSE'), "unexpected first-party license`n", $utf8)
    }

    Write-Host 'License policy negative tests passed: missing/tampered payloads and notices, unreviewed license/source, distribution boundary, and first-party LICENSE were rejected.'
} finally {
    if ($fixtureRoot.StartsWith($buildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
