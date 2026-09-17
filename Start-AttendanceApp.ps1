[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8765,
  [switch]$NoBrowser,
  [switch]$CheckOnly,
  [switch]$SkipBackendCheck,
  [string]$BackendUrl = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$ServerScript = Join-Path $ProjectRoot 'local_server.py'
$StateFile = Join-Path $ProjectRoot '.git\attendance-launch-state.json'
$AppUrl = "http://127.0.0.1:$Port/index.html"

function Get-RequiredFileHash {
  param([string[]]$RelativePaths)

  $entries = foreach ($relativePath in $RelativePaths) {
    $path = Join-Path $ProjectRoot $relativePath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      "${relativePath}:$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)"
    } elseif (Test-Path -LiteralPath $path -PathType Container) {
      Get-ChildItem -LiteralPath $path -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relativeFile = $_.FullName.Substring($ProjectRoot.Length).TrimStart('\', '/').Replace('\', '/')
        "${relativeFile}:$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
      }
    } else {
      throw "Ficheiro obrigatório em falta: $relativePath"
    }
  }

  $combined = [string]::Join([Environment]::NewLine, $entries)
  return (Get-FileHash -InputStream ([System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($combined))) -Algorithm SHA256).Hash
}

function Get-PreviousState {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Save-CurrentState {
  param([hashtable]$State)
  $State | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding utf8
}

function Find-Python {
  foreach ($commandName in @('python', 'py')) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  throw 'Python não foi encontrado. Instale Python 3 ou adicione-o ao PATH.'
}

function Stop-PreviousAppServers {
  $serverPattern = [regex]::Escape($ServerScript)
  $portPattern = "(?:^|\s)--port\s+$Port(?:\s|$)"
  $processes = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('python.exe', 'pythonw.exe') -and
    $_.CommandLine -match $serverPattern -and
    $_.CommandLine -match $portPattern
  }

  foreach ($process in $processes) {
    Write-Host "A terminar a instância anterior da app (PID $($process.ProcessId))."
    Stop-Process -Id $process.ProcessId -Force
  }
}

function Test-Backend {
  $backendUrl = $BackendUrl.Trim()
  if (-not $backendUrl) {
    $index = Get-Content -LiteralPath (Join-Path $ProjectRoot 'index.html') -Raw
    $match = [regex]::Match($index, "const DEFAULT_BACKEND_URL = '([^']+)'")
    if (-not $match.Success) {
      Write-Warning 'Não foi possível encontrar o URL predefinido do Apps Script.'
      return
    }
    $backendUrl = $match.Groups[1].Value
  }

  try {
    # Windows PowerShell 5.1 can otherwise negotiate an obsolete TLS version with Google.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $separator = if ($backendUrl.Contains('?')) { '&' } else { '?' }
    $uri = "$backendUrl$separator" + 'action=state'
    $result = Invoke-RestMethod -Uri $uri -TimeoutSec 35
    if ($result.ok -eq $true) {
      Write-Host "Backend disponível: $(@($result.classes).Count) turma(s) encontrada(s)."
    } else {
      Write-Warning "O Apps Script respondeu com erro: $($result.error)"
    }
  } catch {
    Write-Warning "Não foi possível confirmar o Apps Script. A app local inicia na mesma, mas as turmas podem não carregar."
  }
}

$currentState = @{
  appHash = Get-RequiredFileHash @('index.html', 'manifest.webmanifest', 'assets')
  backendHash = Get-RequiredFileHash @('ScriptForSheets')
  mediaHash = Get-RequiredFileHash @('photo-worker.js', 'wrangler.jsonc')
  checkedAt = (Get-Date).ToString('o')
}
$previousState = Get-PreviousState

if (-not $previousState) {
  Write-Host 'Primeira verificação local: serão usados todos os ficheiros atuais.'
} else {
  if ($previousState.appHash -ne $currentState.appHash) {
    Write-Host 'Atualização detetada na app. Esta execução usa a versão atual; publique os ficheiros estáticos quando estiver pronta.'
  }
  if ($previousState.backendHash -ne $currentState.backendHash) {
    Write-Warning 'Atualização detetada no Apps Script. Copie ScriptForSheets para o Google Apps Script e publique uma nova versão antes de usar dados partilhados.'
  }
  if ($previousState.mediaHash -ne $currentState.mediaHash) {
    Write-Warning 'Atualização detetada no Worker/R2. Faça deploy do Worker antes de usar fotografias próprias.'
  }
}

if (-not $SkipBackendCheck) { Test-Backend }
if ($CheckOnly) {
  Write-Host 'Verificação concluída. O servidor não foi iniciado.'
  exit 0
}

Stop-PreviousAppServers
$python = Find-Python
$process = Start-Process -FilePath $python -ArgumentList @($ServerScript, '--port', $Port) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $response = Invoke-WebRequest -Uri $AppUrl -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
}

if (-not $ready) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  throw "A app não iniciou em $AppUrl."
}

Save-CurrentState $currentState
Write-Host "App iniciada em $AppUrl (PID $($process.Id))."
if (-not $NoBrowser) { Start-Process $AppUrl }
