[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$dist = Join-Path $root 'dist'
$runtime = Join-Path $root '.runtime'
$runtimeManifest = Join-Path $root 'runtime-manifest.json'
$executable = Join-Path $build 'aetherops.exe'
$sidecar = Join-Path $build 'knowledge-sidecar'
$stagingParent = $build
$staging = Join-Path $stagingParent 'p'
$licenseManifest = Get-Content -Raw -LiteralPath (Join-Path $root 'sbom\license-manifest.json') | ConvertFrom-Json
$version = [string]$licenseManifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Reviewed package version is invalid: $version"
}
$zip = Join-Path $dist "AetherOps-$version-windows-x64-internal-preview.zip"
$zipHash = "$zip.sha256"

function Assert-AetherOpsPreviewPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $parentAbsolute = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidateAbsolute = [IO.Path]::GetFullPath($Candidate)
    if (-not $candidateAbsolute.StartsWith(
        $parentAbsolute + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Internal-preview path escaped its reviewed parent: $candidateAbsolute"
    }
    return $candidateAbsolute
}

$stagingAbsolute = Assert-AetherOpsPreviewPath -Parent $stagingParent -Candidate $staging
$zipAbsolute = Assert-AetherOpsPreviewPath -Parent $dist -Candidate $zip
$zipHashAbsolute = Assert-AetherOpsPreviewPath -Parent $dist -Candidate $zipHash
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'build\aetherops.exe does not exist. Run tools\dev.ps1 build first.'
}

. (Join-Path $PSScriptRoot 'package-content.ps1')

$diagnosticText = (& $executable runtime-trust-diagnostic | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Development build runtime-trust diagnostic failed.'
}
try {
    $diagnostic = $diagnosticText | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw "Development build runtime-trust diagnostic is invalid JSON: $($_.Exception.Message)"
}
$diagnosticProperties = @($diagnostic.psobject.Properties.Name | Sort-Object)
$expectedDiagnosticProperties = @('build_mode', 'configured', 'schema')
if (Compare-Object $expectedDiagnosticProperties $diagnosticProperties) {
    throw 'Development build runtime-trust diagnostic has a missing or unreviewed field.'
}
if ($diagnostic.schema -cne 'aetherops_runtime_update_trust_v2' -or
    $diagnostic.configured -isnot [bool] -or $diagnostic.configured -or
    $diagnostic.build_mode -cne 'development') {
    throw 'Internal preview requires an explicit development build with runtime update trust disabled.'
}
Write-Host 'Development build identity verified: embedded runtime updater trust is disabled.'

foreach ($name in @('index.cjs', 'protocol.cjs', 'worker.cjs')) {
    $packagedSidecarFile = Join-Path $sidecar $name
    $sourceSidecarFile = Join-Path (Join-Path $root 'tools\knowledge-sidecar') $name
    if (-not (Test-Path -LiteralPath $packagedSidecarFile -PathType Leaf) -or
        -not (Test-Path -LiteralPath $sourceSidecarFile -PathType Leaf) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $packagedSidecarFile).Hash -cne
        (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceSidecarFile).Hash) {
        throw "Bundled knowledge sidecar does not match its reviewed source: $name"
    }
}

