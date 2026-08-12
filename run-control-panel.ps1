$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env.local')) {
  throw 'Missing .env.local. Configure it locally before starting the Control Panel.'
}

npm run check

if ([string]::IsNullOrWhiteSpace($env:NODE_OPTIONS)) {
  $env:NODE_OPTIONS = '--use-system-ca'
}
elseif ($env:NODE_OPTIONS -notmatch '(^|\s)--use-system-ca(\s|$)') {
  $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --use-system-ca"
}

node --env-file=.env.local scripts/start-control-panel.mjs
