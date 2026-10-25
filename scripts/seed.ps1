$ErrorActionPreference='Stop'
foreach ($service in @('identity','menu','reservation','order','staff','schedule','inventory','payment')) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/compose.ps1" exec -T ($service + '-service') node scripts/seed-service.mjs $service
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/compose.ps1" exec -T identity-service node scripts/seed-orders.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Demo seed completed. No payment transaction was created.'
