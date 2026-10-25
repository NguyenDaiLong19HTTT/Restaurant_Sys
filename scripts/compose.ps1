$ErrorActionPreference='Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
$priorProject=$env:COMPOSE_PROJECT_NAME
$priorWeb=$env:WEB_PORT
$priorApi=$env:API_PORT
try {
  $cfg=Get-Content -LiteralPath '.local/stack.json' -Raw | ConvertFrom-Json
  if ($cfg.project -notmatch '^[a-z0-9][a-z0-9_-]+$') { throw 'Invalid saved project name.' }
  # Pin this checkout even if the caller has another project's environment loaded.
  $env:COMPOSE_PROJECT_NAME=$cfg.project
  $env:WEB_PORT=[string]$cfg.webPort
  $env:API_PORT=[string]$cfg.apiPort
  & docker compose --project-name $cfg.project --env-file .local/compose.env --file compose.yaml @args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  $env:COMPOSE_PROJECT_NAME=$priorProject
  $env:WEB_PORT=$priorWeb
  $env:API_PORT=$priorApi
  Pop-Location
}
