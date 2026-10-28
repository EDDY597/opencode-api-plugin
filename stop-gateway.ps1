# Stop the LLM gateway started by start-gateway.cmd / start-gateway-hidden.vbs / the tray.
# taskkill /F /T kills the whole tree, which since 2026-10-28 also covers both free lanes:
# bin\oc2api.exe (18090) and src\cli-server.ts (18080) are spawned by the gateway, so they
# die with it. The tray watches the gateway over /health, so it closes itself shortly after.
#
# The per-port sweep at the bottom is now a leftover guard: it catches a lane started by
# hand (or by an older gateway) that is not inside this tree. It matches on the executable
# and script name, so an unrelated listener on that port is never touched.
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

# Free lane: stop whichever service owns the free port. It may be the Go opencode2api
# (bin\config.json "listen") or the CLI server (src\cli-server.ts) — both use 18080
# because that is what the DSH plugin expects. Match on the executable/script name so a
# stray unrelated listener on that port is never killed.
$freePort = 18080
$freeCfg = Join-Path $Root 'bin\config.json'
if (Test-Path -LiteralPath $freeCfg) {
  try {
    $fcfg = Get-Content -LiteralPath $freeCfg -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($fcfg.listen) { $freePort = [int]$fcfg.listen.Split(':')[-1] }
  } catch { }
}
foreach ($p in @(Get-ListenPids $freePort | Where-Object { $_ -and $_ -ne $PID })) {
  $cmdline = ''
  try { $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine } catch { }
  $isFreeLane = $cmdline -match 'opencode2api' -or $cmdline -match 'cli-server\.ts' -or $cmdline -match 'cli-server\.m?js'
  if (-not $isFreeLane) {
    Write-Output ('Left pid {0} on port {1} alone (not the free lane).' -f $p, $freePort)
    continue
  }
  $null = taskkill /F /T /PID $p
  if ($LASTEXITCODE -eq 0) {
    Write-Output ('Killed the free-lane service (pid {0}) on port {1}.' -f $p, $freePort)
  } else {
    Write-Warning ('taskkill failed for the free-lane pid {0} - access denied? Try an elevated shell.' -f $p)
  }
}
exit 0
