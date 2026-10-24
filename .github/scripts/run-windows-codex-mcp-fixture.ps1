# Real public Codex, isolated fixture configuration, synthetic stdio MCP only.
# No installed user profile, account, model turn, plugin trust or OS setting is
# used or changed. Both immutable official release archives are pinned by hash.
$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path $env:RUNNER_TEMP ('trelio-codex-mcp-' + [Guid]::NewGuid().ToString('N'))
$previousCli = $env:TRELIO_TEST_CODEX_CLI
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  $inputs = @(
    @{ Name = 'codex-x86_64-pc-windows-msvc.exe'; Target = 'codex.exe'; Sha = '90cf31818ddd8b29f956ad1df5f99af86c19296186be9a117d07b02b2c9bf0e8' },
    @{ Name = 'codex-code-mode-host-x86_64-pc-windows-msvc.exe'; Target = 'codex-code-mode-host.exe'; Sha = 'a17825919d06970ca739cdfd5e9c8040b1b0d33896e79db3980f96545ea1774e' }
  )
  foreach ($inputFile in $inputs) {
    $archive = Join-Path $fixtureRoot ($inputFile.Name + '.tar.gz')
    Invoke-WebRequest -Uri ('https://github.com/openai/codex/releases/download/rust-v0.164.0/' + $inputFile.Name + '.tar.gz') -OutFile $archive -TimeoutSec 120
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputFile.Sha) {
      throw 'Pinned public Codex archive hash mismatch'
    }
    $members = @(& tar -tf $archive)
    if ($LASTEXITCODE -ne 0 -or $members.Count -ne 1 -or ($members[0] -ne $inputFile.Name -and $members[0] -ne ('./' + $inputFile.Name))) {
      throw 'Pinned public Codex archive has unexpected members'
    }
    & tar -xf $archive -C $fixtureRoot
    if ($LASTEXITCODE -ne 0) { throw 'Pinned public Codex extraction failed' }
    Move-Item -LiteralPath (Join-Path $fixtureRoot $inputFile.Name) -Destination (Join-Path $fixtureRoot $inputFile.Target)
  }
  $env:TRELIO_TEST_CODEX_CLI = Join-Path $fixtureRoot 'codex.exe'
  node (Join-Path $PSScriptRoot '..\..\tests\trelio-codex-conversation.test.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Windows Codex MCP fixture failed with exit $LASTEXITCODE" }
} finally {
  $env:TRELIO_TEST_CODEX_CLI = $previousCli
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
