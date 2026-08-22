function ConvertTo-AetherOpsLowerHex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    return ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-AetherOpsBytesSHA256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ConvertTo-AetherOpsLowerHex ($algorithm.ComputeHash($Bytes))
    } finally {
        $algorithm.Dispose()
    }
}

function Get-AetherOpsRegularFileSHA256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Package identity input is missing: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Package identity input must not be a reparse point: $Path"
    }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash.ToLowerInvariant()
}

function Assert-AetherOpsStagingHasNoReparsePoints {
    param([Parameter(Mandatory = $true)][string]$StagingRoot)
    $root = [IO.Path]::GetFullPath($StagingRoot)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Portable staging root is missing: $root"
    }
    foreach ($item in @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Recurse -Force -Directory)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Portable staging must not contain a reparse-point directory: $($item.FullName)"
        }
    }
}

function Get-AetherOpsKnowledgeSidecarTreeSHA256 {
    param([Parameter(Mandatory = $true)][string]$Directory)
    $names = @('index.cjs', 'protocol.cjs', 'worker.cjs')
    $stream = [IO.MemoryStream]::new()
    try {
        $domain = [Text.Encoding]::UTF8.GetBytes("aetherops-knowledge-sidecar-tree-v1`0")
        $stream.Write($domain, 0, $domain.Length)
        foreach ($name in $names) {
            $path = Join-Path $Directory $name
            $null = Get-AetherOpsRegularFileSHA256 -Path $path
            $item = Get-Item -LiteralPath $path -Force
            $nameBytes = [Text.Encoding]::UTF8.GetBytes($name)
            [byte[]]$nameLength = [BitConverter]::GetBytes([uint32]$nameBytes.Length)
            [byte[]]$fileLength = [BitConverter]::GetBytes([uint64]$item.Length)
            if ([BitConverter]::IsLittleEndian) {
                [Array]::Reverse($nameLength)
                [Array]::Reverse($fileLength)
            }
            $stream.Write($nameLength, 0, $nameLength.Length)
            $stream.Write($nameBytes, 0, $nameBytes.Length)
            $stream.Write($fileLength, 0, $fileLength.Length)
            $bytes = [IO.File]::ReadAllBytes($item.FullName)
            if ($bytes.Length -ne $item.Length) {
                throw "Knowledge sidecar changed while reading: $name"
            }
            $stream.Write($bytes, 0, $bytes.Length)
        }
        return Get-AetherOpsBytesSHA256 -Bytes $stream.ToArray()
    } finally {
        $stream.Dispose()
    }
}

function Get-AetherOpsProductIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$RuntimeManifest,
        [Parameter(Mandatory = $true)][string]$KnowledgeSidecarDirectory
    )
    return [pscustomobject]@{
        ExecutableSHA256 = Get-AetherOpsRegularFileSHA256 -Path $Executable
        RuntimeManifestSHA256 = Get-AetherOpsRegularFileSHA256 -Path $RuntimeManifest
        KnowledgeSidecarTreeSHA256 = Get-AetherOpsKnowledgeSidecarTreeSHA256 -Directory $KnowledgeSidecarDirectory
    }
}

function Assert-AetherOpsProductIdentityEqual {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual,
        [string]$Context = 'package candidate'
    )
    foreach ($name in @('ExecutableSHA256', 'RuntimeManifestSHA256', 'KnowledgeSidecarTreeSHA256')) {
        if ([string]$Expected.$name -cne [string]$Actual.$name) {
            throw "$Context identity changed: $name"
        }
    }
}

