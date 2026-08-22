[CmdletBinding()]
param(
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'sbom\license-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

& (Join-Path $PSScriptRoot 'notices-check.ps1') -Root $root -SkipSBOMCheck
if ($LASTEXITCODE -ne 0) { throw 'License manifest and notice validation failed before SBOM generation.' }
& (Join-Path $PSScriptRoot 'license-policy-test.ps1')
Write-Verbose 'License policy validated.'

$go = Join-Path $root '.tools\go1.26.5\bin\go.exe'
if (-not (Test-Path -LiteralPath $go -PathType Leaf)) {
    $installedGo = Get-Command go -ErrorAction SilentlyContinue
    if (-not $installedGo) { throw 'Go 1.26.5 is required to generate the SBOM.' }
    $go = $installedGo.Source
}
$goVersion = & $go version
if ($LASTEXITCODE -ne 0 -or $goVersion -notmatch '\bgo1\.26\.5\b') {
    throw "SBOM generation requires Go 1.26.5; found: $goVersion"
}

$checkedOutput = Join-Path $root 'sbom'
$verificationOutput = $null
if ($VerifyOnly) {
    $buildRoot = [IO.Path]::GetFullPath((Join-Path $root 'build')).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $verificationOutput = [IO.Path]::GetFullPath((Join-Path $buildRoot ('sbom-verify-' + [Guid]::NewGuid().ToString('N'))))
    if (-not $verificationOutput.StartsWith($buildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'SBOM verification output escaped the build directory.'
    }
    $output = $verificationOutput
} else {
    $output = $checkedOutput
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

trap {
    if ($verificationOutput -and (Test-Path -LiteralPath $verificationOutput)) {
        Remove-Item -LiteralPath $verificationOutput -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw $_
}

function ConvertTo-NpmPurl([string]$Name, [string]$Version) {
    return 'pkg:npm/{0}@{1}' -f $Name.Replace('@', '%40'), $Version
}

function Get-ManifestComponent([string]$Purl) {
    $matches = @($manifest.production | Where-Object purl -eq $Purl)
    if ($matches.Count -ne 1) { throw "Expected exactly one reviewed production manifest entry for $Purl." }
    return $matches[0]
}

# Actual production Go closure, not the wider module graph used by tests/tools.
$goDependencyLines = @(& $go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}{{end}}{{end}}' ./cmd/aetherops | Where-Object { $_ } | Sort-Object -Unique)
if ($LASTEXITCODE -ne 0) { throw 'go list -deps failed while resolving the production Go closure.' }
$goModuleLines = @(& $go list -m -f '{{if not .Main}}{{.Path}}|{{.Version}}|{{.Indirect}}|{{.Sum}}{{end}}' all | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw 'go list -m failed while resolving Go source receipts.' }
$goModules = @{}
foreach ($line in $goModuleLines) {
    $fields = $line -split '\|', 4
    $goModules[$fields[0] + '|' + $fields[1]] = [pscustomobject]@{ Indirect = ($fields[2] -eq 'true'); Sum = $fields[3] }
}
$manifestGo = @($manifest.production | Where-Object ecosystem -eq 'go')
if ($goDependencyLines.Count -ne $manifestGo.Count) {
    throw "Production Go closure count $($goDependencyLines.Count) does not match reviewed manifest count $($manifestGo.Count)."
}
foreach ($line in $goDependencyLines) {
    $fields = $line -split '\|', 2
    $purl = 'pkg:golang/{0}@{1}' -f $fields[0], $fields[1]
    $component = Get-ManifestComponent $purl
    $module = $goModules[$line]
    if (-not $module) { throw "Go module source receipt is unavailable for $line." }
    $expectedKind = if ($module.Indirect) { 'transitive' } else { 'direct' }
    if ($component.dependency_kind -ne $expectedKind) {
        throw "Go dependency classification changed for $line; expected $expectedKind."
    }
    $receipt = @($component.source_receipts | Where-Object algorithm -eq 'gomod-h1')
    if ($receipt.Count -ne 1 -or $receipt[0].value -cne $module.Sum) {
        throw "Go module source sum changed for $line."
    }
}
$goNonproductionSet = @($manifest.development_sets | Where-Object id -eq 'go-nonproduction-module-graph')
if ($goNonproductionSet.Count -ne 1 -or $goNonproductionSet[0].distributed -ne $false) {
    throw 'Go non-production module classification is missing, duplicated, or distributed.'
}
$productionGoPurls = @{}
foreach ($component in $manifestGo) { $productionGoPurls[[string]$component.purl] = $true }
$actualNonproductionGoPurls = @($goModuleLines | ForEach-Object {
    $fields = $_ -split '\|', 4
    $purl = 'pkg:golang/{0}@{1}' -f $fields[0], $fields[1]
    if (-not $productionGoPurls.ContainsKey($purl)) { $purl }
} | Sort-Object -Unique)
$reviewedNonproductionGoPurls = @($goNonproductionSet[0].packages | ForEach-Object { [string]$_ } | Sort-Object -Unique)
if ($actualNonproductionGoPurls.Count -ne [int]$goNonproductionSet[0].package_count -or
    $reviewedNonproductionGoPurls.Count -ne [int]$goNonproductionSet[0].package_count -or
    (Compare-Object -ReferenceObject $reviewedNonproductionGoPurls -DifferenceObject $actualNonproductionGoPurls)) {
    throw 'Go non-production module graph changed without an explicit distributed=false review.'
}
Write-Verbose 'Production Go closure validated.'

$reader = Join-Path $root 'tools\license-inventory.cjs'
function Read-NpmInventory([string]$LockPath) {
    $json = & node $reader $LockPath
    if ($LASTEXITCODE -ne 0) { throw "Could not read npm license inventory: $LockPath" }
    return (($json | Out-String) | ConvertFrom-Json)
}
$frontendInventory = Read-NpmInventory (Join-Path $root 'frontend\package-lock.json')
$frontendManifest = @($manifest.production | Where-Object dependency_kind -eq 'frontend-production')
if (@($frontendInventory.production).Count -ne $frontendManifest.Count) {
    throw 'Frontend production dependency closure changed without license review.'
}
foreach ($item in @($frontendInventory.production)) {
    $purl = ConvertTo-NpmPurl ([string]$item.name) ([string]$item.version)
    $component = Get-ManifestComponent $purl
    if ($component.dependency_kind -ne 'frontend-production' -or $component.license_expression -cne $item.license) {
        throw "Frontend production license/classification changed for $purl."
    }
    $receipt = @($component.source_receipts | Where-Object algorithm -eq 'npm-sri')
    if ($receipt.Count -ne 1 -or $receipt[0].value -cne $item.integrity -or $receipt[0].url -cne $item.resolved) {
        throw "Frontend production source receipt changed for $purl."
    }
}
Write-Verbose 'Frontend production/development closure loaded.'

$sidecarInventory = Read-NpmInventory (Join-Path $root 'tools\knowledge-sidecar\package-lock.json')
if (@($sidecarInventory.production).Count -ne 1 -or $sidecarInventory.development.Count -ne 0) {
    throw 'Knowledge sidecar dependency closure must contain only the reviewed Oxigraph runtime.'
}
$sidecarItem = @($sidecarInventory.production)[0]
$sidecarPurl = ConvertTo-NpmPurl ([string]$sidecarItem.name) ([string]$sidecarItem.version)
$sidecarComponent = Get-ManifestComponent $sidecarPurl
$sidecarReceipt = @($sidecarComponent.source_receipts | Where-Object algorithm -eq 'npm-sri')
if ($sidecarComponent.dependency_kind -ne 'knowledge-sidecar-runtime' -or
    $sidecarComponent.license_expression -cne $sidecarItem.license -or
    $sidecarReceipt.Count -ne 1 -or $sidecarReceipt[0].value -cne $sidecarItem.integrity) {
    throw 'Oxigraph sidecar license or source receipt changed without review.'
}
Write-Verbose 'Knowledge sidecar closure validated.'

$runtimeManifest = Get-Content -Raw -LiteralPath (Join-Path $root 'runtime-manifest.json') | ConvertFrom-Json
$runtimeVersionMap = [ordered]@{
    'pkg:generic/node.js' = [string]$runtimeManifest.components.node.version
    'pkg:npm/%40openai/codex' = [string]$runtimeManifest.components.codex.version
    'pkg:npm/chrome-devtools-mcp' = [string]$runtimeManifest.components.chromeDevtoolsMcp.version
    'pkg:npm/oxigraph' = [string]$runtimeManifest.components.oxigraph.version
    'pkg:generic/openvsp' = [string]$runtimeManifest.components.openVsp.version
    'pkg:generic/gmsh' = [string]$runtimeManifest.components.gmsh.version
    'pkg:generic/xfoil' = [string]$runtimeManifest.components.xfoil.version
    'pkg:generic/su2' = [string]$runtimeManifest.components.su2.version
}
foreach ($prefix in $runtimeVersionMap.Keys) {
    $purl = "$prefix@$($runtimeVersionMap[$prefix])"
    $null = Get-ManifestComponent $purl
}
Write-Verbose 'Runtime manifest versions validated.'

$runtimeRoot = Join-Path $root '.runtime'
if (Test-Path -LiteralPath (Join-Path $runtimeRoot 'verification-receipt.json') -PathType Leaf) {
    $runtimeReceipt = Get-Content -Raw -LiteralPath (Join-Path $runtimeRoot 'verification-receipt.json') | ConvertFrom-Json
    $receiptChecks = @(
        @('pkg:generic/node.js@24.19.0', 'SHA-256', [string]$runtimeReceipt.node.sha256),
        @('pkg:npm/%40openai/codex@0.146.1', 'npm-sri', [string]$runtimeReceipt.codex.integrity),
        @('pkg:npm/%40openai/codex@0.146.1', 'npm-sri', [string]$runtimeReceipt.codex.nativeIntegrity),
        @('pkg:npm/chrome-devtools-mcp@1.6.0', 'npm-sri', [string]$runtimeReceipt.chromeDevtoolsMcp.integrity),
        @('pkg:npm/oxigraph@0.5.9', 'npm-sri', [string]$runtimeReceipt.oxigraph.integrity),
        @('pkg:generic/openvsp@3.50.4', 'SHA-256', [string]$runtimeReceipt.engineeringTools.openvsp.sha256),
        @('pkg:generic/gmsh@4.14.1', 'SHA-256', [string]$runtimeReceipt.engineeringTools.gmsh.sha256),
        @('pkg:generic/xfoil@6.99', 'SHA-256', [string]$runtimeReceipt.engineeringTools.xfoil.sha256),
        @('pkg:generic/su2@8.5.0', 'SHA-256', [string]$runtimeReceipt.engineeringTools.su2.sha256)
    )
    foreach ($check in $receiptChecks) {
        $component = Get-ManifestComponent $check[0]
        if (@($component.source_receipts | Where-Object { $_.algorithm -eq $check[1] -and $_.value -ceq $check[2] }).Count -ne 1) {
            throw "Managed runtime receipt is not represented exactly in the license manifest: $($check[0])."
        }
    }
}
Write-Verbose 'Runtime source receipts validated.'

$generator = Join-Path $root 'tools\license-sbom.cjs'
& node $generator $root $output
if ($LASTEXITCODE -ne 0) { throw 'Deterministic SBOM serialization failed.' }
Write-Verbose 'SBOM documents generated and serialized.'

if ($VerifyOnly) {
    foreach ($name in @('cyclonedx.json', 'spdx.json')) {
        $checked = Join-Path $checkedOutput $name
        $generated = Join-Path $verificationOutput $name
        if (-not (Test-Path -LiteralPath $checked -PathType Leaf)) { throw "Checked-in SBOM is missing: sbom\$name" }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $checked).Hash -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $generated).Hash) {
            throw "Checked-in SBOM is stale: sbom\$name"
        }
    }
    Remove-Item -LiteralPath $verificationOutput -Recurse -Force
    $verificationOutput = $null
    Write-Host 'Checked-in CycloneDX/SPDX SBOMs match the reviewed production closure and excluded development inventory.'
} else {
    Write-Host "Generated licensed CycloneDX and SPDX SBOMs in $output"
}
