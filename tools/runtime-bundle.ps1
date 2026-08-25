[CmdletBinding()]
param(
    [string]$GoExecutable = '',
    [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifestPath = Join-Path $root 'runtime-manifest.json'
$runtimeRoot = Join-Path $root '.runtime'
$stagingRoot = Join-Path $root '.runtime-staging'
$cacheRoot = Join-Path $root '.runtime-cache'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-WorkspaceChild([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime build path escaped the AetherOps workspace: $absolute"
    }
    return $absolute
}

function Invoke-Checked([string]$Description, [scriptblock]$Action) {
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Invoke-BundleTool([string[]]$Arguments) {
    Invoke-Checked 'runtime bundle verifier' { & $GoExecutable run ./cmd/runtimebundle @Arguments }
}

function Get-PinnedDownload(
    [string]$RelativeCachePath,
    [string]$URL,
    [string]$ExpectedSHA256,
    [long]$MaxBytes
) {
    if (-not $URL.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Runtime acquisition URL is not HTTPS: $URL"
    }
    if ($ExpectedSHA256 -notmatch '^[0-9a-f]{64}$') {
        throw "Runtime acquisition hash is invalid for $RelativeCachePath"
    }
    $destination = Assert-WorkspaceChild (Join-Path $cacheRoot $RelativeCachePath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $existing = Get-Item -LiteralPath $destination
        $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
        if ($existing.Length -le $MaxBytes -and $existingHash -eq $ExpectedSHA256) {
            return $destination
        }
        throw "Cached acquisition failed its pinned receipt and was preserved for investigation: $destination"
    }

    $partial = Assert-WorkspaceChild ($destination + '.partial-' + [Guid]::NewGuid().ToString('N'))
    try {
        & curl.exe --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 --connect-timeout 30 $URL -o $partial
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $URL" }
        $download = Get-Item -LiteralPath $partial
        if ($download.Length -le 0 -or $download.Length -gt $MaxBytes) {
            throw "Downloaded payload size $($download.Length) is outside the reviewed limit for $RelativeCachePath"
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
        if ($actual -ne $ExpectedSHA256) {
            throw "Pinned SHA-256 mismatch for $RelativeCachePath`: $actual"
        }
        Move-Item -LiteralPath $partial -Destination $destination
    } catch {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        throw
    }
    return $destination
}

function Get-SafeArchivePath([string]$Name) {
    $normalized = $Name.Replace('\', '/')
    if ($normalized -eq '/' -or $normalized -eq '') { return '' }
    if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:' -or $normalized.IndexOf([char]0) -ge 0) {
        throw "Archive contains an absolute or invalid path: $Name"
    }
    $segments = $normalized.Split('/')
    foreach ($segment in $segments) {
        if ($segment -eq '') { continue }
        if ($segment -eq '.' -or $segment -eq '..' -or $segment -match '[:\x00-\x1f]' -or
            $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
            throw "Archive contains an ambiguous path segment: $Name"
        }
        $stem = ($segment -split '\.', 2)[0]
        if ($stem -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
            throw "Archive contains a reserved Windows device name: $Name"
        }
    }
    return ($segments | Where-Object { $_ -ne '' }) -join [IO.Path]::DirectorySeparatorChar
}

function Expand-SafeZip(
    [string]$ArchivePath,
    [string]$DestinationPath,
    [long]$MaxExtractBytes,
    [int]$MaxEntries
) {
    $destination = Assert-WorkspaceChild $DestinationPath
    if (Test-Path -LiteralPath $destination) {
        throw "Safe ZIP destination must not already exist: $destination"
    }
    New-Item -ItemType Directory -Path $destination | Out-Null
    $prefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt $MaxEntries) {
            throw "ZIP entry count $($archive.Entries.Count) is outside the reviewed limit"
        }
        foreach ($entry in $archive.Entries) {
            $relative = Get-SafeArchivePath $entry.FullName
            if ($relative -eq '') { continue }
            if (-not $seen.Add($relative)) { throw "ZIP repeats a case-insensitive path: $($entry.FullName)" }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xf000)
            if ($unixType -eq 0xa000) { throw "ZIP symbolic links are not permitted: $($entry.FullName)" }
            if ($entry.Length -lt 0 -or $entry.CompressedLength -lt 0) { throw 'ZIP reports a negative entry size' }
            if ($entry.Length -gt 1048576 -and $entry.CompressedLength -eq 0) {
                throw "ZIP entry has an invalid compression receipt: $($entry.FullName)"
            }
            if ($entry.CompressedLength -gt 0 -and ($entry.Length / $entry.CompressedLength) -gt 1000) {
                throw "ZIP entry exceeds the reviewed compression ratio: $($entry.FullName)"
            }
            $total += [long]$entry.Length
            if ($total -gt $MaxExtractBytes) { throw "ZIP expands beyond the reviewed $MaxExtractBytes byte limit" }

            $target = [IO.Path]::GetFullPath((Join-Path $destination $relative))
            if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "ZIP path escaped its staging directory: $($entry.FullName)"
            }
            $isDirectory = $entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')
            if ($isDirectory) {
                New-Item -ItemType Directory -Force -Path $target | Out-Null
                continue
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            $input = $entry.Open()
            $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 1048576
                $written = [long]0
                while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $read
                    if ($written -gt $entry.Length) { throw "ZIP expanded beyond its entry receipt: $($entry.FullName)" }
                    $output.Write($buffer, 0, $read)
                }
                if ($written -ne $entry.Length) { throw "ZIP entry length mismatch: $($entry.FullName)" }
                $output.Flush($true)
            } finally {
                $output.Dispose()
                $input.Dispose()
            }
        }
    } finally {
        $archive.Dispose()
    }
}

