$ErrorActionPreference='Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try { & docker compose --env-file .local/compose.env --file compose.yaml @args; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE} } finally {Pop-Location}
