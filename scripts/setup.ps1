$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  & docker info --format '{{.ServerVersion}}' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop (Linux containers) first.' }
  if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
  $cfg = @{}
  foreach ($line in Get-Content -LiteralPath '.env') {
    if ($line -match '^([A-Z_]+)=(.*)$') { $cfg[$matches[1]]=$matches[2].Trim() }
  }
  $wanted = $cfg['COMPOSE_PROJECT_NAME']
  if ($wanted -notmatch '^[a-z0-9][a-z0-9_-]+$') { throw 'Invalid COMPOSE_PROJECT_NAME in .env.' }
  $webPort = [int]$cfg['WEB_PORT']; $apiPort = [int]$cfg['API_PORT']
  if ($webPort -eq $apiPort -or $webPort -lt 1024 -or $apiPort -lt 1024 -or $webPort -gt 65535 -or $apiPort -gt 65535) { throw 'Choose two distinct ports between 1024 and 65535.' }
  $containers = @(& docker ps -a --format '{{.Names}}')
  $volumes = @(& docker volume ls --format '{{.Name}}')
  $networks = @(& docker network ls --format '{{.Name}}')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Docker resources.' }
  if (Test-Path -LiteralPath '.local/stack.json') {
    $saved = Get-Content -LiteralPath '.local/stack.json' -Raw | ConvertFrom-Json
    if ($saved.webPort -ne $webPort -or $saved.apiPort -ne $apiPort) { throw 'Existing .local configuration: keep its ports in .env. Do not replace secrets for an existing database.' }
    foreach ($secret in @('root-password','identity-db','menu-db','payment-db','order-db','reservation-db','inventory-db','staff-db','schedule-db','service-token','login-password','jwt-private.pem','jwt-public.pem')) {
      if (!(Test-Path -LiteralPath ('.local/' + $secret))) { throw ('Missing saved secret: ' + $secret + '. Restore your local backup; do not rotate a database password automatically.') }
    }
    Write-Host ('Reuse own saved project: ' + $saved.project)
  } else {
    $project = $wanted; $n=2
    while (@($containers | Where-Object { $_ -like ($project + '-*') }).Count -or @($volumes | Where-Object { $_ -like ($project + '_*') }).Count -or @($networks | Where-Object { $_ -like ($project + '_*') }).Count) {
      $project=$wanted + '-' + $n; $n++
    }
    foreach ($port in @($webPort,$apiPort)) {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$port)
      try { $listener.Start() } catch { throw ('Port ' + $port + ' is busy. Change WEB_PORT/API_PORT in .env and rerun. No stack has been started.') } finally { $listener.Stop() }
    }
    New-Item -ItemType Directory -Path '.local' -Force | Out-Null
    @{containers=$containers;volumes=$volumes;networks=$networks} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath '.local/docker-baseline.json' -Encoding UTF8
    @{project=$project;webPort=$webPort;apiPort=$apiPort} | ConvertTo-Json | Set-Content -LiteralPath '.local/stack.json' -Encoding ASCII
    Write-Host ('Selected isolated project: ' + $project)
  }
  # Only after resource/port checks: a temporary Node helper generates local secrets.
  $root=(Get-Location).Path
  & docker run --rm --network none --mount ('type=bind,source=' + $root + ',target=/workspace') --workdir /workspace node:24-bookworm-slim node scripts/generate-secrets.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Secret/configuration generation failed.' }
} finally { Pop-Location }