function Copy-TreeContents([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Expected extracted directory is missing: $Source" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Assert-PEMachine([string]$Path, [int]$ExpectedMachine) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5a4d) { throw "Not a PE executable: $Path" }
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset + 6 -gt $stream.Length) { throw "Invalid PE header offset: $Path" }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
        $machine = $reader.ReadUInt16()
        if ($machine -ne $ExpectedMachine) { throw ('Unexpected PE machine 0x{0:x4} for {1}' -f $machine, $Path) }
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-RedistributionEvidence([string]$RuntimePath) {
    $runtimeAbsolute = [IO.Path]::GetFullPath($RuntimePath)
    $runtimePrefix = $runtimeAbsolute.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $acquisitionPath = Join-Path $runtimeAbsolute 'source-acquisition.json'
    if (-not (Test-Path -LiteralPath $acquisitionPath -PathType Leaf)) {
        throw 'Redistribution acquisition manifest is missing.'
    }
    $evidence = Get-Content -Raw -LiteralPath $acquisitionPath | ConvertFrom-Json
    if ($evidence.schema -ne 1 -or @($evidence.acquisitions).Count -ne 35) {
        throw 'Redistribution acquisition manifest does not contain the reviewed 35-record set.'
    }
    $expectedKinds = @{ binary = 4; source = 4; 'source-submodule' = 22; license = 5 }
    foreach ($kind in $expectedKinds.Keys) {
        if (@($evidence.acquisitions | Where-Object kind -eq $kind).Count -ne $expectedKinds[$kind]) {
            throw "Redistribution acquisition manifest has an unexpected $kind record count."
        }
    }
    $packaged = @($evidence.acquisitions | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.packagedPath) })
    if ($packaged.Count -ne 31) { throw 'Redistribution acquisition manifest must map exactly 31 packaged license/source files.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $packaged) {
        $relative = Get-SafeArchivePath ([string]$record.packagedPath)
        if ([string]::IsNullOrWhiteSpace($relative) -or -not $seen.Add($relative)) {
            throw "Redistribution evidence repeats or omits a packaged path: $($record.packagedPath)"
        }
        $path = [IO.Path]::GetFullPath((Join-Path $runtimeAbsolute $relative))
        if (-not $path.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Redistribution evidence is missing: $($record.packagedPath)"
        }
        $file = Get-Item -LiteralPath $path
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
        if ($file.Length -ne [long]$record.bytes -or $hash -ne [string]$record.sha256) {
            throw "Redistribution evidence failed its size/SHA-256 receipt: $($record.packagedPath)"
        }
    }
}

function Get-RegistryMetadata([string]$Package, [string]$Version) {
    $encoded = [Uri]::EscapeDataString($Package).Replace('%40', '@').Replace('%2F', '%2f')
    $uri = "https://registry.npmjs.org/$encoded/$Version"
    $metadata = Invoke-RestMethod -Uri $uri
    if ($metadata.name -ne $Package -or $metadata.version -ne $Version) {
        throw "npm registry returned unexpected identity for $Package@$Version"
    }
    if ([string]::IsNullOrWhiteSpace([string]$metadata.dist.integrity)) {
        throw "npm registry did not provide SRI for $Package@$Version"
    }
    if (@($metadata.dist.signatures).Count -lt 1) {
        throw "npm registry did not provide a package signature for $Package@$Version"
    }
    return $metadata
}

function Write-NpmProject([string]$Path, [System.Collections.IDictionary]$Dependencies) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $project = [ordered]@{
        name = 'aetherops-managed-runtime'
        private = $true
        version = '0.0.0'
        dependencies = $Dependencies
    }
    $json = $project | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $Path 'package.json'), $json, [Text.UTF8Encoding]::new($false))
}

function Invoke-PinnedNpm([string]$WorkingDirectory, [string[]]$Arguments) {
    Push-Location $WorkingDirectory
    try {
        Invoke-Checked "npm $($Arguments -join ' ')" { & $script:NodeExecutable $script:NpmCLI @Arguments }
    } finally {
        Pop-Location
    }
}

function Assert-LockPackage([string]$LockPath, [string]$Key, [string]$Version, [string]$Integrity) {
    Invoke-Checked "validate package-lock entry $Key" { & $script:NodeExecutable $script:LockValidator $LockPath $Key $Version $Integrity }
}

if ([string]::IsNullOrWhiteSpace($GoExecutable)) {
    $GoExecutable = Join-Path $root '.tools\go1.26.5\bin\go.exe'
}
if (-not (Test-Path -LiteralPath $GoExecutable -PathType Leaf)) {
    throw "Pinned Go executable was not found: $GoExecutable"
}

$requiredBundleEvidence = @(
    'active.json',
    'verification-receipt.json',
    'source-acquisition.json',
    'licenses\openvsp\3.50.4\LICENSE.txt',
    'licenses\gmsh\4.14.1\LICENSE.txt',
    'licenses\xfoil\6.99\GPL-2.0.txt',
    'licenses\su2\8.5.0\LICENSE.md',
    'licenses\su2\8.5.0\COPYING.txt',
    'sources\openvsp\3.50.4\OpenVSP-OpenVSP_3.50.4.zip',
    'sources\gmsh\4.14.1\gmsh-4.14.1-source.tgz',
    'sources\xfoil\6.99\xfoil6.99.tgz',
    'sources\su2\8.5.0\SU2-12eb826f049ef7f67df974dfcb44cf36ee07c0f8.zip'
)
$hasBundleEvidence = -not ($requiredBundleEvidence | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $runtimeRoot $_) -PathType Leaf)
} | Select-Object -First 1)
if (-not $Refresh -and $hasBundleEvidence) {
    try {
        Invoke-BundleTool @('-mode', 'verify', '-root', $runtimeRoot, '-manifest', $manifestPath)
        Assert-RedistributionEvidence $runtimeRoot
        Write-Host 'Verified bundled runtime is already ready.'
        return
    } catch {
        Write-Warning "The existing bundled runtime is invalid and will be replaced: $($_.Exception.Message)"
    }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$nodeVersion = [string]$manifest.components.node.version
$codexVersion = [string]$manifest.components.codex.version
$mcpVersion = [string]$manifest.components.chromeDevtoolsMcp.version
$oxigraphVersion = [string]$manifest.components.oxigraph.version
$openVSPVersion = [string]$manifest.components.openVsp.version
$gmshVersion = [string]$manifest.components.gmsh.version
$xfoilVersion = [string]$manifest.components.xfoil.version
$su2Version = [string]$manifest.components.su2.version
if ($nodeVersion -ne '24.19.0' -or $codexVersion -ne '0.146.1' -or $mcpVersion -ne '1.6.0' -or $oxigraphVersion -ne '0.5.9' -or
    $openVSPVersion -ne '3.50.4' -or $gmshVersion -ne '4.14.1' -or
    $xfoilVersion -ne '6.99' -or $su2Version -ne '8.5.0') {
    throw 'runtime-manifest.json does not match the reviewed Windows x64 bundle recipe.'
}

$stagingRoot = Assert-WorkspaceChild $stagingRoot
$cacheRoot = Assert-WorkspaceChild $cacheRoot
if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagingRoot, $cacheRoot | Out-Null
$script:LockValidator = Join-Path $cacheRoot 'validate-package-lock.cjs'
$validatorSource = 'const fs=require("fs");const [p,k,v,i]=process.argv.slice(2);const e=JSON.parse(fs.readFileSync(p,"utf8")).packages[k];if(!e||e.version!==v||e.integrity!==i){console.error(`package-lock metadata mismatch for ${k}`);process.exit(1)}'
[IO.File]::WriteAllText($script:LockValidator, $validatorSource, [Text.UTF8Encoding]::new($false))

$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchive = Join-Path $cacheRoot $nodeArchiveName
$nodeSHASums = Join-Path $cacheRoot "node-v$nodeVersion-SHASUMS256.txt"
& curl.exe -fsSL "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -o $nodeSHASums
if ($LASTEXITCODE -ne 0) { throw 'Download official Node.js SHASUMS256.txt failed.' }
$sumLine = Get-Content -LiteralPath $nodeSHASums | Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))$" } | Select-Object -First 1
if (-not $sumLine) { throw "Official Node.js checksum list does not contain $nodeArchiveName" }
$nodeExpectedSHA256 = ($sumLine -split '\s+')[0].ToLowerInvariant()
if (-not (Test-Path -LiteralPath $nodeArchive -PathType Leaf) -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash.ToLowerInvariant() -ne $nodeExpectedSHA256) {
    & curl.exe -fsSL "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName" -o $nodeArchive
    if ($LASTEXITCODE -ne 0) { throw 'Download official Node.js Windows x64 archive failed.' }
}
$nodeActualSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodeArchive).Hash.ToLowerInvariant()
if ($nodeActualSHA256 -ne $nodeExpectedSHA256) {
    throw "Node.js archive SHA-256 mismatch: $nodeActualSHA256"
}

