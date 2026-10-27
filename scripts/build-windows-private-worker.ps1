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
  # One PNG-compressed 64px image in a standard ICO container. The native
  # window helper scales this same PNG to the current small/large metrics.
  foreach ($value in @(0, 1, 1)) { $writer.Write([uint16]$value) }
  $writer.Write([byte[]]@(64, 64, 0, 0)); $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
  [System.IO.File]::WriteAllBytes($iconPath, $stream.ToArray())
} finally { $writer.Dispose(); $stream.Dispose() }
$resourceIcon = $iconPath.Replace('\', '\\')
[System.IO.File]::WriteAllText($resourcePath, "#pragma code_page(65001)`n102 ICON `"$resourceIcon`"`nSTRINGTABLE`nBEGIN`n101 `"Цифровой ассистент`"`nEND`n", [System.Text.UTF8Encoding]::new($false))
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
