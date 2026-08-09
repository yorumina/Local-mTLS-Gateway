$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env.local')) {
  throw 'Missing .env.local. Copy .env.example to .env.local and configure it outside version control.'
}

npm run check

try {
  $ready = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/readyz' -TimeoutSec 2
  if ($ready.StatusCode -eq 200) {
    return
  }
}
catch {
  # No ready loopback sidecar is running; start it below.
}

if ([string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) {
  $env:NODE_OPTIONS = '--use-system-ca'
}
elseif ($env:NODE_OPTIONS -notmatch '(^|\s)--use-system-ca(\s|$)') {
  $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --use-system-ca"
}

node --env-file=.env.local src/server.mjs