$nodeExtract = Join-Path $stagingRoot 'node-extract'
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
$nodeSource = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
$nodeVersionRoot = Join-Path $stagingRoot "versions\node\$nodeVersion"
New-Item -ItemType Directory -Force -Path $nodeVersionRoot | Out-Null
Copy-Item -Path (Join-Path $nodeSource '*') -Destination $nodeVersionRoot -Recurse
Remove-Item -LiteralPath $nodeExtract -Recurse -Force

$script:NodeExecutable = Join-Path $nodeVersionRoot 'node.exe'
$script:NpmCLI = Join-Path $nodeVersionRoot 'node_modules\npm\bin\npm-cli.js'
$nodeSignature = Get-AuthenticodeSignature -FilePath $script:NodeExecutable
if ($nodeSignature.Status.ToString() -ne 'Valid' -or
    $null -eq $nodeSignature.SignerCertificate -or
    $nodeSignature.SignerCertificate.Subject -notmatch 'OpenJS Foundation|Node\.js Foundation') {
    throw "Node.js Authenticode signature is not valid: $($nodeSignature.Status) $($nodeSignature.StatusMessage)"
}
$observedNodeVersion = (& $script:NodeExecutable --version).TrimStart('v')
if ($LASTEXITCODE -ne 0 -or $observedNodeVersion -ne $nodeVersion) {
    throw "Bundled Node.js reported unexpected version $observedNodeVersion"
}

$codexMetadata = Get-RegistryMetadata '@openai/codex' $codexVersion
$nativeCodexVersion = "$codexVersion-win32-x64"
$nativeCodexMetadata = Get-RegistryMetadata '@openai/codex' $nativeCodexVersion
$mcpMetadata = Get-RegistryMetadata 'chrome-devtools-mcp' $mcpVersion
$oxigraphMetadata = Get-RegistryMetadata 'oxigraph' $oxigraphVersion

$codexVersionRoot = Join-Path $stagingRoot "versions\codex\$codexVersion"
Write-NpmProject $codexVersionRoot ([ordered]@{ '@openai/codex' = $codexVersion })
Invoke-PinnedNpm $codexVersionRoot @('install', '--package-lock-only', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund')
Invoke-PinnedNpm $codexVersionRoot @('ci', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund')
Invoke-PinnedNpm $codexVersionRoot @('audit', 'signatures')
$codexLockPath = Join-Path $codexVersionRoot 'package-lock.json'
Assert-LockPackage $codexLockPath 'node_modules/@openai/codex' $codexVersion ([string]$codexMetadata.dist.integrity)
Assert-LockPackage $codexLockPath 'node_modules/@openai/codex-win32-x64' $nativeCodexVersion ([string]$nativeCodexMetadata.dist.integrity)
$installedCodex = Get-Content -Raw -LiteralPath (Join-Path $codexVersionRoot 'node_modules\@openai\codex\package.json') | ConvertFrom-Json
$installedNativeCodex = Get-Content -Raw -LiteralPath (Join-Path $codexVersionRoot 'node_modules\@openai\codex-win32-x64\package.json') | ConvertFrom-Json
if ($installedCodex.version -ne $codexVersion -or $installedNativeCodex.version -ne $nativeCodexVersion) {
    throw 'Installed Codex packages do not match the pinned compatibility set.'
}
$codexPayloadSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $codexLockPath).Hash.ToLowerInvariant()

$mcpVersionRoot = Join-Path $stagingRoot "versions\chrome-devtools-mcp\$mcpVersion"
Write-NpmProject $mcpVersionRoot ([ordered]@{ 'chrome-devtools-mcp' = $mcpVersion })
Invoke-PinnedNpm $mcpVersionRoot @('install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund')
Invoke-PinnedNpm $mcpVersionRoot @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
Invoke-PinnedNpm $mcpVersionRoot @('audit', 'signatures')
$mcpLockPath = Join-Path $mcpVersionRoot 'package-lock.json'
Assert-LockPackage $mcpLockPath 'node_modules/chrome-devtools-mcp' $mcpVersion ([string]$mcpMetadata.dist.integrity)
$installedMCP = Get-Content -Raw -LiteralPath (Join-Path $mcpVersionRoot 'node_modules\chrome-devtools-mcp\package.json') | ConvertFrom-Json
if ($installedMCP.version -ne $mcpVersion) { throw 'Installed Chrome DevTools MCP does not match the pinned version.' }
$mcpPayloadSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $mcpLockPath).Hash.ToLowerInvariant()

