param(
  [switch]$Child,
  [string]$RepositoryBase64 = '',
  [string]$NodeBase64 = '',
  [string]$ControllerBase64 = '',
  [string]$TestTempBase64 = '',
  [string]$ReferenceGeneration = ''
)
$ErrorActionPreference = 'Stop'
# This gate is source-tree-only and never a local/VM fallback. Both parent and
# child must be the hosted x64 lane; no diagnostic mode can satisfy acceptance.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64') {
  throw 'The positive service fixture requires the hosted x64 Windows job.'
}
function Decode([string]$value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
if ($Child) {
  # A NEW non-administrator, not a filtered runner-admin approximation. The
  # native test independently proves denial of the old process rights and
  # compares its first OS generation with the administrator's query-only read.
  $repository = Decode $RepositoryBase64
  $node = Decode $NodeBase64
  $env:TRELIO_WINDOWS_PACKAGE_SERVICE_FIXTURE = Decode $ControllerBase64
  $env:TRELIO_SERVICE_FIXTURE_REFERENCE = $ReferenceGeneration
  $testTemp = Decode $TestTempBase64
  New-Item -ItemType Directory -Path $testTemp -Force | Out-Null
  $env:TEMP = $testTemp; $env:TMP = $testTemp
  $env:USERPROFILE = $testTemp
  $env:LOCALAPPDATA = Join-Path $testTemp 'AppData/Local'
  $env:APPDATA = Join-Path $testTemp 'AppData/Roaming'
  & $node --test '--test-name-pattern=^ordinary packaged service control works without process query or synchronization rights$' (Join-Path $repository 'tests/trelio-windows-native-private.test.mjs')
  exit $LASTEXITCODE
}

# The fixture may create ONLY its own inert LocalSystem service/account. Its
# executable is separate from the controller and never enters the runtime
# artifact. No installed Codex process, service, package or ACL is selected.
$repository = $env:GITHUB_WORKSPACE
$node = (Get-Command node -ErrorAction Stop).Source
$root = Join-Path $env:RUNNER_TEMP ('trelio-service-' + [Guid]::NewGuid().ToString('N'))
$resources = Join-Path $root 'app/resources'
New-Item -ItemType Directory -Path $resources | Out-Null
$serviceBinary = Join-Path $resources 'codex-windows-sandbox-service.exe'
$controller = Join-Path $root 'fixture-controller.exe'
$object = Join-Path $root 'fixture.obj'
$source = Join-Path $repository 'tests/fixtures/windows-package-service-access.cpp'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'Fixture MSVC unavailable.' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvarsall.bat'
$command = "`"$vcvars`" x64 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /W4 /WX /guard:cf /Brepro /DUNICODE /D_UNICODE `"$source`" /Fo`"$object`" /Fe`"$serviceBinary`" /link advapi32.lib crypt32.lib uuid.lib /DYNAMICBASE /NXCOMPAT /Brepro"
& $env:ComSpec /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw 'Source-composed service fixture compilation failed.' }
Copy-Item -LiteralPath $serviceBinary -Destination $controller
& icacls.exe $root /grant '*S-1-5-11:(OI)(CI)RX' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Disposable fixture read permission failed.' }

$name = 'treliosvc' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$secret = ConvertTo-SecureString ('Trelio-fixture-' + [Guid]::NewGuid().ToString('N') + '-aA1!') -AsPlainText -Force
$created = $false
$childSettled = $true
$childProcess = $null
try {
  New-LocalUser -Name $name -Password $secret -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  $created = $true
  $preparedText = & $controller prepare
  if ($LASTEXITCODE -ne 0) { throw 'Disposable service preparation failed.' }
  $prepared = $preparedText | ConvertFrom-Json
  if ($prepared.prepared -ne $true -or $prepared.generation -cnotmatch '^[1-9]\d{0,9}:[1-9]\d{0,19}$') { throw 'Invalid independent fixture generation.' }
  '{"prepared":true}'
  $testTemp = Join-Path $env:SystemDrive "Users/$name/AppData/Local/Temp/trelio-service-test"
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Child',
    '-RepositoryBase64', (Encode $repository), '-NodeBase64', (Encode $node), '-ControllerBase64', (Encode $controller),
    '-TestTempBase64', (Encode $testTemp), '-ReferenceGeneration', $prepared.generation)
  # Keep the actual owned process handle through exit/pipe close. Start-Process
  # lost ExitCode in this lane; null must never be synthesized into success.
  # SecureString stays in the same protected Windows logon API, not argv/env.
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $info.Arguments = $arguments -join ' '
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.UserName = $name; $info.Domain = $env:COMPUTERNAME
  $info.Password = $secret; $info.LoadUserProfile = $true
  $info.EnvironmentVariables.Remove('HOME')
  $info.EnvironmentVariables.Remove('CODEX_HOME')
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $childProcess = [Diagnostics.Process]::new(); $childProcess.StartInfo = $info
  if (!$childProcess.Start()) { throw 'Ordinary fixture child did not start.' }
  $childSettled = $false
  $childProcess.StandardInput.Close()
  $outputTask = $childProcess.StandardOutput.ReadToEndAsync()
  $errorTask = $childProcess.StandardError.ReadToEndAsync()
  if (!$childProcess.WaitForExit(180000)) { throw 'Owned fixture child outcome is unknown; no replay or live cleanup.' }
  $pipes = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($outputTask, $errorTask))
  if (!$pipes.Wait(5000)) { throw 'Owned fixture pipes remain open; no live cleanup.' }
  $childSettled = $true
  $exitCode = $childProcess.ExitCode
  $output = $outputTask.Result; $errors = $errorTask.Result
  [IO.File]::WriteAllText((Join-Path $root 'standard-user.stdout.log'), $output)
  [IO.File]::WriteAllText((Join-Path $root 'standard-user.stderr.log'), $errors)
  [Console]::Out.Write($output); [Console]::Error.Write($errors)
  $completed = [regex]::IsMatch($output, '(?m)^# SERVICE_ACCESS_FIXTURE_COMPLETED\r?$')
  if ($null -eq $exitCode -or $exitCode -ne 0 -or !$completed) { throw 'Actual ordinary-user service regression did not complete.' }
} finally {
  if ($childProcess) { $childProcess.Dispose() }
  if (!$childSettled) {
    # Do not race a late Node/native control call. Preserve this exact disposable
    # fixture/account until the failed ephemeral runner is disposed; no kill,
    # duplicate stop, delete or blind cleanup may turn unknown into acceptance.
    throw 'Owned fixture remains uncertain; service/account/files retained.'
  }
  $cleaned = $false
  try {
    & $controller cleanup
    if ($LASTEXITCODE -ne 0) { throw 'Disposable service cleanup refused.' }
    $cleaned = $true
  } finally {
    if ($created) { Remove-LocalUser -Name $name }
    if ($cleaned) { Remove-Item -LiteralPath $root -Recurse -Force }
    $secret = $null
  }
}
