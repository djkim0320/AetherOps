param(
    [string]$XfoilExecutable = '',
    [string]$SU2Executable = '',
    [int]$Threads = [Math]::Max(1, [Environment]::ProcessorCount),
    [ValidateRange(30, 900)]
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$invariantCulture = [Globalization.CultureInfo]::InvariantCulture
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$outputRoot = Join-Path $repositoryRoot 'build\tool-smoke'
$cacheRoot = Join-Path $outputRoot 'official-cache'
$executionRoot = Join-Path $outputRoot (Join-Path 'cli-solvers' ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ', $invariantCulture) + '-' + [Guid]::NewGuid().ToString('N')))
$startedUTC = (Get-Date).ToUniversalTime()

$officialAssets = @{
    XfoilArchive = @{
        Uri = 'https://web.mit.edu/drela/Public/web/xfoil/XFOIL6.99.zip'
        FileName = 'XFOIL6.99.zip'
        SHA256 = 'E13E8FE5CC38D8AC2626E9D3B17643BDCFAA63791619F042AFDAA7CD103BCB08'
    }
    SU2Archive = @{
        Uri = 'https://github.com/su2code/SU2/releases/download/v8.5.0/SU2-v8.5.0-win64-omp.zip'
        FileName = 'SU2-v8.5.0-win64-omp.zip'
        SHA256 = '4466FE21AEDB5E0BAD57AFD45F829ACBDEC6EC79FE8C3F8954DDEA06A4B4BC11'
    }
    SU2QuickStartConfig = @{
        Uri = 'https://raw.githubusercontent.com/su2code/SU2/v8.5.0/QuickStart/inv_NACA0012.cfg'
        FileName = 'inv_NACA0012.cfg'
        SHA256 = '3F0568E0A78FB382E4EFEA92E59F038E422830EC6C84CF26C935301D63A9647D'
    }
    SU2QuickStartMesh = @{
        Uri = 'https://raw.githubusercontent.com/su2code/SU2/v8.5.0/QuickStart/mesh_NACA0012_inv.su2'
        FileName = 'mesh_NACA0012_inv.su2'
        SHA256 = '9094B51C2628D3BB4C865D774B2308DBB59A213AD19C007CFCD7D57E7AAEEBEB'
    }
}

$officialHashes = @{
    XfoilExecutable = 'C17342F84AE260C2B11A74CD0E2FB8189A5F8954C6BB7A8467A0F27055C7FAEA'
    SU2NestedArchive = '48E8A1C1CD5DB8F545612C6E86CC2A386487A02B1C35B6AC4DE491B0C67E1E59'
    SU2Executable = '3CB60646B31C08E468441BE9F3497601960D4BB31349E6329982BCDEED599248'
}

function Get-SHA256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
}

function Assert-PinnedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSHA256,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
    $actualHash = Get-SHA256 -Path $Path
    if ($actualHash -ne $ExpectedSHA256) {
        throw "$Description failed SHA-256 verification. Expected $ExpectedSHA256, got $actualHash"
    }
}

function Get-OfficialAsset {
    param([Parameter(Mandatory = $true)][hashtable]$Asset)

    $target = Join-Path $cacheRoot $Asset.FileName
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        Assert-PinnedFile -Path $target -ExpectedSHA256 $Asset.SHA256 -Description $Asset.FileName
        return $target
    }

    $partial = "$target.part-$([Guid]::NewGuid().ToString('N'))"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Asset.Uri -OutFile $partial
        Assert-PinnedFile -Path $partial -ExpectedSHA256 $Asset.SHA256 -Description $Asset.FileName
        Move-Item -LiteralPath $partial -Destination $target
    }
    finally {
        if (Test-Path -LiteralPath $partial -PathType Leaf) {
            Remove-Item -LiteralPath $partial -Force
        }
    }
    return $target
}

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $fullChild = [IO.Path]::GetFullPath($Child)
    if (-not $fullChild.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing an operation outside the expected directory: $fullChild"
    }
}

