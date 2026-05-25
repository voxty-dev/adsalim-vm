#!/usr/bin/env pwsh
# Sync the vm-service folder to the public voxty-dev/adsalim-vm repo.
# Coolify pulls from that repo, but our edits live in voxty-dev/adsalim.
# Run from anywhere; the script handles cloning + pushing.
#
# Usage: pwsh ./sync-to-public-repo.ps1

$ErrorActionPreference = "Stop"

$VmRepo = "https://github.com/voxty-dev/adsalim-vm.git"
$SourceDir = "C:\Users\Nitropc\Documents\adsalim\vm-service"
$WorkDir = Join-Path $env:TEMP "adsalim-vm-sync"

if (-not $env:GITHUB_TOKEN) {
    Write-Host "ERROR: set `$env:GITHUB_TOKEN to a GitHub PAT with repo scope." -ForegroundColor Red
    Write-Host "Example:  `$env:GITHUB_TOKEN = 'ghp_xxxxxxxxxxx'" -ForegroundColor Yellow
    exit 1
}

$RemoteUrl = "https://voxty-dev:${env:GITHUB_TOKEN}@github.com/voxty-dev/adsalim-vm.git"

Write-Host "→ Cleaning $WorkDir" -ForegroundColor Cyan
if (Test-Path $WorkDir) {
    Remove-Item -Recurse -Force $WorkDir
}

Write-Host "→ Cloning $VmRepo" -ForegroundColor Cyan
git clone $RemoteUrl $WorkDir
Set-Location $WorkDir

Write-Host "→ Removing old files (keep .git)" -ForegroundColor Cyan
Get-ChildItem -Force -Exclude ".git" | Remove-Item -Recurse -Force

Write-Host "→ Copying fresh files from $SourceDir" -ForegroundColor Cyan
Copy-Item -Recurse "$SourceDir\*" .

# Don't push the sync script itself — it has paths specific to local dev.
if (Test-Path "sync-to-public-repo.ps1") {
    Remove-Item -Force "sync-to-public-repo.ps1"
}

Write-Host "→ Committing + pushing" -ForegroundColor Cyan
git add -A
$msg = "Sync from main repo $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$diff = git diff --cached --stat
if (-not $diff) {
    Write-Host "Nothing to push." -ForegroundColor Yellow
    exit 0
}
git commit -m $msg
git push

Write-Host "✓ Done. Trigger Redeploy in Coolify." -ForegroundColor Green
