[CmdletBinding()]
param(
    [string]$Archive,
    [string]$Root = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ProofReader\lean')
)

$ErrorActionPreference = 'Stop'
$version = '4.36.0'
$expectedHash = '5AF5F955DF6CFE37082D71C56C7D47FE620FAA9F59E14B917B43976C08DC676B'
$Root = [IO.DirectoryInfo]::new($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Root)).FullName.TrimEnd('\')
if (!$Root -or $Root -eq [IO.Path]::GetPathRoot($Root).TrimEnd('\')) { throw 'Choose a dedicated directory for the Lean runtime.' }
$runtime = Join-Path $Root $version
$previous = Join-Path $Root ('.previous-' + $version)
# The native compiler opens modules through the full runtime path. Keep staging
# as short as the final version directory when verifying a cold installation.
$staging = Join-Path $Root '.stage'
$markerName = '.naoma-lean-stage'
$marker = Join-Path $staging $markerName

function Assert-ManagedDirectory([string]$Path) {
    $name = [IO.Path]::GetFileName($Path)
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) -ne $Root -or
        ($name -ne $version -and $name -ne '.stage' -and $name -ne ('.previous-' + $version) -and $name -notmatch '^\.install-[a-f0-9]{32}$')) {
        throw 'Unexpected managed runtime directory.'
    }
    $item = Get-Item -Force -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($item -and (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw "The managed directory is a file or a link: $Path"
    }
}

# Do not follow any links that may have been left in a damaged runtime.
function Remove-DirectoryTree([IO.DirectoryInfo]$Directory) {
    foreach ($entry in $Directory.EnumerateFileSystemInfos()) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $entry.Delete()
        } elseif ($entry -is [IO.DirectoryInfo]) {
            Remove-DirectoryTree $entry
        } else {
            if ($entry.IsReadOnly) { $entry.IsReadOnly = $false }
            $entry.Delete()
        }
    }
    $Directory.Delete()
}

function Remove-ManagedDirectory([string]$Path) {
    Assert-ManagedDirectory $Path
    if ([IO.Directory]::Exists($Path)) { Remove-DirectoryTree ([IO.DirectoryInfo]::new($Path)) }
}

function Remove-WhenUnused([string]$Path) {
    try { Remove-ManagedDirectory $Path }
    catch {
        if (($_.Exception.GetBaseException().HResult -band 0xffff) -notin @(5, 32, 33)) { throw }
        Write-Verbose "Deferring cleanup of an in-use directory: $Path"
    }
}

function Get-InstallLock {
    $lockPath = Join-Path $Root '.install.lock'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        try { return [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 0xffff) -notin @(32, 33)) { throw }
            if ($timer.Elapsed.TotalMinutes -ge 27) { throw 'Another Lean installation is still running.' }
            Start-Sleep -Milliseconds 300
        }
    }
}

# A virus scanner or a just-exited compiler can briefly hold a handle to a directory.
function Move-Runtime([string]$From, [string]$To) {
    Assert-ManagedDirectory $From
    Assert-ManagedDirectory $To
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        try { [IO.Directory]::Move($From, $To); return }
        catch {
            $cause = $_.Exception.GetBaseException()
            if (($cause.HResult -band 0xffff) -notin @(5, 32, 33) -or $timer.Elapsed.TotalSeconds -ge 20) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
}

function Invoke-Probe([string]$Compiler, [string]$Arguments, [string]$SourceText) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Compiler
    $start.Arguments = $Arguments
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($Compiler)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($key in @($start.EnvironmentVariables.Keys)) {
        if ($key -like 'LEAN_*' -or $key -eq 'ELAN_TOOLCHAIN') {
            $start.EnvironmentVariables.Remove($key)
        }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($SourceText) { $process.StandardInput.WriteLine($SourceText) }
        $process.StandardInput.Close()
        if (!$process.WaitForExit(45000)) {
            $process.Kill()
            [void]$process.WaitForExit(3000)
            return
        }
        if ($process.ExitCode -eq 0 -and $stdout.Wait(3000) -and $stderr.Wait(3000)) { return $stdout.Result.Trim() }
    } catch [ComponentModel.Win32Exception] { return }
    catch [IO.IOException] { return }
    finally { $process.Dispose() }
}

function Test-Runtime([string]$Directory) {
    $compiler = Join-Path $Directory 'bin\lean.exe'
    if (![IO.File]::Exists($compiler)) { return $false }
    $reported = Invoke-Probe $compiler '--version' ''
    if ($reported -notmatch ('^Lean \(version ' + [regex]::Escape($version) + ', x86_64-w64-windows-gnu[,)]')) { return $false }
    $sample = @(
        'import Init'
        'theorem readingPart (n : Nat) : n + 1 > n := by omega'
        '#print axioms readingPart'
    ) -join [Environment]::NewLine
    $receipt = Invoke-Probe $compiler '--stdin -j1 -M1024' $sample
    return ($receipt -ceq "'readingPart' depends on axioms: [propext, Quot.sound]")
}

