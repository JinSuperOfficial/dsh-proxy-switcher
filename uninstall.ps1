# Removes dsh-proxy-switcher from a dsh profile, reversing install.ps1 exactly.
#
# It removes the junction and the two package.json changes. dsh must reload the
# loader afterwards for the row to disappear; until then the plugin keeps
# working, which is the safe direction.
#
# Usage:
#   pwsh -File uninstall.ps1                     # default profile: desktop
#   pwsh -File uninstall.ps1 -Profile web
#   pwsh -File uninstall.ps1 -RestoreBackup      # also restore the newest backup

param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$RestoreBackup
)

$ErrorActionPreference = 'Stop'

$packageName = 'dsh-proxy-switcher'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$packageJson = Join-Path $profileDir 'package.json'
$target = Join-Path $profileDir "node_modules\$packageName"

if (-not (Test-Path $packageJson)) { throw "no profile at '$profileDir'" }

Write-Host "Removing $packageName from $profileDir" -ForegroundColor Cyan

# ---- 1. drop the junction -------------------------------------------------
if (Test-Path $target) {
  # Only remove a junction/link we created; refuse to delete a real directory
  # that might hold someone's source.
  $item = Get-Item $target -Force
  if ($null -ne $item.LinkType) {
    cmd /c rmdir "$target" | Out-Null
    Write-Host "  removed : $target"
  } else {
    Write-Host "  SKIPPED : $target is a real directory, not a junction — delete it yourself if it is the plugin" -ForegroundColor Yellow
  }
} else {
  Write-Host '  nothing : no junction to remove'
}

# ---- 2. undo the package.json edits --------------------------------------
$json = Get-Content $packageJson -Raw | ConvertFrom-Json
$changed = $false
if ($null -ne $json.dependencies -and $json.dependencies.PSObject.Properties.Name -contains $packageName) {
  $json.dependencies.PSObject.Properties.Remove($packageName)
  $changed = $true
}
if ($null -ne $json.dsh -and $null -ne $json.dsh.profile -and $null -ne $json.dsh.profile.bundles) {
  $bundles = @($json.dsh.profile.bundles) | Where-Object { $_ -ne $packageName }
  $json.dsh.profile.bundles = $bundles
  $changed = $true
}
if ($changed) {
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  Copy-Item $packageJson "$packageJson.bak-before-uninstall-$stamp" -Force
  $json | ConvertTo-Json -Depth 32 | Set-Content $packageJson -Encoding UTF8
  Write-Host "  updated : $packageJson (dependency + bundle entry removed)"
} else {
  Write-Host '  nothing : package.json had no plugin entry'
}

# ---- 3. optional: restore the pre-install document -----------------------
if ($RestoreBackup) {
  $backup = Get-ChildItem "$packageJson.bak-before-$packageName-*" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -ne $backup) {
    Copy-Item $backup.FullName $packageJson -Force
    Write-Host "  restored: $($backup.Name)" -ForegroundColor Yellow
  } else {
    Write-Host '  no pre-install backup found' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Removed.' -ForegroundColor Green
Write-Host 'dsh must reload the loader for the row to disappear; the plugin keeps working until then.'
Write-Host 'Your saved proxies are left alone at $DSH_HOME/proxy-switcher.json — delete that file to forget them.'
