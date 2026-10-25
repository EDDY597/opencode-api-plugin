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
REM Free lane: the Go opencode2api service (bin\opencode2api.exe, config bin\config.json)
REM serves the "free" upstream on 127.0.0.1:18080. It manages its own proxy exits, so it
REM deliberately runs without the shell's HTTP(S)_PROXY. Reuse an instance already listening.
netstat -ano | findstr ":18080" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 start "opencode2api" /min cmd /c ""%~dp0bin\opencode2api.exe" -config "%~dp0bin\config.json""
node "%~dp0src\standalone.ts"
pause
goto :eof

:fromreg
for /f "tokens=2*" %%a in ('reg query HKCU\Environment /v %1 2^>nul') do if /i "%%a"=="REG_SZ" set "%1=%%b"
goto :eof
