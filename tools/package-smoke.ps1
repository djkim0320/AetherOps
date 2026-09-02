[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ZipPath,
    [Parameter(Mandatory = $true)]
    [string]$StagingRoot,
    [ValidateSet('release', 'development')]
    [string]$ExpectedBuildMode = 'release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = [IO.Path]::GetFullPath((Join-Path $root 'build')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$buildPrefix = $build + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Path]::GetFullPath($ZipPath)
$staging = [IO.Path]::GetFullPath($StagingRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "Portable ZIP is missing: $zip" }
if (-not (Test-Path -LiteralPath $staging -PathType Container)) { throw "Portable staging root is missing: $staging" }
if (-not $staging.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable staging root escaped the build directory: $staging"
}

$smokeRoot = [IO.Path]::GetFullPath((Join-Path $build ('package-readback-' + [Guid]::NewGuid().ToString('N'))))
if (-not $smokeRoot.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Package smoke root escaped the build directory: $smokeRoot"
}
$extractRoot = Join-Path $smokeRoot 'portable'
$dataRoot = Join-Path $smokeRoot 'data'
$descriptorPath = Join-Path $smokeRoot 'readiness.json'
$process = $null
$hostileVariables = @(
    'AETHEROPS_DEV',
    'AETHEROPS_DATA_DIR',
    'AETHEROPS_RUNTIME_FEED_URL',
    'AETHEROPS_RUNTIME_KEY_ID',
    'AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64',
    'NODE_OPTIONS',
    'NODE_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY'
)
$previousEnvironment = @{}
foreach ($name in $hostileVariables) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $extractRoot

    $manifestPath = Join-Path $extractRoot 'PACKAGE-CONTENTS.sha256'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Portable archive omitted PACKAGE-CONTENTS.sha256.'
    }
    $expected = @{}
    foreach ($line in Get-Content -LiteralPath $manifestPath) {
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') {
            throw "Malformed portable content manifest line: $line"
        }
        $relative = $Matches[2]
        if ([IO.Path]::IsPathRooted($relative) -or $relative.Split('\') -contains '..' -or $expected.ContainsKey($relative)) {
            throw "Unsafe or duplicate portable manifest path: $relative"
        }
        $expected[$relative] = $Matches[1]
    }
    if ($expected.Count -eq 0) { throw 'Portable content manifest is empty.' }

    $actualFiles = Get-ChildItem -LiteralPath $extractRoot -Recurse -Force -File
    foreach ($file in $actualFiles) {
        $relative = $file.FullName.Substring($extractRoot.Length + 1).Replace('/', '\')
        if ($relative -eq 'PACKAGE-CONTENTS.sha256') { continue }
        if (-not $expected.ContainsKey($relative)) { throw "Portable archive contains an unmanifested file: $relative" }
        $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        if ($actualHash -ne $expected[$relative]) { throw "Portable file hash mismatch: $relative" }
        $expected.Remove($relative)
    }
    if ($expected.Count -ne 0) {
        throw "Portable archive omitted $($expected.Count) manifested files; first: $(@($expected.Keys | Sort-Object)[0])"
    }

    $activePath = Join-Path $extractRoot 'runtime\active.json'
    $active = Get-Content -Raw -LiteralPath $activePath | ConvertFrom-Json
    foreach ($property in $active.componentRoots.psobject.Properties) {
        $relativeRoot = [string]$property.Value
        if ([IO.Path]::IsPathRooted($relativeRoot) -or $relativeRoot.Split('/') -contains '..') {
            throw "Unsafe runtime component root for $($property.Name): $relativeRoot"
        }
        if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $extractRoot 'runtime') $relativeRoot) -PathType Container)) {
            throw "Portable runtime component root is missing for $($property.Name): $relativeRoot"
        }
    }

    $executable = Join-Path $extractRoot 'aetherops.exe'
    New-Item -ItemType Directory -Path $dataRoot | Out-Null
    foreach ($name in $hostileVariables) {
        [Environment]::SetEnvironmentVariable($name, 'hostile-environment-value', 'Process')
    }
    $arguments = @(
        'release-eval-session', '--descriptor', ('"{0}"' -f $descriptorPath),
        '--data-root', ('"{0}"' -f $dataRoot)
    )
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf) -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $process.Refresh()
    }
    if ($process.HasExited) {
        throw "Portable executable exited before readiness with code $($process.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) {
        throw 'Portable executable did not publish the normal-core readiness receipt.'
    }
    $readiness = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
    if ($readiness.schema -cne 'aetherops_release_eval_api_session_v2' -or
        $readiness.mode -cne 'normal' -or $readiness.build_mode -cne $ExpectedBuildMode -or
        $readiness.runtime_set_ready -cne $true -or
        $readiness.codex_initialize_model_list_ready -cne $true -or
        $readiness.oxigraph_handshake_ready -cne $true -or $readiness.api_ready -cne $true) {
        throw "Portable normal-core readiness receipt is incomplete or not $ExpectedBuildMode-mode."
    }
    $executableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant()
    if ([string]$readiness.product_build.executable_sha256 -cne $executableHash) {
        throw 'Portable readiness receipt is not bound to the launched executable.'
    }
    foreach ($profile in @('webview2\shell', 'webview2\internet')) {
        if (-not (Test-Path -LiteralPath (Join-Path $dataRoot $profile) -PathType Container)) {
            throw "Portable executable did not create isolated $profile profile."
        }
    }

    Stop-Process -Id $process.Id -Force
    $process.WaitForExit(5000) | Out-Null
    $process = $null
    $damagedActive = Join-Path $extractRoot 'runtime\active.json'
    $savedActive = $damagedActive + '.smoke-saved'
    Move-Item -LiteralPath $damagedActive -Destination $savedActive
    try {
        $damagedData = Join-Path $smokeRoot 'damaged-data'
        $damagedDescriptor = Join-Path $smokeRoot 'damaged-readiness.json'
        New-Item -ItemType Directory -Path $damagedData | Out-Null
        $damagedArguments = @(
            'release-eval-session', '--descriptor', ('"{0}"' -f $damagedDescriptor),
            '--data-root', ('"{0}"' -f $damagedData)
        )
        $process = Start-Process -FilePath $executable -ArgumentList $damagedArguments -PassThru -WindowStyle Hidden
        if (-not $process.WaitForExit(15000)) {
            throw 'Damaged runtime launch stayed alive instead of failing closed.'
        }
        if (Test-Path -LiteralPath $damagedDescriptor) {
            throw 'Setup-mode false positive published a normal-core readiness receipt.'
        }
        $process = $null
    } finally {
        Move-Item -LiteralPath $savedActive -Destination $damagedActive
    }
} finally {
    foreach ($name in $hostileVariables) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
    $packageProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
            $extractRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
    })
    foreach ($item in $packageProcesses) {
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $smokeRoot) {
        $resolvedSmoke = [IO.Path]::GetFullPath($smokeRoot)
        if (-not $resolvedSmoke.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove package smoke directory outside build: $resolvedSmoke"
        }
        Remove-Item -LiteralPath $resolvedSmoke -Recurse -Force
    }
}

Write-Host "Portable archive manifest readback, hostile-environment $ExpectedBuildMode-mode normal-core readiness, setup rejection, and cleanup passed."
