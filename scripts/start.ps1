$ErrorActionPreference='Stop'
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/setup.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/compose.ps1" up --build -d --wait --wait-timeout 240
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/seed.ps1"
exit $LASTEXITCODE
