# Stop the LLM gateway started by start-gateway.cmd / start-gateway-hidden.vbs / the tray.
# taskkill /F /T kills the whole tree, so the node runtime and the embedded
# "opencode serve" backend (its child process) both go down. The tray watches the
# gateway over /health, so it closes itself shortly after the kill.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File stop-gateway.ps1 [port]
#   stop-gateway.cmd           (same, plus a pause so a double-click window stays open)

param(
  # Overrides port detection (OPENCODE_GO_GATEWAY_PORT env -> gateway.config.json "port" -> 8787).
  [int]$Port = 0
)

$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-ListenPids([int]$listenPort) {
  $found = @()
  try {
    # Scope to LISTEN so curl/clients with open connections are never killed.
    $conns = Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue
    if ($conns) { $found = @($conns | Select-Object -ExpandProperty OwningProcess -Unique) }
    return $found
  } catch { }
  # Fallback for hosts without Get-NetTCPConnection (try/catch above does not fire
  # for a missing cmdlet in PS 5.1, hence the second netstat probe).
  foreach ($line in (netstat -ano | Select-String (':' + $listenPort + '\s'))) {
    if ($line -match 'LISTENING\s+(\d+)\s*$') { $found += [int]$Matches[1] }
  }
  return @($found | Select-Object -Unique)
}

if (-not $Port) {
  if ($env:OPENCODE_GO_GATEWAY_PORT) { try { $Port = [int]$env:OPENCODE_GO_GATEWAY_PORT } catch { } }
}
if (-not $Port) {
  $cfgPath = Join-Path $Root 'gateway.config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    try {
      $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.port) { $Port = [int]$cfg.port }
    } catch { }
  }
}
if (-not $Port) { $Port = 8787 }

$targets = @(Get-ListenPids $Port | Where-Object { $_ -and $_ -ne $PID })
if (-not $targets.Count) {
  Write-Output ('Gateway is not running: nothing listens on port {0}.' -f $Port)
  exit 0
}

$failed = @()
foreach ($p in $targets) {
  $name = (Get-Process -Id $p).ProcessName
  if (-not $name) { $name = '<unknown>' }
  $null = taskkill /F /T /PID $p
  if ($LASTEXITCODE -eq 0) {
    Write-Output ('Killed {0} (pid {1}) on port {2}, process tree included.' -f $name, $p, $Port)
  } else {
    Write-Warning ('taskkill failed for pid {0} ({1}) - access denied? Try an elevated shell.' -f $p, $name)
    $failed += $p
  }
}

Start-Sleep -Milliseconds 800
if (@(Get-ListenPids $Port | Where-Object { $_ -and $_ -ne $PID }).Count -gt 0) {
  Write-Warning ('Port {0} is still in use; kill manually: taskkill /F /T /PID <pid>.' -f $Port)
  exit 1
}
if ($failed.Count -gt 0) { exit 1 }
Write-Output ('Gateway stopped (port {0}).' -f $Port)
exit 0
