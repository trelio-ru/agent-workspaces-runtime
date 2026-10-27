$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root "host-runtime/scripts/native-private-process/PrivateProcess.cpp"
$outputRoot = Join-Path $root "host-runtime/scripts/native-private-process/bin"
# Explorer loads taskbar/pinned icons from a PE resource, not an in-memory
# HICON in another process. Generate that resource from the SAME reviewed PNG
# array, so window and taskbar artwork cannot drift and no extra runtime asset
# or modification to Node.exe is needed. These are disposable build inputs.
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$sourceText = [System.IO.File]::ReadAllText($source)
$iconMatches = [regex]::Matches($sourceText, '(?s)BYTE AssistantConsoleIcon\[\] = \{(.*?)\};')
if ($iconMatches.Count -ne 1) { throw "Assistant icon source unavailable" }
$png = [byte[]]@([regex]::Matches($iconMatches[0].Groups[1].Value, '0x([0-9a-f]{2})') | ForEach-Object { [Convert]::ToByte($_.Groups[1].Value, 16) })
if ($png.Length -lt 32 -or [BitConverter]::ToString($png[0..7]) -ne '89-50-4E-47-0D-0A-1A-0A') { throw "Invalid assistant PNG" }
$iconPath = Join-Path $outputRoot "assistant.ico"
$resourcePath = Join-Path $outputRoot "assistant.rc"
$stream = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($stream)
try {
  # Keep a conventional 32-bit DIB inside the ICO/PE. The Shell's legacy icon
  # extractor is a different consumer from CreateIconFromResourceEx and must
  # also read the resource, including on ARM64. Decode the SAME PNG only on the
  # hosted builder, without resizing or another tracked artwork copy.
  Add-Type -AssemblyName System.Drawing
  $pngStream = [System.IO.MemoryStream]::new($png)
  $bitmap = [System.Drawing.Bitmap]::new($pngStream)
  $dibStream = [System.IO.MemoryStream]::new()
  $dib = [System.IO.BinaryWriter]::new($dibStream)
  try {
    if ($bitmap.Width -ne 64 -or $bitmap.Height -ne 64) { throw "Invalid assistant dimensions" }
    $dib.Write([uint32]40); $dib.Write([int32]64); $dib.Write([int32]128)
    $dib.Write([uint16]1); $dib.Write([uint16]32)
    foreach ($value in @(0, 16384, 0, 0, 0, 0)) { $dib.Write([uint32]$value) }
    # DIB rows are bottom-up BGRA. The 1-bit AND mask retains transparent pixels
    # for Shell consumers which still consult it even for a 32-bit alpha icon.
    for ($y = 63; $y -ge 0; $y--) {
      for ($x = 0; $x -lt 64; $x++) { $pixel = $bitmap.GetPixel($x, $y); $dib.Write([byte[]]@($pixel.B, $pixel.G, $pixel.R, $pixel.A)) }
    }
    for ($y = 63; $y -ge 0; $y--) {
      for ($group = 0; $group -lt 8; $group++) {
        $mask = 0
        for ($bit = 0; $bit -lt 8; $bit++) { if ($bitmap.GetPixel($group * 8 + $bit, $y).A -eq 0) { $mask = $mask -bor (128 -shr $bit) } }
        $dib.Write([byte]$mask)
      }
    }
    $image = $dibStream.ToArray()
  } finally { $dib.Dispose(); $dibStream.Dispose(); $bitmap.Dispose(); $pngStream.Dispose() }
  foreach ($value in @(0, 1, 1)) { $writer.Write([uint16]$value) }
  $writer.Write([byte[]]@(64, 64, 0, 0)); $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$image.Length); $writer.Write([uint32]22); $writer.Write([byte[]]$image)
  [System.IO.File]::WriteAllBytes($iconPath, $stream.ToArray())
} finally { $writer.Dispose(); $stream.Dispose() }
$resourceIcon = $iconPath.Replace('\', '\\')
[System.IO.File]::WriteAllText($resourcePath, "#pragma code_page(65001)`n1 ICON `"$resourceIcon`"`nSTRINGTABLE`nBEGIN`n101 `"Цифровой ассистент`"`nEND`n", [System.Text.UTF8Encoding]::new($false))
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw "MSVC build tools unavailable" }
$vcvars = Join-Path $installation "VC/Auxiliary/Build/vcvarsall.bat"
$metadata = @{schemaVersion = 1; sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant(); binaries = @{}}
foreach ($entry in @(@{node = "x64"; vc = "x64"}, @{node = "ia32"; vc = "x64_x86"}, @{node = "arm64"; vc = "x64_arm64"})) {
  $directory = Join-Path $outputRoot $entry.node
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $binary = Join-Path $directory "trelio-private-process.exe"
  $object = Join-Path $directory "worker.obj"
  $resource = Join-Path $directory "assistant.res"
  # Compile from reviewed source on a hosted Windows runner. Static CRT avoids
  # a user-side installer/compile step. /Brepro removes wall-clock PE entropy;
  # all paths are controlled build inputs, never credentials or request data.
  $command = "`"$vcvars`" $($entry.vc) >nul && rc.exe /nologo /fo `"$resource`" `"$resourcePath`" && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /W4 /WX /guard:cf /Brepro /DUNICODE /D_UNICODE `"$source`" `"$resource`" /Fo`"$object`" /Fe`"$binary`" /link advapi32.lib crypt32.lib uuid.lib /DYNAMICBASE /NXCOMPAT /Brepro"
  & $env:ComSpec /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw "Native private worker build failed: $($entry.node)" }
  $metadata.binaries[$entry.node] = @{sha256 = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant(); sizeBytes = (Get-Item $binary).Length}
  Remove-Item -LiteralPath $object, $resource
}
Remove-Item -LiteralPath $iconPath, $resourcePath
$metadata | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -Path (Join-Path $outputRoot "metadata.json")