function Install-OfficialXfoil {
    $runtimeRoot = Join-Path $cacheRoot 'xfoil-6.99'
    $executable = Join-Path $runtimeRoot 'xfoil.exe'
    if (Test-Path -LiteralPath $executable -PathType Leaf) {
        Assert-PinnedFile -Path $executable -ExpectedSHA256 $officialHashes.XfoilExecutable -Description 'official XFOIL executable'
        return $executable
    }
    if (Test-Path -LiteralPath $runtimeRoot) {
        throw "Incomplete XFOIL runtime directory exists: $runtimeRoot"
    }

    $archive = Get-OfficialAsset -Asset $officialAssets.XfoilArchive
    $candidate = "$runtimeRoot.extract-$([Guid]::NewGuid().ToString('N'))"
    Assert-ContainedPath -Parent $cacheRoot -Child $candidate
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $candidate
        $candidateExecutable = Join-Path $candidate 'xfoil.exe'
        Assert-PinnedFile -Path $candidateExecutable -ExpectedSHA256 $officialHashes.XfoilExecutable -Description 'extracted XFOIL executable'
        Move-Item -LiteralPath $candidate -Destination $runtimeRoot
    }
    finally {
        if (Test-Path -LiteralPath $candidate) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
    }
    return $executable
}

function Install-OfficialSU2 {
    $runtimeRoot = Join-Path $cacheRoot 'su2-8.5.0-win64-omp'
    $executable = Join-Path $runtimeRoot 'bin\SU2_CFD.exe'
    if (Test-Path -LiteralPath $executable -PathType Leaf) {
        Assert-PinnedFile -Path $executable -ExpectedSHA256 $officialHashes.SU2Executable -Description 'official SU2_CFD executable'
        return $executable
    }
    if (Test-Path -LiteralPath $runtimeRoot) {
        throw "Incomplete SU2 runtime directory exists: $runtimeRoot"
    }

    $archive = Get-OfficialAsset -Asset $officialAssets.SU2Archive
    $outerCandidate = Join-Path $cacheRoot ("su2-outer.extract-$([Guid]::NewGuid().ToString('N'))")
    $runtimeCandidate = "$runtimeRoot.extract-$([Guid]::NewGuid().ToString('N'))"
    Assert-ContainedPath -Parent $cacheRoot -Child $outerCandidate
    Assert-ContainedPath -Parent $cacheRoot -Child $runtimeCandidate
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $outerCandidate
        $nestedArchive = Join-Path $outerCandidate 'win64-omp.zip'
        Assert-PinnedFile -Path $nestedArchive -ExpectedSHA256 $officialHashes.SU2NestedArchive -Description 'SU2 nested win64-omp archive'
        Expand-Archive -LiteralPath $nestedArchive -DestinationPath $runtimeCandidate
        $candidateExecutable = Join-Path $runtimeCandidate 'bin\SU2_CFD.exe'
        Assert-PinnedFile -Path $candidateExecutable -ExpectedSHA256 $officialHashes.SU2Executable -Description 'extracted SU2_CFD executable'
        Move-Item -LiteralPath $runtimeCandidate -Destination $runtimeRoot
    }
    finally {
        foreach ($temporaryDirectory in @($outerCandidate, $runtimeCandidate)) {
            if (Test-Path -LiteralPath $temporaryDirectory) {
                Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
            }
        }
    }
    return $executable
}

function Invoke-Process {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [AllowEmptyString()][string]$StandardInput = '',
        [hashtable]$Environment = @{}
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = ($Arguments -join ' ')
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in $Environment.Keys) {
        $startInfo.EnvironmentVariables[$name] = [string]$Environment[$name]
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) {
            throw "Failed to start process: $Executable"
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($StandardInput.Length -gt 0) {
            $process.StandardInput.Write($StandardInput)
        }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Process exceeded the $TimeoutSeconds second timeout: $Executable"
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdout
            Stderr = $stderr
            DurationMilliseconds = $stopwatch.ElapsedMilliseconds
        }
    }
    finally {
        $stopwatch.Stop()
        $process.Dispose()
    }
}

function Convert-ToFiniteDouble {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $value = [double]::Parse($Text, [Globalization.NumberStyles]::Float, $invariantCulture)
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) {
        throw "$Description is not finite: $Text"
    }
    return $value
}

if ($Threads -lt 1) {
    throw 'Threads must be at least 1'
}

New-Item -ItemType Directory -Force -Path $outputRoot, $cacheRoot, $executionRoot | Out-Null