$candidateIdentity = Get-AetherOpsProductIdentity `
    -Executable $executable `
    -RuntimeManifest $runtimeManifest `
    -KnowledgeSidecarDirectory $sidecar

$go = Join-Path $root '.tools\go1.26.5\bin\go.exe'
if (-not (Test-Path -LiteralPath $go -PathType Leaf)) {
    throw 'Pinned Go 1.26.5 is required to verify the runtime before packaging.'
}
Push-Location $root
try {
    & $go run ./cmd/runtimebundle -mode verify -root $runtime -manifest $runtimeManifest
    if ($LASTEXITCODE -ne 0) { throw 'Managed runtime verification failed before internal-preview packaging.' }
} finally {
    Pop-Location
}
& (Join-Path $PSScriptRoot 'sbom.ps1') -VerifyOnly
if ($LASTEXITCODE -ne 0) { throw 'Reproducible SBOM verification failed before internal-preview packaging.' }
& (Join-Path $PSScriptRoot 'notices-check.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Third-party notice policy failed before internal-preview packaging.' }

if (Test-Path -LiteralPath $stagingAbsolute) {
    if (-not $Force) { throw "Internal-preview staging already exists: $stagingAbsolute. Use -Force to replace it." }
    Remove-Item -LiteralPath $stagingAbsolute -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingAbsolute | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $stagingAbsolute 'aetherops.exe')
Copy-Item -LiteralPath $sidecar -Destination (Join-Path $stagingAbsolute 'knowledge-sidecar') -Recurse

$portableRuntime = Join-Path $stagingAbsolute 'runtime'
Push-Location $root
try {
    & $go run ./cmd/runtimebundle -mode package-layout -root $runtime -out $portableRuntime -manifest $runtimeManifest
    if ($LASTEXITCODE -ne 0) { throw 'Compact internal-preview runtime materialization failed.' }
} finally {
    Pop-Location
}
Copy-Item -LiteralPath (Join-Path $runtime 'verification-receipt.json') -Destination $portableRuntime
Copy-Item -LiteralPath (Join-Path $runtime 'source-acquisition.json') -Destination $portableRuntime
Copy-Item -LiteralPath (Join-Path $runtime 'licenses') -Destination $portableRuntime -Recurse
Copy-Item -LiteralPath (Join-Path $runtime 'sources') -Destination $portableRuntime -Recurse
Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination $stagingAbsolute
Copy-Item -LiteralPath $runtimeManifest -Destination $stagingAbsolute
Copy-Item -LiteralPath (Join-Path $root 'sbom') -Destination (Join-Path $stagingAbsolute 'sbom') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $stagingAbsolute
Copy-Item -LiteralPath (Join-Path $root 'SECURITY.md') -Destination $stagingAbsolute
[IO.File]::WriteAllLines(
    (Join-Path $stagingAbsolute 'INTERNAL-PREVIEW.txt'),
    @(
        'AetherOps internal preview for Windows 11 x64',
        '',
        'Run aetherops.exe from this extracted directory.',
        'This is a verified development build, not a production release.',
        'The stable runtime updater is intentionally disabled because no release public-key trust root is embedded.',
        'Do not redistribute this archive as an official AetherOps release.',
        'PACKAGE-CONTENTS.sha256 authenticates every packaged file.'
    ),
    [Text.UTF8Encoding]::new($false)
)

Write-AetherOpsPortableContentManifest -StagingRoot $stagingAbsolute
$snapshot = Get-AetherOpsPortableSnapshot -StagingRoot $stagingAbsolute
Assert-AetherOpsProductIdentityEqual -Expected $candidateIdentity -Actual $snapshot -Context 'internal-preview staging'

$maximumRelativePath = 160
$longest = Get-ChildItem -LiteralPath $stagingAbsolute -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($stagingAbsolute.Length + 1).Replace('/', '\')
    [pscustomobject]@{ Relative = $relative; Length = $relative.Length }
} | Sort-Object Length -Descending | Select-Object -First 1
if (-not $longest -or $longest.Length -gt $maximumRelativePath) {
    $observed = if ($longest) { "$($longest.Length): $($longest.Relative)" } else { 'no staged entries' }
    throw "Internal-preview path-length policy failed (maximum $maximumRelativePath; observed $observed)."
}
Write-Host "Internal-preview path-length policy passed: longest relative path is $($longest.Length) characters."

New-Item -ItemType Directory -Force -Path $dist | Out-Null
foreach ($artifact in @($zipAbsolute, $zipHashAbsolute)) {
    if (Test-Path -LiteralPath $artifact) {
        if (-not $Force) { throw "Internal-preview artifact already exists: $artifact. Use -Force to replace it." }
        Remove-Item -LiteralPath $artifact -Force
    }
}
Compress-Archive -Path (Join-Path $stagingAbsolute '*') -DestinationPath $zipAbsolute -CompressionLevel Optimal
Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $zipAbsolute -Expected $snapshot
& (Join-Path $PSScriptRoot 'package-smoke.ps1') `
    -ZipPath $zipAbsolute `
    -StagingRoot $stagingAbsolute `
    -ExpectedBuildMode development
if ($LASTEXITCODE -ne 0) { throw 'Internal-preview portable archive smoke failed.' }
$null = Assert-AetherOpsPortableSnapshot `
    -StagingRoot $stagingAbsolute `
    -Expected $snapshot `
    -Context 'internal-preview staging after ZIP smoke'
Assert-AetherOpsPortableArchiveMatchesSnapshot -ZipPath $zipAbsolute -Expected $snapshot

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipAbsolute).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(
    $zipHashAbsolute,
    "$hash  $([IO.Path]::GetFileName($zipAbsolute))`n",
    [Text.UTF8Encoding]::new($false)
)
Write-Host "Internal-preview ZIP and SHA-256 receipt are in $dist"
Remove-Item -LiteralPath $stagingAbsolute -Recurse -Force
