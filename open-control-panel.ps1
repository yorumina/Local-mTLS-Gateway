$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$controlUrl = 'http://127.0.0.1:8790'
$ready = $false

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "$controlUrl/api/status" -TimeoutSec 2
  $ready = $response.StatusCode -eq 200
}
catch {}

if (-not $ready) {
  $powerShellExe = Join-Path $PSHOME 'powershell.exe'
  $runScript = Join-Path $projectRoot 'run-control-panel.ps1'
  Start-Process -FilePath $powerShellExe `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $runScript + '"')) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden

  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$controlUrl/api/status" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    }
    catch {}
    Start-Sleep -Milliseconds 250
  }
}

if (-not $ready) { throw 'Control Panel did not become ready within 12 seconds.' }
Start-Process -FilePath $controlUrl
