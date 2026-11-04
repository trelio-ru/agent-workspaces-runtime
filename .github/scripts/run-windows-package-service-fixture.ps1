param(
  [switch]$Child,
  [switch]$DiagnosticOnly,
  [string]$RepositoryBase64 = '',
  [string]$NodeBase64 = '',
  [string]$ControllerBase64 = '',
  [string]$TestTempBase64 = '',
  [string]$ReferenceGeneration = '',
  [string]$ReferenceSequence = ''
)
$ErrorActionPreference = 'Stop'
if ($DiagnosticOnly -and $env:GITHUB_ACTIONS -ceq 'true') { throw 'Diagnostic-only mode cannot satisfy a hosted gate.' }
function Decode([string]$value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
function DiagnosticNumber($value, [switch]$Required) {
  if ($null -eq $value) {
    if ($Required) { throw 'Missing numeric diagnostic field.' }
    return $null
  }
  if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt [uint32]::MaxValue) {
    throw 'Invalid numeric diagnostic field.'
  }
  return [long]$value
}
function DiagnosticBoolean($value) {
  if ($value -isnot [bool]) { throw 'Invalid boolean diagnostic field.' }
  return $value
}
function ProjectResource($value) {
  # Construct the closed frame explicitly. Never forward native stderr, unknown
  # properties, paths or exception prose merely because JSON parsing succeeded.
  return [ordered]@{
    open = (DiagnosticNumber $value.open -Required)
    register = (DiagnosticNumber $value.register)
    list = (DiagnosticNumber $value.list)
    end = (DiagnosticNumber $value.end)
    count = (DiagnosticNumber $value.count)
    pidMatches = (DiagnosticBoolean $value.pidMatches)
    nameMatches = (DiagnosticBoolean $value.nameMatches)
    typeMatches = (DiagnosticBoolean $value.typeMatches)
    generationMatches = (DiagnosticBoolean $value.generationMatches)
  }
}
if ($Child) {
  # This is a NEW disposable standard account, not a filtered runner-admin
  # approximation. The fixture itself asserts !administrator and verifies that
  # the OLD query+SYNCHRONIZE request is actually denied by the service DACL.
  $repository = Decode $RepositoryBase64
  $node = Decode $NodeBase64
  $env:TRELIO_WINDOWS_PACKAGE_SERVICE_FIXTURE = Decode $ControllerBase64
  $env:TRELIO_SERVICE_FIXTURE_REFERENCE = $ReferenceGeneration
  $env:TRELIO_SERVICE_FIXTURE_SEQUENCE = $ReferenceSequence
  $testTemp = Decode $TestTempBase64
  New-Item -ItemType Directory -Path $testTemp -Force | Out-Null
  $env:TEMP = $testTemp; $env:TMP = $testTemp
  # Read both RM resource variants once before the unchanged positive test.
  # A refusal is diagnostic DATA, not success/permission for an alternate
  # production path. Bound this own read process; never kill the service.
  $probeOut = Join-Path $testTemp 'resource-probe.json'
  $probeError = Join-Path $testTemp 'resource-probe.stderr'
  # Keep the actual CreateProcess handle in our Process object. The earlier
  # Start-Process wrapper returned null ExitCode despite a complete native frame;
  # never infer success from that frame or synthesize zero. This is only our
  # own constant-size read-only fixture, not a production service/process open.
  $probeInfo = [Diagnostics.ProcessStartInfo]::new()
  $probeInfo.FileName = $env:TRELIO_WINDOWS_PACKAGE_SERVICE_FIXTURE
  $probeInfo.Arguments = 'probe'; $probeInfo.UseShellExecute = $false
  $probeInfo.CreateNoWindow = $true
  $probeInfo.RedirectStandardOutput = $true; $probeInfo.RedirectStandardError = $true
  $probe = [Diagnostics.Process]::new(); $probe.StartInfo = $probeInfo
  if (!$probe.Start()) { throw 'Owned read-only resource probe did not start.' }
  $probeOutput = $probe.StandardOutput.ReadToEndAsync()
  $probeStderr = $probe.StandardError.ReadToEndAsync()
  if (!$probe.WaitForExit(45000)) {
    $probe.Kill()
    if (!$probe.WaitForExit(5000)) { throw 'Owned read-only probe exit is unknown; no replay.' }
    throw 'Owned read-only resource probe timed out; no replay.'
  }
  $probePipes = [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($probeOutput, $probeStderr))
  if (!$probePipes.Wait(5000)) { throw 'Resource probe pipes did not close; no replay.' }
  [IO.File]::WriteAllText($probeOut, $probeOutput.Result)
  [IO.File]::WriteAllText($probeError, $probeStderr.Result)
  # Observe collection separately from native API results. An unavailable exit
  # observation is NEVER zero/success. Preserve a valid
  # bounded native diagnostic BEFORE rejecting that transport observation, so
  # a collector failure cannot erase the FILE/SERVICE comparison we need.
  $probe.Refresh()
  $probeExit = $probe.ExitCode
  $probe.Dispose()
  $probeBytes = (Get-Item $probeOut).Length
  $probeErrorBytes = (Get-Item $probeError).Length
  [ordered]@{ resourceProbeProcess = $true; exitCode = $probeExit; outputBytes = $probeBytes; errorBytes = $probeErrorBytes } | ConvertTo-Json -Compress
  if ($probeBytes -le 0 -or $probeBytes -gt 8192) { throw 'Bounded resource probe output unavailable.' }
  $record = [IO.File]::ReadAllText($probeOut) | ConvertFrom-Json
  if ($record.fixtureFailure -eq $true) {
    # These are the only exception stages reachable from this source-only probe.
    # Other stages remain a closed unknown; a native refusal is never CI success.
    $stage = if ($record.stage -cin @('resource_probe', 'rm_library')) { $record.stage } else { 'unknown' }
    [ordered]@{ fixtureFailure = $true; stage = $stage; detail = (DiagnosticNumber $record.detail) } | ConvertTo-Json -Compress
    throw 'Native resource comparison refused.'
  }
  if ($record.diagnosticOnly -ne $true -or $record.notCIEvidence -ne $true) { throw 'Invalid diagnostic record.' }
  [ordered]@{
    diagnosticOnly = $true; notCIEvidence = $true
    originalQuerySucceeded = (DiagnosticBoolean $record.originalQuerySucceeded)
    originalQueryError = (DiagnosticNumber $record.originalQueryError -Required)
    zeroOpenSucceeded = (DiagnosticBoolean $record.zeroOpenSucceeded)
    zeroOpenError = (DiagnosticNumber $record.zeroOpenError -Required)
    file = (ProjectResource $record.file); service = (ProjectResource $record.service)
    basic = [ordered]@{
      available = (DiagnosticBoolean $record.basic.available)
      status = (DiagnosticNumber $record.basic.status)
      complete = (DiagnosticBoolean $record.basic.complete)
      pidMatches = (DiagnosticBoolean $record.basic.pidMatches)
      imageMatches = (DiagnosticBoolean $record.basic.imageMatches)
      referenceMatches = (DiagnosticBoolean $record.basic.referenceMatches)
      stableMatches = (DiagnosticBoolean $record.basic.stableMatches)
    }
    wmi = [ordered]@{
      stage = (DiagnosticNumber $record.wmi.stage -Required)
      status = (DiagnosticNumber $record.wmi.status -Required)
      complete = (DiagnosticBoolean $record.wmi.complete)
      pidMatches = (DiagnosticBoolean $record.wmi.pidMatches)
      nameMatches = (DiagnosticBoolean $record.wmi.nameMatches)
      pathAvailable = (DiagnosticBoolean $record.wmi.pathAvailable)
      pathMatches = (DiagnosticBoolean $record.wmi.pathMatches)
      creationAvailable = (DiagnosticBoolean $record.wmi.creationAvailable)
      creationMatchesMicroseconds = (DiagnosticBoolean $record.wmi.creationMatchesMicroseconds)
    }
  } | ConvertTo-Json -Compress -Depth 5
  if ($null -eq $probeExit -or $probeExit -ne 0 -or $probeErrorBytes -ne 0) { throw 'Resource probe process outcome was not successful; no replay.' }
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
$command = "`"$vcvars`" $target >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /W4 /WX /guard:cf /Brepro /DUNICODE /D_UNICODE `"$source`" /Fo`"$object`" /Fe`"$serviceBinary`" /link advapi32.lib crypt32.lib uuid.lib ole32.lib oleaut32.lib wbemuuid.lib /DYNAMICBASE /NXCOMPAT /Brepro"
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
  if ($null -ne $prepared.sequence) {
    if ($prepared.sequence -cnotmatch '^[1-9]\d{0,19}$') { throw 'Invalid fixture sequence reference.' }
    $arguments += @('-ReferenceSequence', $prepared.sequence)
  }
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