function ConvertTo-AetherOpsSafePackageRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $rootAbsolute = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $prefix = $rootAbsolute + [IO.Path]::DirectorySeparatorChar
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Package content escaped staging: $absolute"
    }
    $relative = $absolute.Substring($prefix.Length).Replace('/', '\')
    if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or
        $relative -match '[:\x00-\x1f]' -or $relative.Split('\') -contains '..' -or
        $relative.Split('\') -contains '.') {
        throw "Unsafe package relative path: $relative"
    }
    return $relative
}

function Read-AetherOpsPackageManifestLines {
    param([Parameter(Mandatory = $true)][string[]]$Lines)
    $entries = @{}
    foreach ($line in $Lines) {
        if ($line -cnotmatch '^([0-9a-f]{64})  (.+)$') {
            throw "Malformed package content manifest line: $line"
        }
        $relative = [string]$Matches[2]
        if ([IO.Path]::IsPathRooted($relative) -or $relative -match '[:\x00-\x1f]' -or
            $relative.Split('\') -contains '..' -or $relative.Split('\') -contains '.' -or
            $entries.ContainsKey($relative)) {
            throw "Unsafe or duplicate package manifest path: $relative"
        }
        $entries[$relative] = [string]$Matches[1]
    }
    if ($entries.Count -eq 0) {
        throw 'Package content manifest is empty.'
    }
    return $entries
}

function Write-AetherOpsPortableContentManifest {
    param([Parameter(Mandatory = $true)][string]$StagingRoot)
    $root = [IO.Path]::GetFullPath($StagingRoot)
    Assert-AetherOpsStagingHasNoReparsePoints -StagingRoot $root
    $manifest = Join-Path $root 'PACKAGE-CONTENTS.sha256'
    if (Test-Path -LiteralPath $manifest) {
        throw 'Portable content manifest already exists.'
    }
    $rows = @(Get-ChildItem -LiteralPath $root -Recurse -Force -File | ForEach-Object {
        if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Portable staging contains a reparse-point file: $($_.FullName)"
        }
        [pscustomobject]@{
            Relative = ConvertTo-AetherOpsSafePackageRelativePath -Root $root -Path $_.FullName
            SHA256 = Get-AetherOpsRegularFileSHA256 -Path $_.FullName
        }
    } | Sort-Object Relative)
    if ($rows.Count -eq 0) {
        throw 'Portable staging contains no files.'
    }
    [IO.File]::WriteAllLines(
        $manifest,
        @($rows | ForEach-Object { "$($_.SHA256)  $($_.Relative)" }),
        [Text.UTF8Encoding]::new($false)
    )
}

function Get-AetherOpsPortableSnapshot {
    param([Parameter(Mandatory = $true)][string]$StagingRoot)
    $root = [IO.Path]::GetFullPath($StagingRoot)
    Assert-AetherOpsStagingHasNoReparsePoints -StagingRoot $root
    $manifest = Join-Path $root 'PACKAGE-CONTENTS.sha256'
    $manifestSHA256 = Get-AetherOpsRegularFileSHA256 -Path $manifest
    $entries = Read-AetherOpsPackageManifestLines -Lines @(Get-Content -LiteralPath $manifest)
    $remaining = @{}
    foreach ($key in $entries.Keys) { $remaining[$key] = $entries[$key] }
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -Force -File) {
        $relative = ConvertTo-AetherOpsSafePackageRelativePath -Root $root -Path $file.FullName
        if ($relative -ceq 'PACKAGE-CONTENTS.sha256') { continue }
        if (-not $remaining.ContainsKey($relative)) {
            throw "Portable staging contains an unmanifested file: $relative"
        }
        $actual = Get-AetherOpsRegularFileSHA256 -Path $file.FullName
        if ($actual -cne [string]$remaining[$relative]) {
            throw "Portable staging content hash mismatch: $relative"
        }
        $remaining.Remove($relative)
    }
    if ($remaining.Count -ne 0) {
        throw "Portable staging omitted $($remaining.Count) manifested files."
    }
    foreach ($required in @(
        'aetherops.exe', 'runtime-manifest.json', 'knowledge-sidecar\index.cjs',
        'knowledge-sidecar\protocol.cjs', 'knowledge-sidecar\worker.cjs',
        'THIRD_PARTY_NOTICES.md', 'sbom\cyclonedx.json', 'sbom\spdx.json',
        'runtime\active.json', 'runtime\verification-receipt.json', 'runtime\source-acquisition.json'
    )) {
        if (-not $entries.ContainsKey($required)) {
            throw "Portable staging is missing required manifested content: $required"
        }
    }
    $identity = Get-AetherOpsProductIdentity `
        -Executable (Join-Path $root 'aetherops.exe') `
        -RuntimeManifest (Join-Path $root 'runtime-manifest.json') `
        -KnowledgeSidecarDirectory (Join-Path $root 'knowledge-sidecar')
    return [pscustomobject]@{
        ManifestSHA256 = $manifestSHA256
        FileCount = $entries.Count
        ExecutableSHA256 = $identity.ExecutableSHA256
        RuntimeManifestSHA256 = $identity.RuntimeManifestSHA256
        KnowledgeSidecarTreeSHA256 = $identity.KnowledgeSidecarTreeSHA256
    }
}

function Assert-AetherOpsPortableSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$StagingRoot,
        [Parameter(Mandatory = $true)]$Expected,
        [string]$Context = 'portable staging'
    )
    $actual = Get-AetherOpsPortableSnapshot -StagingRoot $StagingRoot
    foreach ($name in @('ManifestSHA256', 'FileCount', 'ExecutableSHA256', 'RuntimeManifestSHA256', 'KnowledgeSidecarTreeSHA256')) {
        if ([string]$Expected.$name -cne [string]$actual.$name) {
            throw "$Context changed after verification: $name"
        }
    }
    return $actual
}

function Read-AetherOpsZipEntryBytes {
    param(
        [Parameter(Mandatory = $true)]$Entry,
        [long]$MaximumBytes = 16777216
    )
    if ($Entry.Length -lt 0 -or $Entry.Length -gt $MaximumBytes) {
        throw "ZIP entry exceeds the verification limit: $($Entry.FullName)"
    }
    $stream = $Entry.Open()
    $memory = [IO.MemoryStream]::new()
    try {
        $stream.CopyTo($memory)
        if ($memory.Length -ne $Entry.Length) {
            throw "ZIP entry changed while reading: $($Entry.FullName)"
        }
        return $memory.ToArray()
    } finally {
        $memory.Dispose()
        $stream.Dispose()
    }
}

function Get-AetherOpsSidecarTreeSHA256FromBytes {
    param([Parameter(Mandatory = $true)][hashtable]$Files)
    $stream = [IO.MemoryStream]::new()
    try {
        $domain = [Text.Encoding]::UTF8.GetBytes("aetherops-knowledge-sidecar-tree-v1`0")
        $stream.Write($domain, 0, $domain.Length)
        foreach ($name in @('index.cjs', 'protocol.cjs', 'worker.cjs')) {
            [byte[]]$bytes = $Files[$name]
            if ($null -eq $bytes) { throw "ZIP is missing knowledge-sidecar/$name" }
            $nameBytes = [Text.Encoding]::UTF8.GetBytes($name)
            [byte[]]$nameLength = [BitConverter]::GetBytes([uint32]$nameBytes.Length)
            [byte[]]$fileLength = [BitConverter]::GetBytes([uint64]$bytes.Length)
            if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($nameLength); [Array]::Reverse($fileLength) }
            $stream.Write($nameLength, 0, $nameLength.Length)
            $stream.Write($nameBytes, 0, $nameBytes.Length)
            $stream.Write($fileLength, 0, $fileLength.Length)
            $stream.Write($bytes, 0, $bytes.Length)
        }
        return Get-AetherOpsBytesSHA256 -Bytes $stream.ToArray()
    } finally {
        $stream.Dispose()
    }
}

