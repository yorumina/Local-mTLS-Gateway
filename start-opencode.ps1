$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath '.env.local')) {
  throw 'Missing .env.local. Copy .env.example to .env.local and configure it outside version control.'
}

npm run check
node --env-file=.env.local scripts/start-opencode.mjs @args