if ([string]::IsNullOrWhiteSpace($XfoilExecutable)) {
    $XfoilExecutable = Install-OfficialXfoil
}
elseif (-not (Test-Path -LiteralPath $XfoilExecutable -PathType Leaf)) {
    throw "The explicitly selected XFOIL executable is missing: $XfoilExecutable"
}
else {
    $XfoilExecutable = (Resolve-Path -LiteralPath $XfoilExecutable).Path
}

if ([string]::IsNullOrWhiteSpace($SU2Executable)) {
    $SU2Executable = Install-OfficialSU2
}
elseif (-not (Test-Path -LiteralPath $SU2Executable -PathType Leaf)) {
    throw "The explicitly selected SU2 executable is missing: $SU2Executable"
}
else {
    $SU2Executable = (Resolve-Path -LiteralPath $SU2Executable).Path
}

$xfoilRunDirectory = Join-Path $executionRoot 'xfoil'
$su2RunDirectory = Join-Path $executionRoot 'su2'
New-Item -ItemType Directory -Force -Path $xfoilRunDirectory, $su2RunDirectory | Out-Null

$xfoilInputSource = Join-Path $PSScriptRoot 'xfoil_naca0012.in'
if (-not (Test-Path -LiteralPath $xfoilInputSource -PathType Leaf)) {
    throw "XFOIL input fixture is missing: $xfoilInputSource"
}
$xfoilInput = Join-Path $xfoilRunDirectory 'xfoil_naca0012.in'
Copy-Item -LiteralPath $xfoilInputSource -Destination $xfoilInput

$xfoilProbe = Invoke-Process -Executable $XfoilExecutable -Arguments @() -WorkingDirectory $xfoilRunDirectory -StandardInput "QUIT`r`n"
$xfoilProbeLog = $xfoilProbe.Stdout + $xfoilProbe.Stderr
if ($xfoilProbe.ExitCode -ne 0 -or $xfoilProbeLog -notmatch 'XFOIL Version\s+6\.99') {
    throw 'XFOIL version probe did not identify version 6.99'
}

$xfoilResult = Invoke-Process -Executable $XfoilExecutable -Arguments @() -WorkingDirectory $xfoilRunDirectory -StandardInput (Get-Content -Raw -LiteralPath $xfoilInput)
$xfoilLog = $xfoilResult.Stdout + $xfoilResult.Stderr
[IO.File]::WriteAllText((Join-Path $xfoilRunDirectory 'xfoil_naca0012.log'), $xfoilLog)
if ($xfoilResult.ExitCode -ne 0) {
    throw "XFOIL exited with code $($xfoilResult.ExitCode)"
}
if ($xfoilLog -match '(?im)Convergence failed') {
    throw 'XFOIL reported a convergence failure'
}

$xfoilPolar = Join-Path $xfoilRunDirectory 'xfoil_naca0012.polar'
if (-not (Test-Path -LiteralPath $xfoilPolar -PathType Leaf)) {
    throw 'XFOIL did not produce its polar file'
}
$xfoilSamples = @()
foreach ($line in Get-Content -LiteralPath $xfoilPolar) {
    $match = [regex]::Match($line, '^\s*([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s*$')
    if ($match.Success) {
        $xfoilSamples += [pscustomobject]@{
            Alpha = Convert-ToFiniteDouble -Text $match.Groups[1].Value -Description 'XFOIL alpha'
            CL = Convert-ToFiniteDouble -Text $match.Groups[2].Value -Description 'XFOIL CL'
            CD = Convert-ToFiniteDouble -Text $match.Groups[3].Value -Description 'XFOIL CD'
        }
    }
}
if ($xfoilSamples.Count -ne 3 -or ($xfoilSamples.Alpha -join ',') -ne '0,2,4') {
    throw 'XFOIL did not produce exactly the requested alpha 0, 2, and 4 degree samples'
}
if ($xfoilSamples[1].CL -le $xfoilSamples[0].CL -or $xfoilSamples[2].CL -le $xfoilSamples[1].CL) {
    throw 'XFOIL CL is not strictly increasing across alpha 0, 2, and 4 degrees'
}
foreach ($sample in $xfoilSamples) {
    if ($sample.CD -le 0) {
        throw 'XFOIL produced a non-positive drag coefficient'
    }
}

