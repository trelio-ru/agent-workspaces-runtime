param(
  [switch]$Child,
  [string]$RepositoryBase64 = '',
  [string]$NodeBase64 = '',
  [string]$ControllerBase64 = ''
)
$ErrorActionPreference = 'Stop'
function Decode([string]$value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
function Encode([string]$value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
if ($Child) {
  # This is a NEW disposable standard account, not a filtered runner-admin
  # approximation. The fixture itself asserts !administrator and verifies that
  # the OLD query+SYNCHRONIZE request is actually denied by the service DACL.
  $repository = Decode $RepositoryBase64
  $node = Decode $NodeBase64
  $env:TRELIO_WINDOWS_PACKAGE_SERVICE_FIXTURE = Decode $ControllerBase64
  & $node --test '--test-name-pattern=^ordinary packaged service control works without process query or synchronization rights$' (Join-Path $repository 'tests/trelio-windows-native-private.test.mjs')
  exit $LASTEXITCODE
}

# CI-only setup can create its OWN inert LocalSystem service and test account.
# It never uses a developer's Codex package/service or changes production ACLs.
# A user VM is not an automatic fallback for this mandatory hosted regression.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64') {
  throw 'The disposable service fixture requires the hosted x64 Windows job.'
}
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
  & $controller prepare
  if ($LASTEXITCODE -ne 0) { throw 'Disposable service preparation failed.' }
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Child',
    '-RepositoryBase64', (Encode $repository), '-NodeBase64', (Encode $node), '-ControllerBase64', (Encode $controller))
  $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $childProcess = Start-Process -FilePath $shell -ArgumentList $arguments -Credential $credential -LoadUserProfile -Wait -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (Test-Path $stdout) { Get-Content $stdout }
  if (Test-Path $stderr) { Get-Content $stderr }
  if ($childProcess.ExitCode -ne 0 -or !(Select-String -LiteralPath $stdout -Pattern '^# SERVICE_ACCESS_FIXTURE_COMPLETED$' -Quiet)) {
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
