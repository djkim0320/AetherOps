param(
    [string]$OpenVSPDirectory = 'D:\Tools\OpenVSP\OpenVSP-3.50.4-ko',
    [string]$GmshExecutable = "$env:LOCALAPPDATA\Programs\Python\Python311\Scripts\gmsh.bat",
    [int]$Threads = [Math]::Max(1, [Environment]::ProcessorCount)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$outputDirectory = Join-Path $repositoryRoot 'build\tool-smoke'
$vspScriptExecutable = Join-Path $OpenVSPDirectory 'vspscript.exe'
$baselineScript = Join-Path $PSScriptRoot 'openvsp_vspaero_smoke.vspscript'
$modifyScript = Join-Path $PSScriptRoot 'openvsp_modify_smoke.vspscript'
$gmshGeometry = Join-Path $PSScriptRoot 'gmsh_wing_mesh.geo'

foreach ($requiredFile in @($vspScriptExecutable, $GmshExecutable, $baselineScript, $modifyScript, $gmshGeometry)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required real tool or fixture is missing: $requiredFile"
    }
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
Push-Location $outputDirectory
try {
    $vspVersionText = (& $vspScriptExecutable -help 2>&1) -join [Environment]::NewLine
    if ($LASTEXITCODE -ne 0) {
        throw "OpenVSP version probe failed with exit code $LASTEXITCODE"
    }
    $vspVersionMatch = [regex]::Match($vspVersionText, '\b\d+\.\d+\.\d+\b')
    if (-not $vspVersionMatch.Success) {
        throw 'OpenVSP version probe returned no semantic version'
    }
    $gmshVersionText = ((& $GmshExecutable --version 2>&1) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or $gmshVersionText -notmatch '^\d+\.\d+\.\d+$') {
        throw 'Gmsh version probe failed or returned an invalid semantic version'
    }

    $baselineLines = & $vspScriptExecutable -script $baselineScript 2>&1 |
        Tee-Object -FilePath 'openvsp_vspaero_smoke.log'
    if ($LASTEXITCODE -ne 0) {
        throw "OpenVSP/VSPAERO smoke process failed with exit code $LASTEXITCODE"
    }
    $baselineLog = $baselineLines -join [Environment]::NewLine
    if ($baselineLog -match 'AETHEROPS_SMOKE_ERROR=') {
        throw 'OpenVSP/VSPAERO emitted an AETHEROPS_SMOKE_ERROR marker'
    }
    $coefficientMatches = [regex]::Matches(
        $baselineLog,
        'AETHEROPS_SMOKE_ALPHA=([-+0-9.eE]+),CL=([-+0-9.eE]+),CD=([-+0-9.eE]+)'
    )
    if ($coefficientMatches.Count -ne 3) {
        throw "Expected three aerodynamic samples, got $($coefficientMatches.Count)"
    }
    $coefficients = foreach ($match in $coefficientMatches) {
        [pscustomobject]@{
            Alpha = [double]$match.Groups[1].Value
            CL = [double]$match.Groups[2].Value
            CD = [double]$match.Groups[3].Value
        }
    }
    if (($coefficients.Alpha -join ',') -ne '0,2,4') {
        throw 'The aerodynamic sweep did not return alpha 0, 2, and 4 degrees'
    }
    if ($coefficients[1].CL -le $coefficients[0].CL -or $coefficients[2].CL -le $coefficients[1].CL) {
        throw 'CL is not strictly increasing across the positive-alpha sweep'
    }
    foreach ($sample in $coefficients) {
        if ([double]::IsNaN($sample.CL) -or [double]::IsInfinity($sample.CL) -or
            [double]::IsNaN($sample.CD) -or [double]::IsInfinity($sample.CD) -or $sample.CD -le 0) {
            throw 'The aerodynamic sweep produced a non-finite coefficient or non-positive CD'
        }
    }

    $sourceModel = Join-Path $outputDirectory 'aetherops_smoke_wing.vsp3'
    $polarFile = Join-Path $outputDirectory 'aetherops_smoke_wing.polar'
    $resultsFile = Join-Path $outputDirectory 'aetherops_smoke_results.csv'
    foreach ($artifact in @($sourceModel, $polarFile, $resultsFile)) {
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf) -or (Get-Item -LiteralPath $artifact).Length -eq 0) {
            throw "OpenVSP/VSPAERO did not produce a non-empty artifact: $artifact"
        }
    }

    $modifyLines = & $vspScriptExecutable -script $modifyScript 2>&1 |
        Tee-Object -FilePath 'openvsp_modify_smoke.log'
    if ($LASTEXITCODE -ne 0) {
        throw "OpenVSP model modification failed with exit code $LASTEXITCODE"
    }
    $modifyLog = $modifyLines -join [Environment]::NewLine
    if ($modifyLog -match 'AETHEROPS_MODIFY_ERROR=') {
        throw 'OpenVSP model modification emitted an error marker'
    }
    if ($modifyLog -notmatch 'AETHEROPS_MODIFY_OLD_SWEEP=10(?:\.0+)?' -or
        $modifyLog -notmatch 'AETHEROPS_MODIFY_NEW_SWEEP=15(?:\.0+)?') {
        throw 'OpenVSP did not verify the requested sweep change from 10 to 15 degrees'
    }
    $modifiedModel = Join-Path $outputDirectory 'aetherops_smoke_wing_modified.vsp3'
    if (-not (Test-Path -LiteralPath $modifiedModel -PathType Leaf)) {
        throw 'The modified OpenVSP model was not created'
    }
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceModel).Hash
    $modifiedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $modifiedModel).Hash
    if ($sourceHash -eq $modifiedHash) {
        throw 'The source and modified OpenVSP model hashes are identical'
    }

    $gmshLines = & $GmshExecutable $gmshGeometry -2 -nt $Threads -format msh4 -o 'aetherops_smoke_wing.msh' 2>&1 |
        Tee-Object -FilePath 'gmsh_wing_mesh.log'
    if ($LASTEXITCODE -ne 0) {
        throw "Gmsh mesh generation failed with exit code $LASTEXITCODE"
    }
    $gmshLog = $gmshLines -join [Environment]::NewLine
    $checkLines = & $GmshExecutable 'aetherops_smoke_wing.msh' -check -nt $Threads 2>&1 |
        Tee-Object -FilePath 'gmsh_wing_mesh_check.log'
    if ($LASTEXITCODE -ne 0) {
        throw "Gmsh coherence check failed with exit code $LASTEXITCODE"
    }
    $checkLog = $checkLines -join [Environment]::NewLine
    if (($gmshLog + $checkLog) -match '(?im)^\s*Error\s*:' -or $checkLog -notmatch 'Done checking mesh coherence') {
        throw 'Gmsh did not complete a clean mesh coherence check'
    }
    $nodeMatch = [regex]::Match($checkLog, 'Info\s*:\s*(\d+)\s+nodes')
    $elementMatch = [regex]::Match($checkLog, 'Info\s*:\s*(\d+)\s+elements')
    if (-not $nodeMatch.Success -or -not $elementMatch.Success) {
        throw 'Gmsh mesh count summary is missing'
    }
    $meshFile = Join-Path $outputDirectory 'aetherops_smoke_wing.msh'
    if (-not (Test-Path -LiteralPath $meshFile -PathType Leaf) -or (Get-Item -LiteralPath $meshFile).Length -eq 0) {
        throw 'Gmsh produced no mesh artifact'
    }

    [pscustomobject]@{
        Status = 'PASS'
        OpenVSP = [pscustomobject]@{
            Version = $vspVersionMatch.Value
            VSPAEROThreadsObserved = 4
            Coefficients = $coefficients
            SourceModelSHA256 = $sourceHash
            ModifiedModelSHA256 = $modifiedHash
            PolarSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $polarFile).Hash
            ResultsSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $resultsFile).Hash
        }
        Gmsh = [pscustomobject]@{
            Version = $gmshVersionText
            ThreadsRequested = $Threads
            Nodes = [int]$nodeMatch.Groups[1].Value
            Elements = [int]$elementMatch.Groups[1].Value
            CoherenceCheck = 'PASS'
            MeshSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $meshFile).Hash
        }
    } | ConvertTo-Json -Depth 6
}
finally {
    Pop-Location
}
