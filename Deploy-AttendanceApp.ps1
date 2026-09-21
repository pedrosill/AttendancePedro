[CmdletBinding()]
param(
  [switch]$SkipDatabase,
  [switch]$SkipPhotos,
  [switch]$SkipStatic
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Assert-WorkerName {
  param(
    [string]$ConfigPath,
    [string]$ExpectedName
  )

  $config = Get-Content -LiteralPath (Join-Path $root $ConfigPath) -Raw | ConvertFrom-Json
  if ($config.name -ne $ExpectedName) {
    throw "$ConfigPath tem o nome '$($config.name)'. Esperado: '$ExpectedName'. Deploy interrompido para proteger os Workers."
  }
}

Assert-WorkerName 'data-wrangler.jsonc' 'attendance-pedro-data'
Assert-WorkerName 'wrangler.jsonc' 'attendance-pedro-media'
Assert-WorkerName 'static-wrangler.jsonc' 'attendance-pedro'

Write-Host 'Configurações dos três Workers confirmadas.' -ForegroundColor Green
node --check attendance-data-worker.js
node --check photo-worker.js
node --test tests/attendance.test.js

if (-not $SkipDatabase) {
  Write-Host 'A aplicar migrações D1...' -ForegroundColor Cyan
  npx wrangler d1 migrations apply attendance-pedro-data --remote --config .\data-wrangler.jsonc
  Write-Host 'A publicar o Worker D1...' -ForegroundColor Cyan
  npx wrangler deploy --config .\data-wrangler.jsonc
}

if (-not $SkipPhotos) {
  Write-Host 'A publicar o Worker de fotografias...' -ForegroundColor Cyan
  npx wrangler deploy --config .\wrangler.jsonc
}

if (-not $SkipStatic) {
  Write-Host 'A preparar os assets públicos...' -ForegroundColor Cyan
  New-Item -ItemType Directory -Path .\public\assets\avatars -Force | Out-Null
  Copy-Item .\index.html, .\Logo1.png, .\LogoAppSCP.png, .\manifest.webmanifest -Destination .\public\ -Force
  Copy-Item .\assets\avatars\*.png -Destination .\public\assets\avatars\ -Force
  Write-Host 'A publicar a app estática por último...' -ForegroundColor Cyan
  npx wrangler deploy --config .\static-wrangler.jsonc
}

Write-Host ''
Write-Host 'Deploy concluído sem misturar Workers.' -ForegroundColor Green
Write-Host 'App:       https://attendance-pedro.pedrosill1944.workers.dev/'
Write-Host 'Dados:     https://attendance-pedro-data.pedrosill1944.workers.dev/'
Write-Host 'Fotografias: https://attendance-pedro-media.pedrosill1944.workers.dev/'
