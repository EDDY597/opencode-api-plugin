@echo off
REM Stop the LLM gateway listening on the configured port (default 8787).
REM Optional arg: port number, e.g. stop-gateway.cmd 8900
cd /d "%~dp0"
set "PORT_ARG=%~1"
if defined PORT_ARG (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-gateway.ps1" -Port %PORT_ARG%
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-gateway.ps1"
)
echo.
pause
