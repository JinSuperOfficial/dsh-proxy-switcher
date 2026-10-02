# Runs the plugin's test suite with the DSH runtime Node (the same Electron-as-Node
# 24.18.1 the harness host runs on) and a CLEAN proxy environment, so the machine's
# own proxy configuration can never mask or fake a routing result.
#
# The clean environment matters: Node resolves NODE_USE_ENV_PROXY once at startup,
# so a test process that inherits the user's proxy could appear to proxy traffic
# that the plugin never routed.
#
# Usage:  pwsh -File test/run-tests.ps1 [-Filter <name>]

param(
  [string]$Filter = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
# The desktop app install path; override with $env:DSH_HARNESS_DIR when it lives
# elsewhere (the default is `%LOCALAPPDATA%\Programs\DeepSeek Harness`).
$harnessDir = if ($env:DSH_HARNESS_DIR) { $env:DSH_HARNESS_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
$harnessExe = Join-Path $harnessDir 'DeepSeek Harness.exe'
$bundledNode = Join-Path $harnessDir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

# Prefer the harness binary (Electron-as-Node 24.18.1 = the real host runtime);
# fall back to the bundled standalone Node.
if (Test-Path $harnessExe) {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $runner = $harnessExe
} else {
  $runner = $bundledNode
}
if (-not (Test-Path $runner)) { throw "no Node runtime found (looked for '$harnessExe' and '$bundledNode')" }

# Scrub every proxy name from this shell so the child starts clean.
$proxyNames = @('ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY')
$saved = @{}
foreach ($name in $proxyNames) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

try {
  $files = if ($Filter) { @(Get-ChildItem -Path (Join-Path $repoRoot 'test') -Filter "*$Filter*.test.mjs" -File) }
           else { @(Get-ChildItem -Path (Join-Path $repoRoot 'test') -Filter '*.test.mjs' -File) }
  if ($files.Count -eq 0) { throw "no test files matched" }

  $failed = 0
  foreach ($file in $files) {
    Write-Host "`n=== $($file.Name) ===" -ForegroundColor Cyan
    # Each test file is executed DIRECTLY rather than under `node --test`: the
    # test runner spawns a child process per file, and that spawn is what the
    # host's stdio restrictions block (it would produce no output at all).
    # Output is collected through a pipeline; redirecting to a file handle is
    # also unreliable under Electron-as-Node.
    $text = (& $runner $file.FullName 2>&1 | Out-String)
    $code = $LASTEXITCODE
    Write-Host $text

    # Electron-as-Node does not always surface a usable exit code, so the
    # authoritative signal is Node's own summary line.
    $summaryFailed = $text -match '(?m)^\s*[#\u2139]\s*fail\s+[1-9]'
    $summaryPresent = $text -match '(?m)^\s*[#\u2139]\s*fail\s+\d'
    if ($summaryFailed -or -not $summaryPresent) {
      if (-not $summaryPresent -and $code -eq 0) {
        Write-Host '  (no test summary found, but the runner exited 0)' -ForegroundColor Yellow
      } else {
        $failed++
      }
    }
  }
  Write-Host ''
  if ($failed -gt 0) {
    Write-Host "$failed of $($files.Count) test file(s) FAILED" -ForegroundColor Red
    exit 1
  }
  Write-Host "all $($files.Count) test file(s) passed" -ForegroundColor Green
  exit 0
} finally {
  foreach ($name in $proxyNames) {
    if ($saved[$name]) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
}
