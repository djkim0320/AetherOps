[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$policy = Get-Content -Raw -LiteralPath (Join-Path $root 'dependency-policy.json') | ConvertFrom-Json
$go = Join-Path $root '.tools\go1.26.5\bin\go.exe'
if (-not (Test-Path -LiteralPath $go)) {
	$installedGo = Get-Command go -ErrorAction SilentlyContinue
	if (-not $installedGo) { throw 'Pinned Go toolchain is not installed. Run tools\dev.ps1 bootstrap first.' }
	$go = $installedGo.Source
}
$goVersion = & $go version
if ($LASTEXITCODE -ne 0 -or $goVersion -notmatch '\bgo1\.26\.5\b') {
	throw "Dependency verification requires Go 1.26.5; found: $goVersion"
}

$goList = & $go list -m -f '{{if not .Indirect}}{{if not .Main}}{{.Path}}@{{.Version}}{{end}}{{end}}' all
if ($LASTEXITCODE -ne 0) { throw 'go list failed' }
$actualGo = @($goList | Where-Object { $_ }) | Sort-Object
$expectedGo = @($policy.goDirect) | Sort-Object
if (Compare-Object $expectedGo $actualGo) {
    throw "Direct Go dependencies differ from dependency-policy.json.`nExpected: $($expectedGo -join ', ')`nActual: $($actualGo -join ', ')"
}

$package = Get-Content -Raw -LiteralPath (Join-Path $root 'frontend\package.json') | ConvertFrom-Json
$actualProduction = @($package.dependencies.psobject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" }) | Sort-Object
$actualDevelopment = @($package.devDependencies.psobject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" }) | Sort-Object
if (Compare-Object (@($policy.npmProduction) | Sort-Object) $actualProduction) {
    throw 'Production npm dependencies differ from dependency-policy.json.'
}
if (Compare-Object (@($policy.npmDevelopment) | Sort-Object) $actualDevelopment) {
    throw 'Development npm dependencies differ from dependency-policy.json.'
}

$sidecarPolicies = $policy.npmSidecarProduction
if ($sidecarPolicies) {
	foreach ($sidecarProperty in $sidecarPolicies.psobject.Properties) {
		$sidecarPath = Join-Path $root $sidecarProperty.Name
		$sidecarPackagePath = Join-Path $sidecarPath 'package.json'
		if (-not (Test-Path -LiteralPath $sidecarPackagePath -PathType Leaf)) {
			throw "Sidecar package declared in dependency-policy.json is missing: $($sidecarProperty.Name)"
		}
		$sidecarPackage = Get-Content -Raw -LiteralPath $sidecarPackagePath | ConvertFrom-Json
		$actualSidecar = @($sidecarPackage.dependencies.psobject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" }) | Sort-Object
		$expectedSidecar = @($sidecarProperty.Value) | Sort-Object
		if (Compare-Object $expectedSidecar $actualSidecar) {
			throw "Sidecar npm dependencies differ from dependency-policy.json: $($sidecarProperty.Name)"
		}
	}
}

Write-Host 'Dependency policy verified.'