function Assert-AetherOpsPortableArchiveMatchesSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)]$Expected
    )
    if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
        throw "Portable ZIP is missing: $ZipPath"
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ZipPath))
    try {
        $entries = @{}
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('/', '\')
            if ($name.EndsWith('\') -and $entry.Length -eq 0) { continue }
            if ([IO.Path]::IsPathRooted($name) -or $name -match '[:\x00-\x1f]' -or
                $name.Split('\') -contains '..' -or $name.Split('\') -contains '.' -or
                $entries.ContainsKey($name)) {
                throw "Portable ZIP contains an unsafe or duplicate entry: $name"
            }
            $entries[$name] = $entry
        }
        if (-not $entries.ContainsKey('PACKAGE-CONTENTS.sha256')) {
            throw 'Portable ZIP omitted PACKAGE-CONTENTS.sha256.'
        }
        $manifestBytes = Read-AetherOpsZipEntryBytes -Entry $entries['PACKAGE-CONTENTS.sha256']
        if ((Get-AetherOpsBytesSHA256 -Bytes $manifestBytes) -cne [string]$Expected.ManifestSHA256) {
            throw 'Portable ZIP belongs to a different or changed staging manifest.'
        }
        $manifestText = [Text.Encoding]::UTF8.GetString($manifestBytes)
        $manifestEntries = Read-AetherOpsPackageManifestLines -Lines @($manifestText -split "`r?`n" | Where-Object { $_ -ne '' })
        if ($manifestEntries.Count -ne [int]$Expected.FileCount -or $entries.Count -ne ($manifestEntries.Count + 1)) {
            throw 'Portable ZIP entry set differs from its verified staging manifest.'
        }
        foreach ($name in $manifestEntries.Keys) {
            if (-not $entries.ContainsKey($name)) { throw "Portable ZIP omitted manifested entry: $name" }
        }
        $executableBytes = Read-AetherOpsZipEntryBytes -Entry $entries['aetherops.exe'] -MaximumBytes 134217728
        $manifestFileBytes = Read-AetherOpsZipEntryBytes -Entry $entries['runtime-manifest.json']
        $sidecarBytes = @{}
        foreach ($name in @('index.cjs', 'protocol.cjs', 'worker.cjs')) {
            $sidecarBytes[$name] = Read-AetherOpsZipEntryBytes -Entry $entries[('knowledge-sidecar\' + $name)]
        }
        $archiveIdentity = [pscustomobject]@{
            ExecutableSHA256 = Get-AetherOpsBytesSHA256 -Bytes $executableBytes
            RuntimeManifestSHA256 = Get-AetherOpsBytesSHA256 -Bytes $manifestFileBytes
            KnowledgeSidecarTreeSHA256 = Get-AetherOpsSidecarTreeSHA256FromBytes -Files $sidecarBytes
        }
        Assert-AetherOpsProductIdentityEqual -Expected $Expected -Actual $archiveIdentity -Context 'portable ZIP'
    } finally {
        $archive.Dispose()
    }
}

function Assert-AetherOpsInstallerUsesPortableStaging {
    param([Parameter(Mandatory = $true)][string]$InstallerScriptPath)
    $text = Get-Content -Raw -LiteralPath $InstallerScriptPath
    $files = [regex]::Match($text, '(?ms)^\[Files\]\s*(?<body>.*?)(?=^\[|\z)')
    if (-not $files.Success) { throw 'The installer has no [Files] section.' }
    $sources = @([regex]::Matches($files.Groups['body'].Value, '(?im)^\s*Source:\s*"[^"]+".*$') | ForEach-Object { $_.Value.Trim() })
    $expected = 'Source: "..\build\portable\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs'
    if ($sources.Count -ne 1 -or $sources[0] -cne $expected) {
        throw 'The installer must consume only the complete verified build\portable staging tree.'
    }
}
