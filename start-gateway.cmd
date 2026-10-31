@echo off
cd /d "%~dp0"
REM Node >= 22 is required to run TypeScript natively.
REM Prefer the machine-wide install so an old Node on PATH does not break the start.
set "PATH=C:\Program Files\nodejs;%PATH%"
set "NODE_USE_ENV_PROXY=1"
REM DIRECT, NOT PROXIED (2026-10-31). This launcher used to pull HTTP(S)_PROXY out of
REM HKCU\Environment because the host's LAN DNS was thought to be poisoned. Measured
REM since:
REM   zen/go/v1       direct 200 / 1s, and every go/ call in gateway-debug.log came
REM                   back 200 in 2-7s over a direct connection
REM   zen free tier   oc2api dials directly by design (uTLS). A proxy variable only
REM                   leaked into its /ip probe, which then reported the PROXY exit
REM                   (66.90.98.34) instead of the real one -- and made the free tier
REM                   look pinned to an egress that had nothing to do with it.
REM So the proxy is cleared here instead of inherited: whatever is still set in this
REM shell (or in the registry) is removed for the gateway and every process it starts.
REM /ip reports the true direct egress, and oc2api can never be pointed at a dead port.
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
set "NO_PROXY="
set "no_proxy="
REM Free lane: the gateway itself starts and stops src\cli-server.ts on port 18080 (see
REM src\free-lane.ts). That binding is deliberate — the DSH plugin only registers free
REM models if 18080 answers when the plugin loads, and a separate autostart entry kept
REM losing that race. Do not start the lane here as well: the gateway reuses an existing
REM listener, but two launchers fighting over the port is exactly what we removed.
node "%~dp0src\standalone.ts"
pause
goto :eof

