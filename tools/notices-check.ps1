[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$RuntimeRoot = '',
    [switch]$PolicyOnly,
    [switch]$SkipSBOMCheck
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$runtimeExplicit = $PSBoundParameters.ContainsKey('RuntimeRoot')
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Join-Path $rootPath '.runtime'
}
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$runtimeAvailable = Test-Path -LiteralPath $runtimePath -PathType Container

$noticePath = Join-Path $rootPath 'THIRD_PARTY_NOTICES.md'
$manifestPath = Join-Path $rootPath 'sbom\license-manifest.json'
if (-not (Test-Path -LiteralPath $noticePath -PathType Leaf)) {
    throw 'THIRD_PARTY_NOTICES.md is missing.'
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'sbom/license-manifest.json is missing.'
}
if (Test-Path -LiteralPath (Join-Path $rootPath 'LICENSE') -PathType Leaf) {
    throw 'AetherOps must not ship a first-party LICENSE file.'
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$notice = Get-Content -Raw -LiteralPath $noticePath
if ($manifest.schema -ne 1 -or $manifest.product -ne 'AetherOps' -or -not $manifest.production) {
    throw 'License manifest schema/product/production inventory is invalid.'
}

function Assert-CanonicalSHA256([string]$Value, [string]$Label) {
    if ($Value -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Label must be a canonical lowercase SHA-256 value."
    }
}

function Assert-FileReceipt([string]$Path, [string]$SHA256, [long]$Bytes, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    Assert-CanonicalSHA256 $SHA256 "$Label hash"
    $item = Get-Item -LiteralPath $Path
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($item.Length -ne $Bytes -or $actual -cne $SHA256) {
        throw "$Label receipt mismatch: $Path"
    }
}

function Resolve-LicensePayload([string]$RelativePath) {
    $normalized = $RelativePath.Replace('\', '/')
    if ($normalized.StartsWith('sbom/licenses/', [StringComparison]::Ordinal)) {
        $candidate = [IO.Path]::GetFullPath((Join-Path $rootPath $normalized.Replace('/', '\')))
        $prefix = [IO.Path]::GetFullPath((Join-Path $rootPath 'sbom\licenses')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Checked-in license payload escaped sbom/licenses: $RelativePath"
        }
        return [pscustomobject]@{ Path = $candidate; Required = $true }
    }
    if ($normalized.StartsWith('runtime/', [StringComparison]::Ordinal)) {
        $suffix = $normalized.Substring('runtime/'.Length).Replace('/', '\')
        $candidate = [IO.Path]::GetFullPath((Join-Path $runtimePath $suffix))
        $prefix = $runtimePath + [IO.Path]::DirectorySeparatorChar
        if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Runtime license payload escaped the runtime root: $RelativePath"
        }
        return [pscustomobject]@{ Path = $candidate; Required = ($runtimeExplicit -or $runtimeAvailable) }
    }
    throw "License payload must be under sbom/licenses or runtime: $RelativePath"
}

function Assert-SourceReceipt($Receipt, [string]$ComponentID) {
    $validURI = [uri]::IsWellFormedUriString([string]$Receipt.url, [UriKind]::Absolute)
    if ([string]::IsNullOrWhiteSpace([string]$Receipt.algorithm) -or
        [string]::IsNullOrWhiteSpace([string]$Receipt.value) -or
        [string]::IsNullOrWhiteSpace([string]$Receipt.url) -or
        -not $validURI) {
        throw "Production component $ComponentID has an incomplete source receipt."
    }
    switch ([string]$Receipt.algorithm) {
        'SHA-256' { Assert-CanonicalSHA256 ([string]$Receipt.value) "$ComponentID source receipt" }
        'npm-sri' {
            if ([string]$Receipt.value -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') {
                throw "Production component $ComponentID has an invalid npm SRI."
            }
        }
        'gomod-h1' {
            if ([string]$Receipt.value -notmatch '^h1:[A-Za-z0-9+/]+={0,2}$') {
                throw "Production component $ComponentID has an invalid Go module sum."
            }
        }
        default { throw "Production component $ComponentID uses unsupported source receipt algorithm $($Receipt.algorithm)." }
    }
    if ($Receipt.packaged_path) {
        $resolved = Resolve-LicensePayload ([string]$Receipt.packaged_path)
        if ($resolved.Required) {
            Assert-FileReceipt $resolved.Path ([string]$Receipt.value) ([long](Get-Item -LiteralPath $resolved.Path).Length) "$ComponentID packaged source"
        }
    }
}

$ids = @{}
$purls = @{}
foreach ($component in @($manifest.production)) {
    $id = [string]$component.id
    $purl = [string]$component.purl
    $license = [string]$component.license_expression
    if ([string]::IsNullOrWhiteSpace($id) -or $ids.ContainsKey($id)) { throw "License manifest has an empty or duplicate production id: $id" }
    if ([string]::IsNullOrWhiteSpace($purl) -or $purls.ContainsKey($purl)) { throw "License manifest has an empty or duplicate production purl: $purl" }
    $ids[$id] = $true
    $purls[$purl] = $true
    if ($component.distributed -ne $true) { throw "Production component $id is not explicitly distributed=true." }
    if ([string]::IsNullOrWhiteSpace($license) -or $license -eq 'NOASSERTION' -or $license -eq 'NONE') {
        throw "Production component $id has an unreviewed license expression."
    }
    if (-not $component.source_receipts -or @($component.source_receipts).Count -eq 0) {
        throw "Production component $id has no source receipt."
    }
    foreach ($receipt in @($component.source_receipts)) { Assert-SourceReceipt $receipt $id }
    if (-not $component.license_payloads -or @($component.license_payloads).Count -eq 0) {
        throw "Production component $id has no license payload."
    }
    foreach ($payload in @($component.license_payloads)) {
        $relative = [string]$payload.path
        $resolved = Resolve-LicensePayload $relative
        Assert-CanonicalSHA256 ([string]$payload.sha256) "$id license payload"
        if ([long]$payload.bytes -le 0) { throw "Production component $id has an invalid license payload size." }
        if ($resolved.Required) {
            Assert-FileReceipt $resolved.Path ([string]$payload.sha256) ([long]$payload.bytes) "$id license payload"
        }
    }
    $token = [string]$component.notice_token
    if ([string]::IsNullOrWhiteSpace($token) -or -not $notice.Contains($token)) {
        throw "THIRD_PARTY_NOTICES.md is missing production notice token: $token"
    }
}

foreach ($set in @($manifest.development_sets)) {
    if ($set.distributed -ne $false) {
        throw "Development dependency set $($set.id) must be explicitly distributed=false."
    }
}
foreach ($external in @($manifest.external_runtime)) {
    if ($external.distributed -ne $false -or [string]::IsNullOrWhiteSpace([string]$external.license_expression)) {
        throw "External runtime $($external.id) must be non-distributed with a reviewed license expression."
    }
}

if (-not $PolicyOnly) {
    foreach ($input in @($manifest.inputs)) {
        $inputPath = [IO.Path]::GetFullPath((Join-Path $rootPath ([string]$input.path)))
        $rootPrefix = $rootPath + [IO.Path]::DirectorySeparatorChar
        if (-not $inputPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "License policy input escaped the repository: $($input.path)"
        }
        Assert-FileReceipt $inputPath ([string]$input.sha256) ([long](Get-Item -LiteralPath $inputPath).Length) "License policy input $($input.path)"
    }

    $frontendSet = @($manifest.development_sets | Where-Object id -eq 'frontend-build-dev-dependencies')
    if ($frontendSet.Count -ne 1) { throw 'Frontend development dependency classification is missing or duplicated.' }
    $reader = Join-Path $rootPath 'tools\license-inventory.cjs'
    $frontendLock = Join-Path $rootPath 'frontend\package-lock.json'
    $inventoryJSON = & node $reader $frontendLock
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the frontend license inventory.' }
    $inventory = ($inventoryJSON | Out-String) | ConvertFrom-Json
    if (@($inventory.development).Count -ne [int]$frontendSet[0].package_count) {
        throw 'Frontend development dependency count changed without license review.'
    }
    $allowed = @{}
    foreach ($expression in @($frontendSet[0].allowed_license_expressions)) { $allowed[[string]$expression] = $true }
    foreach ($dependency in @($inventory.development)) {
        if ($dependency.distributed -ne $false -or -not $allowed.ContainsKey([string]$dependency.license)) {
            throw "Frontend development dependency $($dependency.name) is distributed or has an unreviewed license."
        }
    }
}

if (-not $PolicyOnly -and -not $SkipSBOMCheck) {
    $spdxPath = Join-Path $rootPath 'sbom\spdx.json'
    $cyclonePath = Join-Path $rootPath 'sbom\cyclonedx.json'
    if (-not (Test-Path -LiteralPath $spdxPath -PathType Leaf) -or -not (Test-Path -LiteralPath $cyclonePath -PathType Leaf)) {
        throw 'Checked-in SPDX and CycloneDX SBOMs are required.'
    }
    $spdx = Get-Content -Raw -LiteralPath $spdxPath | ConvertFrom-Json
    $cyclone = Get-Content -Raw -LiteralPath $cyclonePath | ConvertFrom-Json
    foreach ($component in @($manifest.production)) {
        $spdxPackage = @($spdx.packages | Where-Object { @($_.externalRefs | Where-Object referenceLocator -eq $component.purl).Count -ne 0 })
        if ($spdxPackage.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$spdxPackage[0].licenseDeclared) -or
            $spdxPackage[0].licenseDeclared -eq 'NOASSERTION' -or $spdxPackage[0].licenseConcluded -eq 'NOASSERTION') {
            throw "SPDX has no complete licensed production package for $($component.purl)."
        }
        $cycloneComponent = @($cyclone.components | Where-Object purl -eq $component.purl)
        if ($cycloneComponent.Count -ne 1 -or -not $cycloneComponent[0].licenses -or
            (@($cycloneComponent[0].licenses | Where-Object { $_.expression -eq 'NOASSERTION' -or [string]::IsNullOrWhiteSpace([string]$_.expression) }).Count -ne 0)) {
            throw "CycloneDX has no complete licensed production component for $($component.purl)."
        }
    }
}

if ($runtimeAvailable -or $runtimeExplicit) {
    Write-Host 'Third-party license manifest, runtime payloads, source receipts, notices, and no-first-party-license policy verified.'
} else {
    Write-Host 'Third-party license manifest, checked-in payloads, dependency classifications, notices, and no-first-party-license policy verified (runtime payloads are release-time checked).'
}