$oxigraphVersionRoot = Join-Path $stagingRoot "versions\oxigraph\$oxigraphVersion"
Write-NpmProject $oxigraphVersionRoot ([ordered]@{ 'oxigraph' = $oxigraphVersion })
Invoke-PinnedNpm $oxigraphVersionRoot @('install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund')
Invoke-PinnedNpm $oxigraphVersionRoot @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
Invoke-PinnedNpm $oxigraphVersionRoot @('audit', 'signatures')
$oxigraphLockPath = Join-Path $oxigraphVersionRoot 'package-lock.json'
Assert-LockPackage $oxigraphLockPath 'node_modules/oxigraph' $oxigraphVersion ([string]$oxigraphMetadata.dist.integrity)
$installedOxigraph = Get-Content -Raw -LiteralPath (Join-Path $oxigraphVersionRoot 'node_modules\oxigraph\package.json') | ConvertFrom-Json
if ($installedOxigraph.version -ne $oxigraphVersion) { throw 'Installed Oxigraph does not match the pinned version.' }
$oxigraphPayloadSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $oxigraphLockPath).Hash.ToLowerInvariant()
$oxigraphModuleDirectory = Join-Path $oxigraphVersionRoot 'node_modules\oxigraph'
$previousOxigraphModule = $env:AETHEROPS_OXIGRAPH_MODULE
try {
    $env:AETHEROPS_OXIGRAPH_MODULE = $oxigraphModuleDirectory
    Invoke-Checked 'knowledge sidecar compatibility tests against managed Oxigraph' {
        & $script:NodeExecutable --test --test-concurrency=1 (Join-Path $root 'tools\knowledge-sidecar\test\sidecar.test.cjs')
    }
} finally {
    if ($null -eq $previousOxigraphModule) {
        Remove-Item Env:AETHEROPS_OXIGRAPH_MODULE -ErrorAction SilentlyContinue
    } else {
        $env:AETHEROPS_OXIGRAPH_MODULE = $previousOxigraphModule
    }
}

$engineeringPackages = @(
    [pscustomobject]@{
        kind = 'binary'; component = 'openvsp'; version = $openVSPVersion
        file = 'OpenVSP-3.50.4-win64-Python3.13.zip'
        url = 'https://openvsp.org/zips/old/windows/OpenVSP-3.50.4-win64-Python3.13.zip'
        sha256 = 'bd8cf75fe19c15eb13f941b07c315e92e04584d6ee94308f7d466adf67f0bc7c'
        hashAuthority = 'vendored-acquisition-hash'; maxBytes = 157286400L; localPath = ''
    },
    [pscustomobject]@{
        kind = 'binary'; component = 'gmsh'; version = $gmshVersion
        file = 'gmsh-4.14.1-Windows64.zip'
        url = 'https://gmsh.info/bin/Windows/gmsh-4.14.1-Windows64.zip'
        sha256 = 'b3464b7e170f39639bc74b47334e7eab5cb44fa9317d16ff0c55b42bb04a1b80'
        hashAuthority = 'vendored-acquisition-hash'; maxBytes = 52428800L; localPath = ''
    },
    [pscustomobject]@{
        kind = 'binary'; component = 'xfoil'; version = $xfoilVersion
        file = 'XFOIL6.99.zip'
        url = 'https://web.mit.edu/drela/Public/web/xfoil/XFOIL6.99.zip'
        sha256 = 'e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08'
        hashAuthority = 'vendored-acquisition-hash'; maxBytes = 10485760L; localPath = ''
    },
    [pscustomobject]@{
        kind = 'binary'; component = 'su2'; version = $su2Version
        file = 'SU2-v8.5.0-win64-omp.zip'
        url = 'https://github.com/su2code/SU2/releases/download/v8.5.0/SU2-v8.5.0-win64-omp.zip'
        sha256 = '4466fe21aedb5e0bad57afd45f829acbdec6ec79fe8c3f8954ddea06a4b4bc11'
        hashAuthority = 'official-github-release-digest'; maxBytes = 41943040L; localPath = ''
    }
)
foreach ($package in $engineeringPackages) {
    $package.localPath = Get-PinnedDownload (Join-Path 'engineering' $package.file) $package.url $package.sha256 $package.maxBytes
}

