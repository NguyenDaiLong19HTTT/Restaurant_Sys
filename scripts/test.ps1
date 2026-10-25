$ErrorActionPreference='Stop'
foreach ($service in @('unit-tests','payment-tests','menu-tests','browser-tests')) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/compose.ps1" --profile test run --build --no-deps --rm $service
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
