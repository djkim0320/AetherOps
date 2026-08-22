[CmdletBinding()]
param(
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$dist = Join-Path $root 'dist'
$portable = Join-Path $build 'portable'
$runtime = Join-Path $root '.runtime'
$runtimeManifest = Join-Path $root 'runtime-manifest.json'
$executable = Join-Path $build 'aetherops.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'build\aetherops.exe does not exist.' }
. (Join-Path $PSScriptRoot 'package-trust.ps1')
. (Join-Path $PSScriptRoot 'package-content.ps1')
$expectedRuntimeTrust = Get-AetherOpsRuntimeTrustExpectation
$embeddedRuntimeTrust = Read-AetherOpsEmbeddedRuntimeTrust -Executable $executable
Assert-AetherOpsRuntimeTrustMatch -Expected $expectedRuntimeTrust -Actual $embeddedRuntimeTrust
Write-Host "Embedded runtime update trust verified: key_id=$($embeddedRuntimeTrust.key_id), feed_sha256=$($embeddedRuntimeTrust.feed_url_sha256)"
$installerScript = Join-Path $root 'packaging\AetherOps.iss'
if (-not (Test-Path -LiteralPath $installerScript -PathType Leaf)) {
    throw 'packaging\AetherOps.iss does not exist.'
}
$installerText = Get-Content -Raw -LiteralPath $installerScript
Assert-AetherOpsInstallerUsesPortableStaging -InstallerScriptPath $installerScript
$installerScriptSHA256 = Get-AetherOpsRegularFileSHA256 -Path $installerScript
$uninstallDeleteMatch = [regex]::Match(
    $installerText,
    '(?ms)^\[UninstallDelete\]\s*(?<body>.*?)(?=^\[|\z)'
)
if (-not $uninstallDeleteMatch.Success) {
    throw 'The installer has no [UninstallDelete] policy.'
}
$uninstallDeleteTargets = [regex]::Matches(
    $uninstallDeleteMatch.Groups['body'].Value,
    '(?im)^\s*Type:\s*filesandordirs\s*;\s*Name:\s*"(?<name>[^"]+)"'
) | ForEach-Object { $_.Groups['name'].Value }
$requiredUninstallDeleteTargets = @(
    '{app}\runtime',
    '{localappdata}\AetherOps\v2\runtimes',
    '{localappdata}\AetherOps\v2\webview2',
    '{localappdata}\AetherOps\v2'
)
foreach ($target in $requiredUninstallDeleteTargets) {
    if ($uninstallDeleteTargets -cnotcontains $target) {
        throw "The installer is missing the required uninstall target: $target"
    }
}
$allowedGuardedUninstallTargets = @{
    '{localappdata}\AetherOps\v2\runtimes' = 'IsManagedRuntimeUninstallTargetSafe'
    '{localappdata}\AetherOps\v2\webview2' = 'ShouldDeleteBrowserProfiles'
    '{localappdata}\AetherOps\v2' = 'ShouldDeleteAllUserData'
}
foreach ($target in $uninstallDeleteTargets) {
    if (-not $target.StartsWith('{localappdata}', [StringComparison]::OrdinalIgnoreCase)) {
        continue
    }
    if (-not $allowedGuardedUninstallTargets.ContainsKey($target)) {
        throw "The installer declares an unreviewed persistent-data deletion target: $target"
    }
    $guard = $allowedGuardedUninstallTargets[$target]
    $escapedTarget = [regex]::Escape($target)
    $escapedGuard = [regex]::Escape($guard)
    if ($installerText -notmatch "(?m)^Type:\s*filesandordirs;\s*Name:\s*`"$escapedTarget`";\s*Check:\s*$escapedGuard\s*$") {
        throw "The uninstall target $target must remain guarded by $guard."
    }
}
foreach ($requiredCodeToken in @(
    'HasExactUninstallSwitch(''/DELETEUSERDATA'')',
    'HasExactUninstallSwitch(''/DELETEBROWSERPROFILES'')',
    'for Index := 1 to ParamCount do',
    'CompareText(ParamStr(Index), SwitchName) = 0',
    'if UninstallSilent',
    'MB_YESNO or MB_DEFBUTTON2',
    'IsProductDataUninstallTargetSafe',
    'IsBrowserProfileUninstallTargetSafe'
)) {
    if (-not $installerText.Contains($requiredCodeToken)) {
        throw "The installer is missing reviewed opt-in uninstall policy token: $requiredCodeToken"
    }
}
if ($installerText -match '(?i)\bDelTree\s*\(') {
    throw 'Direct scripted tree deletion is not permitted by the reviewed uninstall data policy.'
}
$sidecar = Join-Path $build 'knowledge-sidecar'
$sidecarFiles = @('index.cjs', 'protocol.cjs', 'worker.cjs')
foreach ($name in $sidecarFiles) {
    $packagedSidecarFile = Join-Path $sidecar $name
    $sourceSidecarFile = Join-Path (Join-Path $root 'tools\knowledge-sidecar') $name
    if (-not (Test-Path -LiteralPath $packagedSidecarFile -PathType Leaf)) {
        throw "Bundled knowledge sidecar file is missing: build\knowledge-sidecar\$name"
    }
    if (-not (Test-Path -LiteralPath $sourceSidecarFile -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $packagedSidecarFile).Hash -ne
        (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceSidecarFile).Hash) {
        throw "Bundled knowledge sidecar file does not match its reviewed source: $name"
    }
}
$candidateIdentity = Get-AetherOpsProductIdentity `
    -Executable $executable `
    -RuntimeManifest $runtimeManifest `
    -KnowledgeSidecarDirectory $sidecar
$requiredRuntimePaths = @(
    'active.json',
    'verification-receipt.json',
    'source-acquisition.json',
    'versions',
    'licenses',
    'sources'
)
foreach ($relative in $requiredRuntimePaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $relative))) {
        throw "Managed runtime evidence is missing: .runtime\$relative"
    }
}