$sourcePackages = @(
    [pscustomobject]@{ kind='source'; component='openvsp'; version='3.50.4'; file='OpenVSP-OpenVSP_3.50.4.zip'; destination='OpenVSP-OpenVSP_3.50.4.zip'; sourceTreePath='.'; url='https://github.com/OpenVSP/OpenVSP/archive/refs/tags/OpenVSP_3.50.4.zip'; sha256='20d191aac46bcc8369dbbe72baa9cdfd4ffe155083cdca8bdf726e508236288b'; hashAuthority='vendored-acquisition-hash'; maxBytes=262144000L; localPath='' },
    [pscustomobject]@{ kind='source'; component='gmsh'; version='4.14.1'; file='gmsh-4.14.1-source.tgz'; destination='gmsh-4.14.1-source.tgz'; sourceTreePath='.'; url='https://gmsh.info/src/gmsh-4.14.1-source.tgz'; sha256='300cbb74b6fb88062aba70b1f5f31a8980177a4af415221a16ec8c0aa1d72afd'; hashAuthority='vendored-acquisition-hash'; maxBytes=31457280L; localPath='' },
    [pscustomobject]@{ kind='source'; component='xfoil'; version='6.99'; file='xfoil6.99.tgz'; destination='xfoil6.99.tgz'; sourceTreePath='.'; url='https://web.mit.edu/drela/Public/web/xfoil/xfoil6.99.tgz'; sha256='5c0250643f52ce0e75d7338ae2504ce7907f2d49a30f921826717b8ac12ebe40'; hashAuthority='vendored-acquisition-hash'; maxBytes=10485760L; localPath='' },
    [pscustomobject]@{ kind='source'; component='su2'; version='8.5.0'; file='SU2-12eb826f049ef7f67df974dfcb44cf36ee07c0f8.zip'; destination='SU2-12eb826f049ef7f67df974dfcb44cf36ee07c0f8.zip'; sourceTreePath='.'; url='https://github.com/su2code/SU2/archive/12eb826f049ef7f67df974dfcb44cf36ee07c0f8.zip'; sha256='8c5318c925225453b03a0dd86451a93320fe90b9857f0abf70021d21b66e8e55'; hashAuthority='vendored-acquisition-hash'; maxBytes=31457280L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='FADO-ce7ee018e4e699af5028d69baa1939fea290e18a.zip'; destination='submodules\FADO-ce7ee018e4e699af5028d69baa1939fea290e18a.zip'; sourceTreePath='externals/FADO'; url='https://github.com/pcarruscag/FADO/archive/ce7ee018e4e699af5028d69baa1939fea290e18a.zip'; sha256='09a22bc4f04f57c09b956bba65436f346e254839d1db23ff9d7bd66b4cba9f7e'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='CoDiPack-a0725b2bfd172e741a07f96b041a5ddf88d441d7.zip'; destination='submodules\CoDiPack-a0725b2bfd172e741a07f96b041a5ddf88d441d7.zip'; sourceTreePath='externals/codi'; url='https://github.com/scicompkl/CoDiPack/archive/a0725b2bfd172e741a07f96b041a5ddf88d441d7.zip'; sha256='9c5712c09b87dd9bb2cb456695122b9bcbe5fe3b46aae35df2f7a08cf94fae31'; hashAuthority='vendored-acquisition-hash'; maxBytes=3145728L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='eigen-d71c30c47858effcbd39967097a2d99ee48db464.zip'; destination='submodules\eigen-d71c30c47858effcbd39967097a2d99ee48db464.zip'; sourceTreePath='externals/eigen'; url='https://gitlab.com/libeigen/eigen/-/archive/d71c30c47858effcbd39967097a2d99ee48db464/eigen-d71c30c47858effcbd39967097a2d99ee48db464.zip'; sha256='d42e8453beab5c8d7b8bdc32ba7452604f711f64b53b0a11991ee13ea08dc918'; hashAuthority='vendored-acquisition-hash'; maxBytes=8388608L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='MeDiPack-0cfaf96e7a31a5a8941b97f84198da03a8f8bd7a.zip'; destination='submodules\MeDiPack-0cfaf96e7a31a5a8941b97f84198da03a8f8bd7a.zip'; sourceTreePath='externals/medi'; url='https://github.com/SciCompKL/MeDiPack/archive/0cfaf96e7a31a5a8941b97f84198da03a8f8bd7a.zip'; sha256='cad3dde0513dcda3ec065bb8a2d3ac2c058db610be91dc0ccb172352899b6270'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='MEL-46205ab019e5224559091375a6d71aabae6bc5b9.zip'; destination='submodules\MEL-46205ab019e5224559091375a6d71aabae6bc5b9.zip'; sourceTreePath='externals/mel'; url='https://github.com/pcarruscag/MEL/archive/46205ab019e5224559091375a6d71aabae6bc5b9.zip'; sha256='03c2b721d8d2d0aff26d02bee6a92619f2aaf60708c5fafd0268bb6fde1dd100'; hashAuthority='vendored-acquisition-hash'; maxBytes=1048576L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='meson-5a82ea0501736a666ca9cc003ea0774f8219fd65.zip'; destination='submodules\meson-5a82ea0501736a666ca9cc003ea0774f8219fd65.zip'; sourceTreePath='externals/meson'; url='https://github.com/mesonbuild/meson/archive/5a82ea0501736a666ca9cc003ea0774f8219fd65.zip'; sha256='4e2b6d43a766cc7f8ea2922339b358f9f325cc8e3dd406debb16a83382e9b532'; hashAuthority='vendored-acquisition-hash'; maxBytes=10485760L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='ninja-b4d51f6ed5bed09dd2b70324df0d9cb4ecad2638.zip'; destination='submodules\ninja-b4d51f6ed5bed09dd2b70324df0d9cb4ecad2638.zip'; sourceTreePath='externals/ninja'; url='https://github.com/ninja-build/ninja/archive/b4d51f6ed5bed09dd2b70324df0d9cb4ecad2638.zip'; sha256='cdcfc8bad77154a55018918e45ef579b81a9c4a83e383189d0a17c166fcc5dc3'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='OpDiLib-294807b0111ce241cda97db62f80cdd5012d9381.zip'; destination='submodules\OpDiLib-294807b0111ce241cda97db62f80cdd5012d9381.zip'; sourceTreePath='externals/opdi'; url='https://github.com/SciCompKL/OpDiLib/archive/294807b0111ce241cda97db62f80cdd5012d9381.zip'; sha256='2caa8504d9b89ea6aacb3919f3ffd3383f4067e62e68a75d9bafce7d849f3d12'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='CoolProp-98b3523d5daa98454618d381d2ae53f7471d216b.zip'; destination='submodules\CoolProp-98b3523d5daa98454618d381d2ae53f7471d216b.zip'; sourceTreePath='subprojects/CoolProp'; url='https://github.com/CoolProp/CoolProp/archive/98b3523d5daa98454618d381d2ae53f7471d216b.zip'; sha256='af6caceeaab5f7ed209f9ec3ecac42b0fbc55a6a76f0ead17dc62b00a0a8e4c9'; hashAuthority='vendored-acquisition-hash'; maxBytes=20971520L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='MLPCpp-e23facf388902f262fbe7ba3bcc84d36c85350b9.zip'; destination='submodules\MLPCpp-e23facf388902f262fbe7ba3bcc84d36c85350b9.zip'; sourceTreePath='subprojects/MLPCpp'; url='https://github.com/EvertBunschoten/MLPCpp/archive/e23facf388902f262fbe7ba3bcc84d36c85350b9.zip'; sha256='1fd9060267071c1800b22ee2bcce61009b8e367054d6cbf423f491e373d0183e'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='Mutationpp-5ff579f43781cae07411e5ab46291c9971536be6.zip'; destination='submodules\Mutationpp-5ff579f43781cae07411e5ab46291c9971536be6.zip'; sourceTreePath='subprojects/Mutationpp'; url='https://github.com/mutationpp/Mutationpp/archive/5ff579f43781cae07411e5ab46291c9971536be6.zip'; sha256='fdb83874427ddb92a981fd08dd124a0037feedb5bf711f4c24904de15b078d2e'; hashAuthority='vendored-acquisition-hash'; maxBytes=10485760L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='Catch2-914aeecfe23b1e16af6ea675a4fb5dbd5a5b8d0a.zip'; destination='submodules\coolprop\Catch2-914aeecfe23b1e16af6ea675a4fb5dbd5a5b8d0a.zip'; sourceTreePath='subprojects/CoolProp/externals/Catch2'; url='https://github.com/catchorg/Catch2/archive/914aeecfe23b1e16af6ea675a4fb5dbd5a5b8d0a.zip'; sha256='a369f74748e319598392a90009f8fb5146f26cd2bf5bed60909a1a1925b6c1d6'; hashAuthority='vendored-acquisition-hash'; maxBytes=3145728L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='Eigen-68f4e58cfacc686583d16cff90361f0b43bc2c1b.zip'; destination='submodules\coolprop\Eigen-68f4e58cfacc686583d16cff90361f0b43bc2c1b.zip'; sourceTreePath='subprojects/CoolProp/externals/Eigen'; url='https://gitlab.com/libeigen/eigen/-/archive/68f4e58cfacc686583d16cff90361f0b43bc2c1b/eigen-68f4e58cfacc686583d16cff90361f0b43bc2c1b.zip'; sha256='41d12f1fc8e18606f39312681c6e1b957a4746ed97676c576e23e73554c6a662'; hashAuthority='vendored-acquisition-hash'; maxBytes=8388608L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='ExcelAddinInstaller-db8ce41cdb02079a2d9242ea08f3633e8a1d38b0.zip'; destination='submodules\coolprop\ExcelAddinInstaller-db8ce41cdb02079a2d9242ea08f3633e8a1d38b0.zip'; sourceTreePath='subprojects/CoolProp/externals/ExcelAddinInstaller'; url='https://github.com/CoolProp/ExcelAddinInstaller/archive/db8ce41cdb02079a2d9242ea08f3633e8a1d38b0.zip'; sha256='b206785152e6f235f92587a7fe9d3ad249a2d6c5b51a37f52422144b0d4e8128'; hashAuthority='vendored-acquisition-hash'; maxBytes=1048576L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='FindMathematica-99d8c95eed1a517f4a06511ea40b2cee6477a8c1.zip'; destination='submodules\coolprop\FindMathematica-99d8c95eed1a517f4a06511ea40b2cee6477a8c1.zip'; sourceTreePath='subprojects/CoolProp/externals/FindMathematica'; url='https://github.com/sakra/FindMathematica/archive/99d8c95eed1a517f4a06511ea40b2cee6477a8c1.zip'; sha256='9135db6454f0a152339d636c763dd8a504995379ec3e05ebb1e5e7660143f318'; hashAuthority='vendored-acquisition-hash'; maxBytes=1048576L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='IF97-7aaced024a702f0985474bf293cdaae9c8d06521.zip'; destination='submodules\coolprop\IF97-7aaced024a702f0985474bf293cdaae9c8d06521.zip'; sourceTreePath='subprojects/CoolProp/externals/IF97'; url='https://github.com/CoolProp/IF97/archive/7aaced024a702f0985474bf293cdaae9c8d06521.zip'; sha256='5d395508a3d409eb8ca9d83e1794e4132cd7b9ccd138a41691d531f8b4b6a91e'; hashAuthority='vendored-acquisition-hash'; maxBytes=8388608L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='REFPROP-headers-b4faab1b73911c32c4b69c526c7e92f74edb67de.zip'; destination='submodules\coolprop\REFPROP-headers-b4faab1b73911c32c4b69c526c7e92f74edb67de.zip'; sourceTreePath='subprojects/CoolProp/externals/REFPROP-headers'; url='https://github.com/CoolProp/REFPROP-headers/archive/b4faab1b73911c32c4b69c526c7e92f74edb67de.zip'; sha256='a98351b3618e0f9f5dc95da219feaf55d029b5f5b961fdfb8262ad3e7e6e89a7'; hashAuthority='vendored-acquisition-hash'; maxBytes=1048576L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='fmt-e424e3f2e607da02742f73db84873b8084fc714c.zip'; destination='submodules\coolprop\fmt-e424e3f2e607da02742f73db84873b8084fc714c.zip'; sourceTreePath='subprojects/CoolProp/externals/fmtlib'; url='https://github.com/fmtlib/fmt/archive/e424e3f2e607da02742f73db84873b8084fc714c.zip'; sha256='48b63758c3b1b8fb2977dafdc5064e680c450b8704e4ee0b645acf865975882a'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='msgpack-c-919908742b4fdbc575e77fe1a8657e70c9573c44.zip'; destination='submodules\coolprop\msgpack-c-919908742b4fdbc575e77fe1a8657e70c9573c44.zip'; sourceTreePath='subprojects/CoolProp/externals/msgpack-c'; url='https://github.com/msgpack/msgpack-c/archive/919908742b4fdbc575e77fe1a8657e70c9573c44.zip'; sha256='fe964beacfa15f43bb721de855f3ca96e4ecaafaa516c483524e913b3dccbdcb'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='multicomplex-39bf9ca52c7882ff0788bb9087c7548ebd8fba4c.zip'; destination='submodules\coolprop\multicomplex-39bf9ca52c7882ff0788bb9087c7548ebd8fba4c.zip'; sourceTreePath='subprojects/CoolProp/externals/multicomplex'; url='https://github.com/usnistgov/multicomplex/archive/39bf9ca52c7882ff0788bb9087c7548ebd8fba4c.zip'; sha256='469010debdcc9f2060cf41ff0555f73d79a4c30c124c07f2ebf4272a529f3a29'; hashAuthority='vendored-acquisition-hash'; maxBytes=1048576L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='pybind11-76b7f53649580b66b559752de6a39d98477ff1da.zip'; destination='submodules\coolprop\pybind11-76b7f53649580b66b559752de6a39d98477ff1da.zip'; sourceTreePath='subprojects/CoolProp/externals/pybind11'; url='https://github.com/pybind/pybind11/archive/76b7f53649580b66b559752de6a39d98477ff1da.zip'; sha256='5926a5b325a7b2bf040665c37e26af272186d1717476349451728cddcc6b1518'; hashAuthority='vendored-acquisition-hash'; maxBytes=2097152L; localPath='' },
    [pscustomobject]@{ kind='source-submodule'; component='su2'; version='8.5.0'; file='rapidjson-24b5e7a8b27f42fa16b96fc70aade9106cf7102f.zip'; destination='submodules\coolprop\rapidjson-24b5e7a8b27f42fa16b96fc70aade9106cf7102f.zip'; sourceTreePath='subprojects/CoolProp/externals/rapidjson'; url='https://github.com/Tencent/rapidjson/archive/24b5e7a8b27f42fa16b96fc70aade9106cf7102f.zip'; sha256='df07f5ddfebbc2940181039f6c939ec2764a7303ef79b17958d9792a364306bb'; hashAuthority='vendored-acquisition-hash'; maxBytes=3145728L; localPath='' }
)
foreach ($source in $sourcePackages) {
    $cacheRelative = if ($source.destination.StartsWith('submodules\coolprop\')) {
        Join-Path 'engineering\sources\su2-submodules\coolprop-submodules' $source.file
    } elseif ($source.destination.StartsWith('submodules\')) {
        Join-Path 'engineering\sources\su2-submodules' $source.file
    } else {
        Join-Path 'engineering\sources' $source.file
    }
    $source.localPath = Get-PinnedDownload $cacheRelative $source.url $source.sha256 $source.maxBytes
}

$licensePackages = @(
    [pscustomobject]@{ kind='license'; component='xfoil'; version='6.99'; file='XFOIL-GPL-2.0.txt'; destination='GPL-2.0.txt'; url='https://web.mit.edu/drela/Public/web/gpl.txt'; sha256='e6d6a009505e345fe949e1310334fcb0747f28dae2856759de102ab66b722cb4'; hashAuthority='vendored-acquisition-hash'; maxBytes=65536L; localPath='' },
    [pscustomobject]@{ kind='license'; component='su2'; version='8.5.0'; file='SU2-LICENSE.md'; destination='LICENSE.md'; url='https://raw.githubusercontent.com/su2code/SU2/v8.5.0/LICENSE.md'; sha256='46ae25afd571da3e3761ff82ace5dc26b0b66cf514243379ac026ce094ba32cf'; hashAuthority='vendored-acquisition-hash'; maxBytes=65536L; localPath='' },
    [pscustomobject]@{ kind='license'; component='su2'; version='8.5.0'; file='SU2-COPYING.txt'; destination='COPYING.txt'; url='https://raw.githubusercontent.com/su2code/SU2/v8.5.0/COPYING'; sha256='b3aa400aca6d2ba1f0bd03bd98d03d1fe7489a3bbb26969d72016360af8a5c9d'; hashAuthority='vendored-acquisition-hash'; maxBytes=65536L; localPath='' }
)
foreach ($license in $licensePackages) {
    $license.localPath = Get-PinnedDownload (Join-Path 'engineering\licenses' $license.file) $license.url $license.sha256 $license.maxBytes
}

$extractRoot = Join-Path $stagingRoot 'engineering-extract'
$openVSPExtract = Join-Path $extractRoot 'openvsp'
$gmshExtract = Join-Path $extractRoot 'gmsh'
$xfoilExtract = Join-Path $extractRoot 'xfoil'
$su2OuterExtract = Join-Path $extractRoot 'su2-outer'
$su2InnerExtract = Join-Path $extractRoot 'su2-inner'
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
$openVSPPackage = $engineeringPackages | Where-Object component -eq 'openvsp'
$gmshPackage = $engineeringPackages | Where-Object component -eq 'gmsh'
$xfoilPackage = $engineeringPackages | Where-Object component -eq 'xfoil'
$su2Package = $engineeringPackages | Where-Object component -eq 'su2'
Expand-SafeZip $openVSPPackage.localPath $openVSPExtract 314572800L 2000
Expand-SafeZip $gmshPackage.localPath $gmshExtract 157286400L 2000
Expand-SafeZip $xfoilPackage.localPath $xfoilExtract 16777216L 100
Expand-SafeZip $su2Package.localPath $su2OuterExtract 41943040L 10

$openVSPVersionRoot = Join-Path $stagingRoot "versions\openvsp\$openVSPVersion"
$gmshVersionRoot = Join-Path $stagingRoot "versions\gmsh\$gmshVersion"
$xfoilVersionRoot = Join-Path $stagingRoot "versions\xfoil\$xfoilVersion"
$su2VersionRoot = Join-Path $stagingRoot "versions\su2\$su2Version"
Copy-TreeContents (Join-Path $openVSPExtract 'OpenVSP-3.50.4-win64') $openVSPVersionRoot
Copy-TreeContents (Join-Path $gmshExtract 'gmsh-4.14.1-Windows64') $gmshVersionRoot
Copy-TreeContents $xfoilExtract $xfoilVersionRoot

$su2InnerArchive = Join-Path $su2OuterExtract 'win64-omp.zip'
if ((Get-ChildItem -LiteralPath $su2OuterExtract -Force).Count -ne 1 -or -not (Test-Path -LiteralPath $su2InnerArchive -PathType Leaf)) {
    throw 'SU2 outer archive does not contain exactly the reviewed win64-omp.zip payload.'
}
$su2InnerSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $su2InnerArchive).Hash.ToLowerInvariant()
if ($su2InnerSHA256 -ne '48e8a1c1cd5db8f545612c6e86cc2a386487a02b1c35b6ac4de491b0c67e1e59') {
    throw "SU2 nested archive SHA-256 mismatch: $su2InnerSHA256"
}
Expand-SafeZip $su2InnerArchive $su2InnerExtract 157286400L 1000
if ((Get-ChildItem -LiteralPath $su2InnerExtract -Force).Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $su2InnerExtract 'bin') -PathType Container)) {
    throw 'SU2 nested archive does not contain exactly the reviewed bin tree.'
}
Copy-TreeContents (Join-Path $su2InnerExtract 'bin') $su2VersionRoot

