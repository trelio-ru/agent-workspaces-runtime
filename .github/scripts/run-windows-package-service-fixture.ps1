param(
  [switch]$Child,
  [switch]$DiagnosticOnly,
  [string]$RepositoryBase64 = '',
  [string]$NodeBase64 = '',
  [string]$ControllerBase64 = '',
  [string]$TestTempBase64 = '',
  [string]$ReferenceGeneration = ''
)
$ErrorActionPreference = 'Stop'
if ($DiagnosticOnly -and $env:GITHUB_ACTIONS -ceq 'true') { throw 'Diagnostic-only mode cannot satisfy a hosted gate.' }
function Decode([string]$value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
if ($Child) {
  # This is a NEW disposable standard account, not a filtered runner-admin
  # approximation. The fixture itself asserts !administrator and verifies that
  # the OLD query+SYNCHRONIZE request is actually denied by the service DACL.
  $repository = Decode $RepositoryBase64
  $node = Decode $NodeBase64
  $env:TRELIO_WINDOWS_PACKAGE_SERVICE_FIXTURE = Decode $ControllerBase64
  $env:TRELIO_SERVICE_FIXTURE_REFERENCE = $ReferenceGeneration
  $testTemp = Decode $TestTempBase64
  New-Item -ItemType Directory -Path $testTemp -Force | Out-Null
  $env:TEMP = $testTemp; $env:TMP = $testTemp
  # Read both RM resource variants once before the unchanged positive test.
  # A refusal is diagnostic DATA, not success/permission for an alternate
  # production path. Bound this own read process; never kill the service.
  $probeOut = Join-Path $testTemp 'resource-probe.json'
  $probeError = Join-Path $testTemp 'resource-probe.stderr'
  $probe = Start-Process -FilePath $env:TRELIO_WINDOWS_PACKAGE_SERVICE_FIXTURE -ArgumentList 'probe' -PassThru `
    -RedirectStandardOutput $probeOut -RedirectStandardError $probeError
  if (!$probe.WaitForExit(45000)) {
    $probe.Kill()
    if (!$probe.WaitForExit(5000)) { throw 'Owned read-only probe exit is unknown; no replay.' }
    throw 'Owned read-only resource probe timed out; no replay.'
  }
  if ($probe.ExitCode -ne 0 -or (Get-Item $probeOut).Length -gt 8192) { throw 'Bounded resource probe failed.' }
  $record = [IO.File]::ReadAllText($probeOut) | ConvertFrom-Json
  if ($record.diagnosticOnly -ne $true -or $record.notCIEvidence -ne $true) { throw 'Invalid diagnostic record.' }
  $record | ConvertTo-Json -Compress -Depth 5
  if ($DiagnosticOnly) { exit 0 }
  & $node --test '--test-name-pattern=^ordinary packaged service control works without process query or synchronization rights$' (Join-Path $repository 'tests/trelio-windows-native-private.test.mjs')
  exit $LASTEXITCODE
}

# CI-only setup can create its OWN inert LocalSystem service and test account.
# It never uses a developer's Codex package/service or changes production ACLs.
# A user VM is not an automatic fallback for this mandatory hosted regression.
# Local comparison requires a separately authorized concrete test-VM run.
# It NEVER produces CI evidence and is forbidden inside GitHub, where the
# real standard-user positive assertion must still run and pass.
if (!$DiagnosticOnly -and ($env:GITHUB_ACTIONS -cne 'true' -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64')) {
  throw 'The positive service fixture requires the hosted x64 Windows job.'
}
$repository = if ($DiagnosticOnly) { (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path } else { $env:GITHUB_WORKSPACE }
$node = if ($DiagnosticOnly) { '' } else { (Get-Command node -ErrorAction Stop).Source }
$tempRoot = if ($DiagnosticOnly) { [IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
$root = Join-Path $tempRoot ('trelio-service-' + [Guid]::NewGuid().ToString('N'))
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
$target = if ($env:PROCESSOR_ARCHITECTURE -ceq 'ARM64') { 'x64_arm64' } else { 'x64' }
$command = "`"$vcvars`" $target >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /W4 /WX /guard:cf /Brepro /DUNICODE /D_UNICODE `"$source`" /Fo`"$object`" /Fe`"$serviceBinary`" /link advapi32.lib crypt32.lib uuid.lib /DYNAMICBASE /NXCOMPAT /Brepro"
& $env:ComSpec /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw 'Source-composed service fixture compilation failed.' }
# Distinct files are essential: a client mapping the SAME service executable
# would itself appear in the exact-image Restart Manager inventory.
Copy-Item -LiteralPath $serviceBinary -Destination $controller
& icacls.exe $root /grant '*S-1-5-11:(OI)(CI)RX' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Disposable fixture read permission failed.' }

$name = 'treliosvc' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$secret = ConvertTo-SecureString ('Trelio-fixture-' + [Guid]::NewGuid().ToString('N') + '-aA1!') -AsPlainText -Force
$credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $secret)
$created = $false
$stdout = Join-Path $root 'standard-user.stdout.log'
$stderr = Join-Path $root 'standard-user.stderr.log'
try {
  New-LocalUser -Name $name -Password $secret -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  $created = $true
  $preparedText = & $controller prepare
  if ($LASTEXITCODE -ne 0) { throw 'Disposable service preparation failed.' }
  $prepared = $preparedText | ConvertFrom-Json
  if ($prepared.prepared -ne $true -or $prepared.generation -cnotmatch '^[1-9]\d{0,9}:[1-9]\d{0,19}$') { throw 'Invalid independent fixture generation.' }
  '{"prepared":true}'
  $testTemp = Join-Path $env:SystemDrive "Users/$name/AppData/Local/Temp/trelio-service-probe"
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Child',
    '-RepositoryBase64', (Encode $repository), '-ControllerBase64', (Encode $controller),
    '-TestTempBase64', (Encode $testTemp), '-ReferenceGeneration', $prepared.generation)
  if ($DiagnosticOnly) { $arguments += '-DiagnosticOnly' } else { $arguments += @('-NodeBase64', (Encode $node)) }
  $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $childProcess = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile -Wait -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (Test-Path $stdout) { Get-Content $stdout }
  if (Test-Path $stderr) { Get-Content $stderr }
  $completed = if ($DiagnosticOnly) { Select-String -LiteralPath $stdout -Pattern '"notCIEvidence":true' -Quiet } else {
    Select-String -LiteralPath $stdout -Pattern '^# SERVICE_ACCESS_FIXTURE_COMPLETED$' -Quiet
  }
  if ($childProcess.ExitCode -ne 0 -or !$completed) {
    throw 'Actual ordinary-user service regression did not complete.'
  }
} finally {
  # Cleanup is restricted again by the SAME exact newly generated image path.
  # No force kill is used even for this inert fixture. A refused/hung cleanup
  # fails the job and retains its files; it never touches another service.
  $cleaned = $false
  try {
    & $controller cleanup
    if ($LASTEXITCODE -ne 0) { throw 'Disposable service cleanup refused.' }
    $cleaned = $true
  } finally {
    if ($created) { Remove-LocalUser -Name $name }
    if ($cleaned) { Remove-Item -LiteralPath $root -Recurse -Force }
    $credential = $null; $secret = $null
  }
}
