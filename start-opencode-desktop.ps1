$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env.local')) {
  throw 'Missing .env.local. Configure it locally before launching OpenCode Desktop.'
}

npm run check
$env:NODE_OPTIONS = '--use-system-ca'
$env:OPENCODE_CONFIG = Join-Path $projectRoot 'opencode.json'
node --env-file=.env.local scripts/start-opencode-desktop.mjs