foreach ($path in @(
    (Join-Path $openVSPVersionRoot 'vspscript.exe'),
    (Join-Path $openVSPVersionRoot 'vspaero.exe'),
    (Join-Path $openVSPVersionRoot 'vspaero_opt.exe'),
    (Join-Path $gmshVersionRoot 'gmsh.exe'),
    (Join-Path $su2VersionRoot 'SU2_CFD.exe'),
    (Join-Path $su2VersionRoot 'SU2_SOL.exe')
)) { Assert-PEMachine $path 0x8664 }
Assert-PEMachine (Join-Path $xfoilVersionRoot 'xfoil.exe') 0x014c

$licenseRoot = Join-Path $stagingRoot 'licenses'
$sourceRoot = Join-Path $stagingRoot 'sources'
New-Item -ItemType Directory -Force -Path $licenseRoot, $sourceRoot | Out-Null
$openVSPLicenseDirectory = Join-Path $licenseRoot "openvsp\$openVSPVersion"
$gmshLicenseDirectory = Join-Path $licenseRoot "gmsh\$gmshVersion"
New-Item -ItemType Directory -Force -Path $openVSPLicenseDirectory, $gmshLicenseDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $openVSPVersionRoot 'LICENSE') -Destination (Join-Path $openVSPLicenseDirectory 'LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $gmshVersionRoot 'LICENSE.txt') -Destination (Join-Path $gmshLicenseDirectory 'LICENSE.txt')
foreach ($license in $licensePackages) {
    $destinationDirectory = Join-Path $licenseRoot "$($license.component)\$($license.version)"
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $license.localPath -Destination (Join-Path $destinationDirectory $license.destination)
}
foreach ($source in $sourcePackages) {
    $destinationPath = Join-Path (Join-Path $sourceRoot "$($source.component)\$($source.version)") $source.destination
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
    Copy-Item -LiteralPath $source.localPath -Destination $destinationPath
}

$acquisitions = @()
foreach ($item in @($engineeringPackages) + @($sourcePackages) + @($licensePackages)) {
    $record = [ordered]@{
        kind = $item.kind
        component = $item.component
        version = $item.version
        url = $item.url
        file = $item.file
        sha256 = $item.sha256
        hashAuthority = $item.hashAuthority
        bytes = (Get-Item -LiteralPath $item.localPath).Length
    }
    if ($item.PSObject.Properties.Name -contains 'sourceTreePath') { $record.sourceTreePath = $item.sourceTreePath }
    if ($item.kind -eq 'source' -or $item.kind -eq 'source-submodule') {
        $record.packagedPath = ('sources/{0}/{1}/{2}' -f $item.component, $item.version, $item.destination.Replace('\', '/'))
    } elseif ($item.kind -eq 'license') {
        $record.packagedPath = ('licenses/{0}/{1}/{2}' -f $item.component, $item.version, $item.destination.Replace('\', '/'))
    }
    $acquisitions += $record
}
$acquisitions += [ordered]@{
    kind='license'; component='openvsp'; version=$openVSPVersion
    url=$openVSPPackage.url + '#OpenVSP-3.50.4-win64/LICENSE'; file='LICENSE.txt'
    sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $openVSPLicenseDirectory 'LICENSE.txt')).Hash.ToLowerInvariant()
    hashAuthority='covered-by-verified-parent-archive'; bytes=(Get-Item -LiteralPath (Join-Path $openVSPLicenseDirectory 'LICENSE.txt')).Length
    packagedPath='licenses/openvsp/3.50.4/LICENSE.txt'
}
$acquisitions += [ordered]@{
    kind='license'; component='gmsh'; version=$gmshVersion
    url=$gmshPackage.url + '#gmsh-4.14.1-Windows64/LICENSE.txt'; file='LICENSE.txt'
    sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $gmshLicenseDirectory 'LICENSE.txt')).Hash.ToLowerInvariant()
    hashAuthority='covered-by-verified-parent-archive'; bytes=(Get-Item -LiteralPath (Join-Path $gmshLicenseDirectory 'LICENSE.txt')).Length
    packagedPath='licenses/gmsh/4.14.1/LICENSE.txt'
}
$sourceManifest = [ordered]@{
    schema = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    policy = 'Exact HTTPS acquisitions are hash-pinned. OpenVSP, Gmsh, and XFOIL upstreams publish no detached digest for these binaries; their SHA-256 values are reviewed vendored acquisition hashes. SU2 uses the official GitHub release digest.'
    sourcePins = [ordered]@{
        openvspCommit = 'e10ca9651d9fa349f08f0fdbe26ef805080e1aec'
        su2Commit = '12eb826f049ef7f67df974dfcb44cf36ee07c0f8'
        su2Build = '-Dcpu-arch=haswell -Dwith-omp=true -Dwith-mpi=disabled --cross-file=/hostfiles/hostfile_windows'
    }
    acquisitions = $acquisitions
}
[IO.File]::WriteAllText((Join-Path $stagingRoot 'source-acquisition.json'), ($sourceManifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Assert-RedistributionEvidence $stagingRoot
Remove-Item -LiteralPath $extractRoot -Recurse -Force

Invoke-BundleTool @(
    '-mode', 'seal',
    '-root', $stagingRoot,
    '-manifest', $manifestPath,
    '-candidate', 'bundled-v0.1.0-alpha.1',
    '-node-payload-sha256', $nodeActualSHA256,
    '-codex-payload-sha256', $codexPayloadSHA256,
    '-mcp-payload-sha256', $mcpPayloadSHA256,
    '-oxigraph-payload-sha256', $oxigraphPayloadSHA256,
    '-openvsp-payload-sha256', $openVSPPackage.sha256,
    '-gmsh-payload-sha256', $gmshPackage.sha256,
    '-xfoil-payload-sha256', $xfoilPackage.sha256,
    '-su2-payload-sha256', $su2Package.sha256
)

$receipt = [ordered]@{
    schema = 1
    verifiedAt = [DateTime]::UtcNow.ToString('o')
    platform = 'windows-x64'
    node = [ordered]@{
        version = $nodeVersion
        archive = $nodeArchiveName
        sha256 = $nodeActualSHA256
        signer = $nodeSignature.SignerCertificate.Subject
        thumbprint = $nodeSignature.SignerCertificate.Thumbprint
    }
    codex = [ordered]@{
        version = $codexVersion
        integrity = [string]$codexMetadata.dist.integrity
        nativeVersion = $nativeCodexVersion
        nativeIntegrity = [string]$nativeCodexMetadata.dist.integrity
        npmSignaturesVerified = $true
    }
    chromeDevtoolsMcp = [ordered]@{
        version = $mcpVersion
        integrity = [string]$mcpMetadata.dist.integrity
        npmSignaturesVerified = $true
    }
    oxigraph = [ordered]@{
        version = $oxigraphVersion
        integrity = [string]$oxigraphMetadata.dist.integrity
        npmSignaturesVerified = $true
        sidecarCompatibilityProbe = 'passed'
    }
    engineeringTools = [ordered]@{
        openvsp = [ordered]@{
            version = $openVSPVersion
            archive = $openVSPPackage.file
            sha256 = $openVSPPackage.sha256
            hashAuthority = $openVSPPackage.hashAuthority
            peMachine = 'x64'
        }
        gmsh = [ordered]@{
            version = $gmshVersion
            archive = $gmshPackage.file
            sha256 = $gmshPackage.sha256
            hashAuthority = $gmshPackage.hashAuthority
            peMachine = 'x64'
        }
        xfoil = [ordered]@{
            version = $xfoilVersion
            archive = $xfoilPackage.file
            sha256 = $xfoilPackage.sha256
            hashAuthority = $xfoilPackage.hashAuthority
            peMachine = 'x86-on-windows-x64'
        }
        su2 = [ordered]@{
            version = $su2Version
            archive = $su2Package.file
            sha256 = $su2Package.sha256
            hashAuthority = $su2Package.hashAuthority
            nestedArchiveSHA256 = $su2InnerSHA256
            peMachine = 'x64'
            parallelRuntime = 'OpenMP'
            mpi = $false
            cpuTarget = 'haswell'
        }
    }
    redistribution = [ordered]@{
        acquisitionManifest = 'source-acquisition.json'
        acquisitionManifestSHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $stagingRoot 'source-acquisition.json')).Hash.ToLowerInvariant()
        licenses = 'licenses'
        correspondingSources = 'sources'
        verifiedPackagedFiles = 31
    }
}
[IO.File]::WriteAllText((Join-Path $stagingRoot 'verification-receipt.json'), ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Invoke-BundleTool @('-mode', 'verify', '-root', $stagingRoot, '-manifest', $manifestPath)

if (Test-Path -LiteralPath $runtimeRoot) {
    $previous = Assert-WorkspaceChild (Join-Path $root ('.runtime.previous-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')))
    Move-Item -LiteralPath $runtimeRoot -Destination $previous
    Write-Warning "Previous runtime was preserved at $previous"
}
Move-Item -LiteralPath $stagingRoot -Destination $runtimeRoot
Invoke-BundleTool @('-mode', 'verify', '-root', $runtimeRoot, '-manifest', $manifestPath)
Assert-RedistributionEvidence $runtimeRoot
Write-Host "Bundled runtime is ready at $runtimeRoot"
