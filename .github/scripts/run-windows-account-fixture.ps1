# setup-python lives in the Actions toolcache, which production discovery must
# not trust. Both supported Node lanes need the SAME real per-user interpreter
# fixture after the independent discovery suite removes its own installation.
# Never replace a pre-existing install, widen PATH/trust roots or skip Python.
$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Python\Python313'
if (Test-Path -LiteralPath $fixtureRoot) {
  throw 'The Python fixture must not replace an existing installation'
}
if (-not $env:pythonLocation -or -not (Test-Path -LiteralPath (Join-Path $env:pythonLocation 'python.exe') -PathType Leaf)) {
  throw 'The pinned setup-python installation is required for the account fixture'
}
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  Copy-Item -Path (Join-Path $env:pythonLocation '*') -Destination $fixtureRoot -Recurse
  # Current Node is selected by setup-node in this lane. All test files and
  # Python bytes are synthetic/pinned read-only CI inputs, not live accounts.
  node (Join-Path $PSScriptRoot '..\..\tests\trelio-skill-accounts.test.mjs')
  if ($LASTEXITCODE -ne 0) { throw "Account fixture failed with exit $LASTEXITCODE" }
} finally {
  # Only the installation created above is removed, including on test failure.
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
