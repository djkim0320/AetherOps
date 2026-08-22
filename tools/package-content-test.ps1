$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-content.ps1')

function Write-TestText([string]$Path, [string]$Value) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function New-TestStaging([string]$Path, [string]$ExecutableText) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    Write-TestText (Join-Path $Path 'aetherops.exe') $ExecutableText
    Write-TestText (Join-Path $Path 'runtime-manifest.json') "runtime manifest`n"
    Write-TestText (Join-Path $Path 'knowledge-sidecar\index.cjs') "index fixture`n"
    Write-TestText (Join-Path $Path 'knowledge-sidecar\protocol.cjs') "protocol fixture`n"
    Write-TestText (Join-Path $Path 'knowledge-sidecar\worker.cjs') "worker fixture`n"
    Write-TestText (Join-Path $Path 'THIRD_PARTY_NOTICES.md') "fixture notice`n"
    Write-TestText (Join-Path $Path 'sbom\cyclonedx.json') "{}`n"
    Write-TestText (Join-Path $Path 'sbom\spdx.json') "{}`n"
    Write-TestText (Join-Path $Path 'runtime\active.json') "{}`n"
    Write-TestText (Join-Path $Path 'runtime\verification-receipt.json') "{}`n"
    Write-TestText (Join-Path $Path 'runtime\source-acquisition.json') "{}`n"
    Write-AetherOpsPortableContentManifest -StagingRoot $Path
}

function Assert-Rejected([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw $Message }
}

$root = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $root 'build')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$buildPrefix = $build + [IO.Path]::DirectorySeparatorChar
$testRoot = [IO.Path]::GetFullPath((Join-Path $build ('package-content-test-' + [Guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package content test root escaped build.'
}

try {
    $current = Join-Path $testRoot 'current'
    New-TestStaging -Path $current -ExecutableText "current executable`n"
    $snapshot = Get-AetherOpsPortableSnapshot -StagingRoot $current
    if ($snapshot.KnowledgeSidecarTreeSHA256 -cne '955dd24b963f8db133fe9deb778d8cb5b6f3618ae808c433323e1cb0565ba962') {
        throw "PowerShell knowledge-sidecar tree identity differs from the Go canonical test vector: $($snapshot.KnowledgeSidecarTreeSHA256)"
    }
    $null = Assert-AetherOpsPortableSnapshot -StagingRoot $current -Expected $snapshot

    $currentZip = Join-Path $testRoot 'current.zip'
    Compress-Archive -Path (Join-Path $current '*') -DestinationPath $currentZip
    Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $currentZip -Expected $snapshot

    $old = Join-Path $testRoot 'old'
    New-TestStaging -Path $old -ExecutableText "obsolete executable`n"
    $oldZip = Join-Path $testRoot 'obsolete-dist.zip'
    Compress-Archive -Path (Join-Path $old '*') -DestinationPath $oldZip
    Assert-Rejected {
        Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $oldZip -Expected $snapshot
    } 'An obsolete portable archive was accepted as the current candidate.'

    foreach ($mutation in @(
        @{ Name = 'executable'; Relative = 'aetherops.exe' },
        @{ Name = 'runtime manifest'; Relative = 'runtime-manifest.json' },
        @{ Name = 'knowledge sidecar'; Relative = 'knowledge-sidecar\worker.cjs' }
    )) {
        $mutated = Join-Path $testRoot ('mutated-' + $mutation.Name.Replace(' ', '-'))
        New-TestStaging -Path $mutated -ExecutableText "current executable`n"
        $mutatedSnapshot = Get-AetherOpsPortableSnapshot -StagingRoot $mutated
        [IO.File]::AppendAllText(
            (Join-Path $mutated $mutation.Relative),
            'tamper',
            [Text.UTF8Encoding]::new($false)
        )
        Assert-Rejected {
            $null = Assert-AetherOpsPortableSnapshot -StagingRoot $mutated -Expected $mutatedSnapshot
        } "A $($mutation.Name) staging mutation after manifest creation was accepted."
    }

    $installer = Join-Path $root 'packaging\AetherOps.iss'
    Assert-AetherOpsInstallerUsesPortableStaging -InstallerScriptPath $installer
    $unsafeInstaller = Join-Path $testRoot 'unsafe.iss'
    Write-TestText $unsafeInstaller @"
[Files]
Source: "..\build\aetherops.exe"; DestDir: "{app}"; Flags: ignoreversion
"@
    Assert-Rejected {
        Assert-AetherOpsInstallerUsesPortableStaging -InstallerScriptPath $unsafeInstaller
    } 'An installer reading mutable build inputs was accepted.'
    $extraInstaller = Join-Path $testRoot 'extra.iss'
    Write-TestText $extraInstaller @"
[Files]
Source: "..\build\portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\runtime-manifest.json"; DestDir: "{app}"; Flags: ignoreversion
"@
    Assert-Rejected {
        Assert-AetherOpsInstallerUsesPortableStaging -InstallerScriptPath $extraInstaller
    } 'An installer mixing portable staging and mutable repository inputs was accepted.'
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [IO.Path]::GetFullPath($testRoot)
        if (-not $resolved.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove package content test path outside build: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

Write-Host 'Package staging identity, mutation, obsolete archive, and installer-source policy tests passed.'
