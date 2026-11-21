param([string]$SdkPackage)
$ErrorActionPreference = 'Stop'
$version = '1.0.4314.35'
$expected = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
if (!$SdkPackage) {
    $SdkPackage = Join-Path ([IO.Path]::GetTempPath()) "proof-reader-webview2-$version.nupkg"
    if (!(Test-Path -LiteralPath $SdkPackage)) {
        $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
        Invoke-WebRequest -UseBasicParsing $url -OutFile $SdkPackage
    }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $SdkPackage).Hash -ne $expected) { throw 'The WebView2 package checksum does not match.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $SdkPackage).Path)
try {
    $files = @{
        'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
        'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
        'runtimes/win-x64/native/WebView2Loader.dll' = 'WebView2Loader.dll'
        'LICENSE.txt' = 'WebView2-LICENSE.txt'
        'NOTICE.txt' = 'WebView2-NOTICE.txt'
    }
    foreach ($entry in $files.Keys) {
        $targetFile = Join-Path $PSScriptRoot $files[$entry]
        [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry($entry), $targetFile, $true)
    }
} finally { $archive.Dispose() }

$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$iconFile = [IO.Path]::GetTempFileName()
Push-Location $PSScriptRoot
try {
    Add-Type -AssemblyName System.Drawing
    $sizes = @(16,32,48,64,128,256)
    $images = @()
    $green = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(37, 82, 65))
    $cream = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(251, 250, 241))
    foreach ($size in $sizes) {
        $bitmap = [Drawing.Bitmap]::new($size,$size)
        $canvas = [Drawing.Graphics]::FromImage($bitmap)
        $canvas.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $border = [Drawing.Drawing2D.GraphicsPath]::new()
        $corner = $size * 0.32
        $border.AddArc(0, 0, $corner, $corner, 180, 90)
        $border.AddArc($size-$corner, 0, $corner, $corner, 270, 90)
        $border.AddArc($size-$corner, $size-$corner, $corner, $corner, 0, 90)
        $border.AddArc(0, $size-$corner, $corner, $corner, 90, 90)
        $border.CloseFigure()
        $canvas.FillPath($green, $border)
        $d = [single]($size*0.16)
        foreach ($dot in @(@(0.50,0.31),@(0.31,0.66),@(0.69,0.66))) {
            $canvas.FillEllipse($cream, [single]($dot[0]*$size-$d/2), [single]($dot[1]*$size-$d/2), $d, $d)
        }
        $png = [IO.MemoryStream]::new()
        $bitmap.Save($png,[Drawing.Imaging.ImageFormat]::Png)
        $images += ,$png.ToArray()
        $png.Dispose(); $border.Dispose(); $canvas.Dispose(); $bitmap.Dispose()
    }
    $cream.Dispose(); $green.Dispose()
    $writer = [IO.BinaryWriter]::new([IO.File]::Create($iconFile))
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
        $offset = 6 + 16*$sizes.Count
        for ($i=0; $i -lt $sizes.Count; $i++) {
            $side = [byte]($sizes[$i] % 256)
            $writer.Write($side); $writer.Write($side); $writer.Write([uint16]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
            $offset += $images[$i].Length
        }
        foreach ($pngBytes in $images) { $writer.Write([byte[]]$pngBytes) }
    } finally { $writer.Dispose() }
    & $compiler /nologo /platform:x64 /target:winexe /optimize+ '/out:Proof Reader.exe' /win32manifest:app.manifest "/win32icon:$iconFile" `
        /reference:System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Net.Http.dll `
        /reference:Microsoft.Web.WebView2.Core.dll,Microsoft.Web.WebView2.WinForms.dll ProofReader.cs
    if ($LASTEXITCODE) { throw 'The desktop build failed.' }
} finally { Pop-Location; [IO.File]::Delete($iconFile) }
