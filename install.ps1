# Installs dsh-proxy-switcher into a dsh profile.
#
# What it changes (all backed up first):
#   1. the profile's package.json      — adds the dependency and the bundle entry
#   2. <profile>/node_modules/<name>   — a junction to this folder, so no download
#                                        and no pnpm run are needed
#
# It deliberately does NOT run pnpm: a local junction is enough for Node's
# resolver, so installing cannot touch the network, the lockfile, or the
# user's proxy settings. Uninstall (uninstall.ps1) reverses exactly these steps.
#
# Usage:
#   pwsh -File install.ps1                        # default profile: desktop
#   pwsh -File install.ps1 -Profile web
#   pwsh -File install.ps1 -RestartHint           # print what to do next

param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$RestartHint
)

$ErrorActionPreference = 'Stop'

$packageName = 'dsh-proxy-switcher'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $DshHome "profiles\$Profile"
$packageJson = Join-Path $profileDir 'package.json'
$target = Join-Path $profileDir "node_modules\$packageName"
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

if (-not (Test-Path $packageJson)) { throw "no profile at '$profileDir' (expected $packageJson)" }
if (-not (Test-Path (Join-Path $sourceDir 'lib\index.js'))) { throw "'$sourceDir' does not look like the plugin (lib/index.js is missing)" }

Write-Host "Installing $packageName" -ForegroundColor Cyan
Write-Host "  from    : $sourceDir"
Write-Host "  profile : $profileDir"

# ---- 1. back up the profile's package.json --------------------------------
$backup = "$packageJson.bak-before-$packageName-$stamp"
Copy-Item $packageJson $backup -Force
Write-Host "  backup  : $backup"

# ---- 2. junction the package into the profile -----------------------------
$nodeModules = Split-Path -Parent $target
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
if (Test-Path $target) { Remove-Item $target -Force -Recurse }
cmd /c mklink /J "$target" "$sourceDir" | Out-Null
if (-not (Test-Path (Join-Path $target 'lib\index.js'))) { throw "the junction at '$target' is not readable" }
Write-Host "  linked  : $target -> $sourceDir"

# ---- 3. register the dependency and the bundle ----------------------------
$json = Get-Content $packageJson -Raw | ConvertFrom-Json
if ($null -eq $json.dependencies) {
  $json | Add-Member -MemberType NoteProperty -Name dependencies -Value (New-Object psobject)
}
$dependencyValue = "link:$($sourceDir -replace '\\','/')"
if ($json.dependencies.PSObject.Properties.Name -contains $packageName) {
  $json.dependencies.$packageName = $dependencyValue
} else {
  $json.dependencies | Add-Member -MemberType NoteProperty -Name $packageName -Value $dependencyValue
}

if ($null -eq $json.dsh -or $null -eq $json.dsh.profile -or $null -eq $json.dsh.profile.bundles) {
  throw "profile package.json has no dsh.profile.bundles list; add it by hand and re-run"
}
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains $packageName) { $bundles += $packageName }
$json.dsh.profile.bundles = $bundles

$json | ConvertTo-Json -Depth 32 | Set-Content $packageJson -Encoding UTF8
Write-Host "  updated : $packageJson (dependency + dsh.profile.bundles)"

# ---- 4. what happens next -------------------------------------------------
Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "The plugin mounts as a bundle row, so dsh must reload the loader for it to appear."
Write-Host 'After that you will find it at Settings -> Proxy.' -ForegroundColor Cyan
Write-Host 'Until then nothing changes: the plugin is inert files on disk.'
if ($RestartHint) {
  Write-Host ''
  Write-Host 'To roll back completely:  pwsh -File uninstall.ps1 -Profile ' -NoNewline
  Write-Host $Profile
}
