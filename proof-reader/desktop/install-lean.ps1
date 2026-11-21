[CmdletBinding()]
param([string]$Archive)
$ErrorActionPreference='Stop'
$version='4.36.0'
$expectedHash='5AF5F955DF6CFE37082D71C56C7D47FE620FAA9F59E14B917B43976C08DC676B'
$root=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ProofReader\lean'
$runtime=Join-Path $root $version
$exe=Join-Path $runtime 'bin\lean.exe'
if (Test-Path -LiteralPath $exe -PathType Leaf) {
    & $exe --version
    exit $LASTEXITCODE
}

[IO.Directory]::CreateDirectory($root) | Out-Null
$staging=Join-Path $root ('.install-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($staging) | Out-Null
$download=$null
try {
    if ($Archive) {
        $zipPath=(Resolve-Path -LiteralPath $Archive).ProviderPath
    } else {
        $download=Join-Path ([IO.Path]::GetTempPath()) ('proof-reader-lean-'+[Guid]::NewGuid().ToString('N')+'.zip')
        $zipPath=$download
        $url="https://github.com/leanprover/lean4/releases/download/v$version/lean-$version-windows.zip"
        curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 1500 --output $zipPath $url
        if ($LASTEXITCODE -ne 0) { throw 'The official Lean release could not be downloaded.' }
    }
    if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'The archive does not match the published SHA-256 digest of the pinned Lean release.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prefix="lean-$version-windows/"
    $verifiedStaging=[IO.Path]::GetFullPath($staging)+'\'
    $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        foreach ($item in $zip.Entries) {
            if (!$item.FullName.StartsWith($prefix,[StringComparison]::Ordinal)) { continue }
            $relative=$item.FullName.Substring($prefix.Length)
            if ($relative -notmatch '^(?:bin/(?:lean\.exe|[^/]+\.dll)|lib/lean/(?:[^/]+/)*[^/]+\.(?:olean(?:\.private|\.server)?|ir|dll)|LICENSE(?:S)?(?:\.txt|/.*)?)$') { continue }
            $destination=[IO.Path]::GetFullPath((Join-Path $staging $relative))
            if (!$destination.StartsWith($verifiedStaging,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected archive path.' }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($item,$destination,$false)
        }
    } finally { $zip.Dispose() }
    $localExe=Join-Path $staging 'bin\lean.exe'
    if (!(Test-Path -LiteralPath $localExe -PathType Leaf)) { throw 'The release did not contain the expected Lean compiler.' }
    @('theorem readingPart (n : Nat) : n + 1 > n := by omega','#print axioms readingPart') | & $localExe --stdin -j1 -M1024
    if ($LASTEXITCODE -ne 0) { throw 'The installed compiler could not check a sample theorem.' }
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($staging)) -ne $root -or
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($runtime)) -ne $root) { throw 'Unexpected runtime directory.' }
    [IO.Directory]::Move($staging,$runtime)
    & $exe --version
} finally {
    if ($download -and [IO.File]::Exists($download)) { [IO.File]::Delete($download) }
    if ([IO.Directory]::Exists($staging) -and
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($staging)) -eq $root -and
        [IO.Path]::GetFileName($staging) -match '^\.install-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