function Assert-PackageRedistributionEvidence {
    $runtimeAbsolute = [IO.Path]::GetFullPath($runtime)
    $prefix = $runtimeAbsolute.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $manifestPath = Join-Path $runtimeAbsolute 'source-acquisition.json'
    $receiptPath = Join-Path $runtimeAbsolute 'verification-receipt.json'
    $evidence = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
    if ($evidence.schema -ne 1 -or @($evidence.acquisitions).Count -ne 35) {
        throw 'Runtime source-acquisition.json is not the reviewed 35-record set.'
    }
    $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
    if ($receipt.redistribution.acquisitionManifestSHA256 -ne $manifestHash -or
        $receipt.redistribution.verifiedPackagedFiles -ne 31) {
        throw 'Runtime redistribution receipt does not authenticate source-acquisition.json.'
    }
    $packaged = @($evidence.acquisitions | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.packagedPath) })
    if ($packaged.Count -ne 31) { throw 'Runtime acquisition manifest must map exactly 31 packaged source/license files.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $packaged) {
        $relative = ([string]$record.packagedPath).Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)' -or
            $relative -match '[:\x00-\x1f]' -or -not $seen.Add($relative)) {
            throw "Runtime acquisition manifest contains an unsafe or duplicate path: $($record.packagedPath)"
        }
        $path = [IO.Path]::GetFullPath((Join-Path $runtimeAbsolute $relative))
        if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Runtime redistribution evidence is missing: $($record.packagedPath)"
        }
        $file = Get-Item -LiteralPath $path
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
        if ($file.Length -ne [long]$record.bytes -or $hash -ne [string]$record.sha256) {
            throw "Runtime redistribution evidence failed its receipt: $($record.packagedPath)"
        }
    }
}
Assert-PackageRedistributionEvidence
$go = Join-Path $root '.tools\go1.26.5\bin\go.exe'
if (-not (Test-Path -LiteralPath $go -PathType Leaf)) {
    throw 'Pinned Go 1.26.5 is required to verify the eight-component runtime set before packaging.'
}
Push-Location $root
try {
    & $go run ./cmd/runtimebundle -mode verify -root $runtime -manifest $runtimeManifest
    if ($LASTEXITCODE -ne 0) { throw 'Managed runtime verification failed before packaging.' }
} finally {
    Pop-Location
}
$null = & (Join-Path $PSScriptRoot 'sbom.ps1') -VerifyOnly
if ($LASTEXITCODE -ne 0) { throw 'Reproducible SBOM verification failed before packaging.' }
$cyclone = Get-Content -Raw -LiteralPath (Join-Path $root 'sbom\cyclonedx.json') | ConvertFrom-Json
$spdx = Get-Content -Raw -LiteralPath (Join-Path $root 'sbom\spdx.json') | ConvertFrom-Json
$requiredSBOMNames = @('cytoscape', 'oxigraph', 'OpenVSP', 'Gmsh', 'XFOIL', 'SU2')
foreach ($name in $requiredSBOMNames) {
    if (-not ($cyclone.components | Where-Object name -eq $name | Select-Object -First 1)) {
        throw "CycloneDX SBOM is missing $name."
    }
    if (-not ($spdx.packages | Where-Object name -eq $name | Select-Object -First 1)) {
        throw "SPDX SBOM is missing $name."
    }
}
& (Join-Path $PSScriptRoot 'notices-check.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Third-party notice policy failed before packaging.' }
if ($VerifyOnly) {
    Write-Host 'Package inputs verified: executable, knowledge sidecar, eight-component runtime, 31 license/source receipts, notices, and both SBOMs.'
    return
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$packageHashManifest = Join-Path $dist 'SHA256SUMS.txt'
if (Test-Path -LiteralPath $packageHashManifest -PathType Leaf) {
    Remove-Item -LiteralPath $packageHashManifest -Force
}
$buildRoot = [IO.Path]::GetFullPath($build).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$portableTarget = [IO.Path]::GetFullPath($portable)
if (-not $portableTarget.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable staging path escaped the build directory: $portableTarget"
}
if (Test-Path -LiteralPath $portableTarget) { Remove-Item -LiteralPath $portableTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $portable | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $portable 'aetherops.exe')
Copy-Item -LiteralPath $sidecar -Destination (Join-Path $portable 'knowledge-sidecar') -Recurse
$portableRuntime = Join-Path $portable 'runtime'
Push-Location $root
try {
    & $go run ./cmd/runtimebundle -mode package-layout -root $runtime -out $portableRuntime -manifest $runtimeManifest
    if ($LASTEXITCODE -ne 0) { throw 'Compact packaged runtime materialization failed.' }
} finally {
    Pop-Location
}
Copy-Item -LiteralPath (Join-Path $runtime 'verification-receipt.json') -Destination $portableRuntime
Copy-Item -LiteralPath (Join-Path $runtime 'source-acquisition.json') -Destination $portableRuntime
Copy-Item -LiteralPath (Join-Path $runtime 'licenses') -Destination $portableRuntime -Recurse
Copy-Item -LiteralPath (Join-Path $runtime 'sources') -Destination $portableRuntime -Recurse
Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination $portable
Copy-Item -LiteralPath (Join-Path $root 'runtime-manifest.json') -Destination $portable
Copy-Item -LiteralPath (Join-Path $root 'sbom') -Destination (Join-Path $portable 'sbom') -Recurse

Write-AetherOpsPortableContentManifest -StagingRoot $portable
$portableSnapshot = Get-AetherOpsPortableSnapshot -StagingRoot $portable
Assert-AetherOpsProductIdentityEqual -Expected $candidateIdentity -Actual $portableSnapshot -Context 'verified portable staging'

$maximumPortableRelativePath = 160
$portablePathLengths = Get-ChildItem -LiteralPath $portable -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($portableTarget.Length + 1).Replace('/', '\')
    [pscustomobject]@{ Relative = $relative; Length = $relative.Length }
}
$longestPortablePath = $portablePathLengths | Sort-Object Length -Descending | Select-Object -First 1
if (-not $longestPortablePath -or $longestPortablePath.Length -gt $maximumPortableRelativePath) {
    $observed = if ($longestPortablePath) { "$($longestPortablePath.Length): $($longestPortablePath.Relative)" } else { 'no staged entries' }
    throw "Portable package path-length policy failed (maximum $maximumPortableRelativePath characters; observed $observed)."
}
Write-Host "Portable path-length policy passed: longest relative path is $($longestPortablePath.Length) characters."

$version = '0.1.0-alpha.1'
$zip = Join-Path $dist "AetherOps-$version-windows-x64-portable.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $portable '*') -DestinationPath $zip -CompressionLevel Optimal
Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $zip -Expected $portableSnapshot
& (Join-Path $PSScriptRoot 'package-smoke.ps1') -ZipPath $zip -StagingRoot $portable
if ($LASTEXITCODE -ne 0) { throw 'Portable archive readback and isolated launch smoke failed.' }
$null = Assert-AetherOpsPortableSnapshot -StagingRoot $portable -Expected $portableSnapshot -Context 'portable staging after ZIP smoke'
Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $zip -Expected $portableSnapshot

function Write-PackageHashManifest([string[]]$ArtifactPaths) {
    if ($ArtifactPaths.Count -ne 2) {
        throw 'Package hash manifest requires exactly portable and installer artifacts.'
    }
    $artifacts = @($ArtifactPaths | ForEach-Object {
        if (-not (Test-Path -LiteralPath $_ -PathType Leaf)) {
            throw "Package artifact is missing: $_"
        }
        Get-Item -LiteralPath $_
    } | Sort-Object Name)
    if (@($artifacts.Name | Select-Object -Unique).Count -ne 2) {
        throw 'Package hash manifest received duplicate artifact names.'
    }
    $lines = $artifacts | ForEach-Object {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    }
    [IO.File]::WriteAllLines($packageHashManifest, $lines, [Text.UTF8Encoding]::new($false))
}

$localISCC = Join-Path $root '.tools\innosetup-7.0.2-x64\ISCC.exe'
if (Test-Path -LiteralPath $localISCC -PathType Leaf) {
    $isccPath = $localISCC
} else {
    $iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if (-not $iscc) { throw 'Verified Inno Setup 7 ISCC.exe is required to build the installer.' }
    $isccPath = $iscc.Source
}
$isccSignature = Get-AuthenticodeSignature -LiteralPath $isccPath
$isccPublisher = if ($isccSignature.SignerCertificate) {
    $isccSignature.SignerCertificate.GetNameInfo(
        [Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
} else { '' }
if ($isccSignature.Status -ne 'Valid' -or $isccPublisher -ne 'Pyrsys B.V.') {
    throw "ISCC.exe Authenticode verification failed: $($isccSignature.Status), $isccPublisher"
}
$null = Assert-AetherOpsPortableSnapshot -StagingRoot $portable -Expected $portableSnapshot -Context 'portable staging before ISCC'
Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $zip -Expected $portableSnapshot
$setup = Join-Path $dist "AetherOps-$version-windows-x64-setup.exe"
if (Test-Path -LiteralPath $setup -PathType Leaf) { Remove-Item -LiteralPath $setup -Force }
& $isccPath (Join-Path $root 'packaging\AetherOps.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup build failed.' }
$null = Assert-AetherOpsPortableSnapshot -StagingRoot $portable -Expected $portableSnapshot -Context 'portable staging after ISCC'
Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $zip -Expected $portableSnapshot
if ((Get-AetherOpsRegularFileSHA256 -Path $installerScript) -cne $installerScriptSHA256) {
    throw 'Inno Setup script changed during package construction.'
}
Write-PackageHashManifest -ArtifactPaths @($zip, $setup)
Write-Host "Packages and SHA-256 manifest are in $dist"
