$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root "host-runtime/scripts/native-private-process/PrivateProcess.cpp"
$outputRoot = Join-Path $root "host-runtime/scripts/native-private-process/bin"
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
  # Compile from reviewed source on a hosted Windows runner. Static CRT avoids
  # a user-side installer/compile step. /Brepro removes wall-clock PE entropy;
  # all paths are controlled build inputs, never credentials or request data.
  $command = "`"$vcvars`" $($entry.vc) >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /W4 /WX /guard:cf /Brepro /DUNICODE /D_UNICODE `"$source`" /Fo`"$object`" /Fe`"$binary`" /link advapi32.lib crypt32.lib /DYNAMICBASE /NXCOMPAT /Brepro"
  & $env:ComSpec /d /s /c $command
  if ($LASTEXITCODE -ne 0) { throw "Native private worker build failed: $($entry.node)" }
  $metadata.binaries[$entry.node] = @{sha256 = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant(); sizeBytes = (Get-Item $binary).Length}
  Remove-Item -LiteralPath $object
}
$metadata | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 -Path (Join-Path $outputRoot "metadata.json")