$su2ConfigSource = Get-OfficialAsset -Asset $officialAssets.SU2QuickStartConfig
$su2MeshSource = Get-OfficialAsset -Asset $officialAssets.SU2QuickStartMesh
$su2Config = Join-Path $su2RunDirectory 'inv_NACA0012.cfg'
$su2Mesh = Join-Path $su2RunDirectory 'mesh_NACA0012_inv.su2'
Copy-Item -LiteralPath $su2ConfigSource -Destination $su2Config
Copy-Item -LiteralPath $su2MeshSource -Destination $su2Mesh

$su2Probe = Invoke-Process -Executable $SU2Executable -Arguments @('--help') -WorkingDirectory $su2RunDirectory
$su2ProbeLog = $su2Probe.Stdout + $su2Probe.Stderr
if ($su2Probe.ExitCode -ne 0 -or $su2ProbeLog -notmatch 'SU2 v8\.5\.0') {
    throw 'SU2 version probe did not identify version 8.5.0'
}

$su2Result = Invoke-Process -Executable $SU2Executable -Arguments @('-t', $Threads.ToString($invariantCulture), 'inv_NACA0012.cfg') -WorkingDirectory $su2RunDirectory -Environment @{
    OMP_NUM_THREADS = $Threads.ToString($invariantCulture)
    OMP_DYNAMIC = 'FALSE'
}
$su2Log = $su2Result.Stdout + $su2Result.Stderr
[IO.File]::WriteAllText((Join-Path $su2RunDirectory 'su2_naca0012.log'), $su2Log)
if ($su2Result.ExitCode -ne 0) {
    throw "SU2_CFD exited with code $($su2Result.ExitCode)"
}
if ($su2Log -notmatch 'All convergence criteria satisfied\.' -or $su2Log -notmatch 'Exit Success \(SU2_CFD\)') {
    throw 'SU2_CFD did not report a converged successful exit'
}

$su2History = Join-Path $su2RunDirectory 'history.csv'
if (-not (Test-Path -LiteralPath $su2History -PathType Leaf)) {
    throw 'SU2_CFD did not produce history.csv'
}
$historyRows = @(Import-Csv -LiteralPath $su2History)
if ($historyRows.Count -lt 10) {
    throw 'SU2_CFD convergence history is unexpectedly short'
}
$initialResidual = Convert-ToFiniteDouble -Text $historyRows[0].'rms[Rho]' -Description 'initial SU2 density residual'
$finalResidual = Convert-ToFiniteDouble -Text $historyRows[-1].'rms[Rho]' -Description 'final SU2 density residual'
if ($finalResidual -ge $initialResidual -or $finalResidual -gt -8.0) {
    throw "SU2 density residual did not meet the expected convergence criterion: $initialResidual -> $finalResidual"
}

$su2CoefficientRows = @()
foreach ($line in ($su2Log -split "`r?`n")) {
    if ($line -match '^\|\s*\d+\|') {
        $fields = @($line.Split('|') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
        if ($fields.Count -eq 9) {
            $su2CoefficientRows += [pscustomobject]@{
                Iteration = [int]::Parse($fields[0], [Globalization.NumberStyles]::Integer, $invariantCulture)
                CL = Convert-ToFiniteDouble -Text $fields[7] -Description 'SU2 CL'
                CD = Convert-ToFiniteDouble -Text $fields[8] -Description 'SU2 CD'
            }
        }
    }
}
if ($su2CoefficientRows.Count -eq 0) {
    throw 'SU2_CFD screen history contained no parseable aerodynamic coefficients'
}
$su2FinalCoefficients = $su2CoefficientRows[-1]
if ($su2FinalCoefficients.CD -le 0) {
    throw 'SU2_CFD produced a non-positive final drag coefficient'
}

$su2Artifacts = @('history.csv', 'restart_flow.dat', 'surface_flow.csv', 'flow.vtu')
$su2ArtifactReceipts = @()
foreach ($artifactName in $su2Artifacts) {
    $artifactPath = Join-Path $su2RunDirectory $artifactName
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf) -or (Get-Item -LiteralPath $artifactPath).Length -eq 0) {
        throw "SU2_CFD did not produce a non-empty artifact: $artifactName"
    }
    $su2ArtifactReceipts += [pscustomobject]@{
        Name = $artifactName
        SHA256 = Get-SHA256 -Path $artifactPath
        Bytes = (Get-Item -LiteralPath $artifactPath).Length
    }
}

