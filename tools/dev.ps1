[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('bootstrap', 'test', 'build', 'run', 'package')]
    [string]$Command = 'test'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$goRoot = Join-Path $tools 'go1.26.5'
$go = Join-Path $goRoot 'bin\go.exe'
$env:GOTOOLCHAIN = 'local'
$env:GOMODCACHE = Join-Path $tools 'gomodcache'
$env:GOCACHE = Join-Path $tools 'gocache'

function Install-PinnedGo {
    if (Test-Path -LiteralPath $go) { return }
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    $releases = Invoke-RestMethod -Uri 'https://go.dev/dl/?mode=json&include=all'
    $release = $releases | Where-Object { $_.version -eq 'go1.26.5' } | Select-Object -First 1
    if (-not $release) { throw 'Go 1.26.5 is not present in the official Go release metadata.' }
    $archiveInfo = $release.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive' } | Select-Object -First 1
    if (-not $archiveInfo) { throw 'Official Go 1.26.5 windows-amd64 archive was not found.' }
    $archive = Join-Path $tools $archiveInfo.filename
    Invoke-WebRequest -Uri ("https://go.dev/dl/{0}" -f $archiveInfo.filename) -OutFile $archive
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    if ($actualHash -ne $archiveInfo.sha256.ToLowerInvariant()) {
        throw "Go archive hash mismatch: $actualHash"
    }
    $extract = Join-Path $tools ('go-extract-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    Move-Item -LiteralPath (Join-Path $extract 'go') -Destination $goRoot
    Remove-Item -LiteralPath $extract -Force
    Remove-Item -LiteralPath $archive -Force
}

function Invoke-FrontendBuild([switch]$RunTests) {
    Push-Location (Join-Path $root 'frontend')
    try {
        npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        npm audit --audit-level=high
        if ($LASTEXITCODE -ne 0) { throw 'npm audit failed' }
        if ($RunTests) {
            npm test
            if ($LASTEXITCODE -ne 0) { throw 'frontend tests failed' }
        }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
    } finally {
        Pop-Location
    }
}

function Invoke-GoChecks {
    & $go mod verify
    if ($LASTEXITCODE -ne 0) { throw 'go mod verify failed' }
    & $go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    if ($env:AETHEROPS_RACE -eq '1') {
        & $go test -race ./...
        if ($LASTEXITCODE -ne 0) { throw 'Go race tests failed' }
    }
    & $go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
}

function Invoke-KnowledgeSidecarChecks {
    $sidecar = Join-Path $root 'tools\knowledge-sidecar'
    Push-Location $sidecar
    try {
        npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'knowledge sidecar npm ci failed' }
        npm audit --audit-level=high
        if ($LASTEXITCODE -ne 0) { throw 'knowledge sidecar npm audit failed' }
        npm test
        if ($LASTEXITCODE -ne 0) { throw 'knowledge sidecar tests failed' }
    } finally {
        Pop-Location
    }
}

function Copy-KnowledgeSidecar([string]$DestinationRoot) {
    $sourceRoot = Join-Path $root 'tools\knowledge-sidecar'
    $destination = Join-Path $DestinationRoot 'knowledge-sidecar'
    $destinationParent = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $resolvedDestination = [IO.Path]::GetFullPath($destination)
    if (-not $resolvedDestination.StartsWith($destinationParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Knowledge sidecar destination escaped its build root: $resolvedDestination"
    }
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    foreach ($name in @('index.cjs', 'protocol.cjs', 'worker.cjs')) {
        $source = Join-Path $sourceRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required knowledge sidecar source is missing: $source"
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name)
    }
}

