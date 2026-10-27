@echo off
cd /d "%~dp0"
REM Node >= 22 is required to run TypeScript natively.
REM Prefer the machine-wide install so an old Node on PATH does not break the start.
set "PATH=C:\Program Files\nodejs;%PATH%"
set "NODE_USE_ENV_PROXY=1"
REM The gateway and its backend only reach their upstreams through the user's
REM proxy (poisoned LAN DNS); if this shell lacks the vars, read them from the
REM registry user environment.
for %%n in (HTTPS_PROXY HTTP_PROXY NO_PROXY) do if not defined %%n call :fromreg %%n
REM Free lane: the gateway itself starts and stops src\cli-server.ts on port 18080 (see
REM src\free-lane.ts). That binding is deliberate — the DSH plugin only registers free
REM models if 18080 answers when the plugin loads, and a separate autostart entry kept
REM losing that race. Do not start the lane here as well: the gateway reuses an existing
REM listener, but two launchers fighting over the port is exactly what we removed.
node "%~dp0src\standalone.ts"
pause
goto :eof

:fromreg
for /f "tokens=2*" %%a in ('reg query HKCU\Environment /v %1 2^>nul') do if /i "%%a"=="REG_SZ" set "%1=%%b"
goto :eof