$receipt = [pscustomobject]@{
    SchemaVersion = 1
    Status = 'PASS'
    StartedUTC = $startedUTC.ToString('o', $invariantCulture)
    CompletedUTC = (Get-Date).ToUniversalTime().ToString('o', $invariantCulture)
    ExecutionDirectory = $executionRoot
    XFOIL = [pscustomobject]@{
        Version = '6.99'
        OfficialArchive = [pscustomobject]@{
            URL = $officialAssets.XfoilArchive.Uri
            SHA256 = $officialAssets.XfoilArchive.SHA256
        }
        Executable = $XfoilExecutable
        ExecutableSHA256 = Get-SHA256 -Path $XfoilExecutable
        Command = [pscustomobject]@{
            Executable = $XfoilExecutable
            Arguments = @()
            StandardInputSHA256 = Get-SHA256 -Path $xfoilInput
        }
        DurationMilliseconds = $xfoilResult.DurationMilliseconds
        Case = [pscustomobject]@{
            Airfoil = 'NACA0012'
            ReynoldsNumber = 1000000
            MachNumber = 0.10
            Coefficients = $xfoilSamples
        }
        PolarSHA256 = Get-SHA256 -Path $xfoilPolar
        LogSHA256 = Get-SHA256 -Path (Join-Path $xfoilRunDirectory 'xfoil_naca0012.log')
    }
    SU2 = [pscustomobject]@{
        Version = '8.5.0'
        Distribution = 'win64-omp'
        OfficialArchive = [pscustomobject]@{
            URL = $officialAssets.SU2Archive.Uri
            SHA256 = $officialAssets.SU2Archive.SHA256
        }
        Executable = $SU2Executable
        ExecutableSHA256 = Get-SHA256 -Path $SU2Executable
        Command = [pscustomobject]@{
            Executable = $SU2Executable
            Arguments = @('-t', $Threads.ToString($invariantCulture), 'inv_NACA0012.cfg')
            WorkingDirectory = $su2RunDirectory
            Environment = [pscustomobject]@{
                OMP_NUM_THREADS = $Threads
                OMP_DYNAMIC = 'FALSE'
            }
        }
        DurationMilliseconds = $su2Result.DurationMilliseconds
        QuickStartInputs = @(
            [pscustomobject]@{ Name = $officialAssets.SU2QuickStartConfig.FileName; URL = $officialAssets.SU2QuickStartConfig.Uri; SHA256 = Get-SHA256 -Path $su2Config },
            [pscustomobject]@{ Name = $officialAssets.SU2QuickStartMesh.FileName; URL = $officialAssets.SU2QuickStartMesh.Uri; SHA256 = Get-SHA256 -Path $su2Mesh }
        )
        Convergence = [pscustomobject]@{
            Iterations = $historyRows.Count
            InitialRMSDensity = $initialResidual
            FinalRMSDensity = $finalResidual
            FinalCL = $su2FinalCoefficients.CL
            FinalCD = $su2FinalCoefficients.CD
        }
        Artifacts = $su2ArtifactReceipts
        LogSHA256 = Get-SHA256 -Path (Join-Path $su2RunDirectory 'su2_naca0012.log')
    }
}

$receiptJson = $receipt | ConvertTo-Json -Depth 10
$executionReceipt = Join-Path $executionRoot 'receipt.json'
$latestReceipt = Join-Path $outputRoot 'cli-solvers-receipt.json'
[IO.File]::WriteAllText($executionReceipt, $receiptJson + [Environment]::NewLine)
$latestPartial = "$latestReceipt.part-$([Guid]::NewGuid().ToString('N'))"
try {
    [IO.File]::WriteAllText($latestPartial, $receiptJson + [Environment]::NewLine)
    Move-Item -LiteralPath $latestPartial -Destination $latestReceipt -Force
}
finally {
    if (Test-Path -LiteralPath $latestPartial -PathType Leaf) {
        Remove-Item -LiteralPath $latestPartial -Force
    }
}

$receiptJson
