[CmdletBinding()]
param(
  [switch]$SkipDatabaseDeploy,
  [switch]$SkipStaticDeploy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host 'A validar o código...' -ForegroundColor Cyan
node --check attendance-data-worker.js
node --test tests/attendance.test.js

if (-not $SkipDatabaseDeploy) {
  Write-Host 'A aplicar migrações D1...' -ForegroundColor Cyan
  npx wrangler d1 migrations apply attendance-pedro-data --remote --config data-wrangler.jsonc
  Write-Host 'A publicar o Worker D1...' -ForegroundColor Cyan
  npx wrangler deploy --config data-wrangler.jsonc
}

if (-not $SkipStaticDeploy) {
  Write-Host 'A preparar os assets públicos...' -ForegroundColor Cyan
  New-Item -ItemType Directory -Path .\public\assets\avatars -Force | Out-Null
  Copy-Item .\index.html, .\Logo1.png, .\LogoAppSCP.png, .\manifest.webmanifest -Destination .\public\ -Force
  Copy-Item .\assets\avatars\*.png -Destination .\public\assets\avatars\ -Force
  Write-Host 'A publicar a app estática...' -ForegroundColor Cyan
  npx wrangler deploy --config static-wrangler.jsonc
}

Write-Host 'Publicação concluída.' -ForegroundColor Green