function Get-AetherOpsLinkerFlags([switch]$RequireRuntimeUpdateTrust) {
    $feedURL = [string]$env:AETHEROPS_RUNTIME_FEED_URL
    $keyID = [string]$env:AETHEROPS_RUNTIME_KEY_ID
    $publicKey = [string]$env:AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64
    $configured = @($feedURL, $keyID, $publicKey) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    if ($configured.Count -eq 0) {
        if ($RequireRuntimeUpdateTrust) {
            throw 'Release packaging requires AETHEROPS_RUNTIME_FEED_URL, AETHEROPS_RUNTIME_KEY_ID, and AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64.'
        }
        return '-s -w -H=windowsgui'
    }
    if ($configured.Count -ne 3) {
        throw 'Runtime update signing configuration must provide feed URL, key id, and Ed25519 public key together.'
    }
    $uri = $null
    if (-not [Uri]::TryCreate($feedURL, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Fragment) {
        throw 'AETHEROPS_RUNTIME_FEED_URL must be an HTTPS URL without credentials or fragment.'
    }
    if ($keyID -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
        throw 'AETHEROPS_RUNTIME_KEY_ID is invalid.'
    }
    try { $decodedKey = [Convert]::FromBase64String($publicKey) } catch { throw 'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64 is not valid base64.' }
    if ($decodedKey.Length -ne 32) {
        throw 'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64 must contain exactly one Ed25519 public key.'
    }
    return "-s -w -H=windowsgui -X=main.runtimeUpdateFeedURL=$feedURL -X=main.runtimeUpdateKeyID=$keyID -X=main.runtimeUpdatePublicKeyBase64=$publicKey -X=main.buildMode=release"
}

function Invoke-Build([switch]$RequireRuntimeUpdateTrust) {
    & (Join-Path $PSScriptRoot 'runtime-bundle.ps1') -GoExecutable $go
    Invoke-FrontendBuild
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'build') | Out-Null
    $linkerFlags = Get-AetherOpsLinkerFlags -RequireRuntimeUpdateTrust:$RequireRuntimeUpdateTrust
    & $go build -trimpath -ldflags $linkerFlags -o (Join-Path $root 'build\aetherops.exe') ./cmd/aetherops
    if ($LASTEXITCODE -ne 0) { throw 'AetherOps build failed' }
    Copy-KnowledgeSidecar (Join-Path $root 'build')
    Copy-Item -LiteralPath (Join-Path $root 'runtime-manifest.json') -Destination (Join-Path $root 'build\runtime-manifest.json') -Force
    $buildRuntime = Join-Path $root 'build\runtime'
    $buildRoot = [IO.Path]::GetFullPath((Join-Path $root 'build')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $resolvedBuildRuntime = [IO.Path]::GetFullPath($buildRuntime)
    if (-not $resolvedBuildRuntime.StartsWith($buildRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build runtime path escaped the build directory: $resolvedBuildRuntime"
    }
    if (Test-Path -LiteralPath $buildRuntime) {
        Remove-Item -LiteralPath $buildRuntime -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $buildRuntime | Out-Null
    Copy-Item -LiteralPath (Join-Path $root '.runtime\active.json') -Destination $buildRuntime
    Copy-Item -LiteralPath (Join-Path $root '.runtime\verification-receipt.json') -Destination $buildRuntime
    Copy-Item -LiteralPath (Join-Path $root '.runtime\versions') -Destination $buildRuntime -Recurse
}

Install-PinnedGo
switch ($Command) {
    'bootstrap' {
        Write-Host "Pinned Go is ready at $goRoot"
    }
    'test' {
        & (Join-Path $PSScriptRoot 'dependency-check.ps1')
        & (Join-Path $PSScriptRoot 'package-trust-test.ps1')
        & (Join-Path $PSScriptRoot 'package-content-test.ps1')
        & (Join-Path $PSScriptRoot 'notices-check.ps1')
        Invoke-FrontendBuild -RunTests
        & (Join-Path $PSScriptRoot 'sbom.ps1') -VerifyOnly
        Invoke-KnowledgeSidecarChecks
        Invoke-GoChecks
    }
    'build' {
        & (Join-Path $PSScriptRoot 'dependency-check.ps1')
        Invoke-Build
    }
	'run' {
		& (Join-Path $PSScriptRoot 'dependency-check.ps1')
		Invoke-Build
		$dataRoot = Join-Path $root '.aetherops-release-eval-data'
		New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
		$descriptor = Join-Path (Join-Path $root 'build') ('dev-session-' + [Guid]::NewGuid().ToString('N') + '.json')
		& (Join-Path $root 'build\aetherops.exe') release-eval-session --descriptor $descriptor --data-root $dataRoot
    }
    'package' {
        $null = Get-AetherOpsLinkerFlags -RequireRuntimeUpdateTrust
        & (Join-Path $PSScriptRoot 'dependency-check.ps1')
        Invoke-Build -RequireRuntimeUpdateTrust
        & (Join-Path $PSScriptRoot 'package.ps1')
    }
}