function Expand-VerifiedRelease([string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [IO.File]::OpenRead($ZipPath)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $sha.Dispose() }
        if ($hash -ne $expectedHash) { throw 'The archive does not match the published SHA-256 digest of the pinned Lean release.' }
        $stream.Position = 0
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            $prefix = "lean-$version-windows/"
            $entries = foreach ($item in $zip.Entries) {
                if (!$item.FullName.StartsWith($prefix, [StringComparison]::Ordinal)) { continue }
                $relative = $item.FullName.Substring($prefix.Length)
                if ($relative -notmatch '^(?:bin/(?:lean\.exe|[^/]+\.dll)|lib/lean/(?:[^/]+/)*[^/]+\.(?:olean(?:\.private|\.server)?|ir|dll)|LICENSE(?:S)?(?:\.txt|/.*)?)$' -or !$item.Name) { continue }
                # This pinned Windows compiler fails to open module paths of 260
                # characters even on systems where the extractor can write them.
                if (([IO.Path]::Combine($runtime, $relative)).Length -ge 260) {
                    throw 'The Lean runtime path is too long. Choose a shorter installation root for this Windows compiler.'
                }
                $item
            }
            foreach ($item in $entries) {
                $relative = $item.FullName.Substring($prefix.Length)
                $destination = [IO.Path]::GetFullPath((Join-Path $staging $relative))
                if (!$destination.StartsWith($staging + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected archive path.' }
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($item, $destination, $false)
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
}

[void][IO.Directory]::CreateDirectory($Root)
# Suppress Windows loader and crash dialogs when probing a damaged binary.
if (!('NaoMa.RuntimeProbe' -as [type])) {
    Add-Type -Namespace NaoMa -Name RuntimeProbe -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetErrorMode(uint mode);
'@
}
$lock = Get-InstallLock
$oldErrorMode = [NaoMa.RuntimeProbe]::SetErrorMode(0x8003)
$ownsStage = $false
try {
    Assert-ManagedDirectory $runtime
    Assert-ManagedDirectory $previous
    Assert-ManagedDirectory $staging
    foreach ($orphan in [IO.Directory]::EnumerateDirectories($Root, '.install-*')) {
        if ([IO.Path]::GetFileName($orphan) -match '^\.install-[a-f0-9]{32}$') { Remove-WhenUnused $orphan }
    }
    # If the installer closed between the two same-volume renames, restore the old directory first.
    if (![IO.Directory]::Exists($runtime) -and [IO.Directory]::Exists($previous)) {
        Move-Runtime $previous $runtime
    }
    if (Test-Runtime $runtime) {
        Remove-WhenUnused $previous
        return
    }
    if ([IO.Directory]::Exists($staging)) {
        if (![IO.File]::Exists($marker) -and [IO.Directory]::GetFileSystemEntries($staging).Length -gt 0) {
            throw 'The staging directory already contains unrelated files. Choose a dedicated Lean installation root.'
        }
        Remove-ManagedDirectory $staging
    }
    [void][IO.Directory]::CreateDirectory($staging)
    $ownsStage = $true
    [IO.File]::WriteAllText($marker, $version)
    if ($Archive) {
        $zipPath = (Resolve-Path -LiteralPath $Archive).ProviderPath
    } else {
        $zipPath = Join-Path $staging '.release.zip'
        $url = "https://github.com/leanprover/lean4/releases/download/v$version/lean-$version-windows.zip"
        & curl.exe --fail --location --proto '=https' --proto-redir '=https' --silent --show-error --retry 2 --retry-max-time 180 --connect-timeout 20 --max-time 1500 --output $zipPath $url
        if ($LASTEXITCODE -ne 0) { throw 'The official Lean release could not be downloaded.' }
    }
    Expand-VerifiedRelease $zipPath
    if (!$Archive) { [IO.File]::Delete($zipPath) }
    if (!(Test-Runtime $staging)) { throw 'The pinned compiler could not verify the sample theorem.' }
    Remove-ManagedDirectory $previous
    if ([IO.Directory]::Exists($runtime)) { Move-Runtime $runtime $previous }
    try { Move-Runtime $staging $runtime }
    catch {
        if ([IO.Directory]::Exists($previous) -and ![IO.Directory]::Exists($runtime)) {
            Move-Runtime $previous $runtime
        }
        throw
    }
    [IO.File]::Delete((Join-Path $runtime $markerName))
    Remove-WhenUnused $previous
} finally {
    try {
        if ($ownsStage) { Remove-WhenUnused $staging }
    } finally {
        $lock.Dispose()
        [void][NaoMa.RuntimeProbe]::SetErrorMode($oldErrorMode)
    }
}
