@echo off
REM Register (or remove) the CLI free-lane server in the user's Run key, so it is already
REM listening on 18080 before DeepSeek Harness starts.
REM
REM Why this is needed: the DSH plugin auto-manages whatever runs on 18080
REM (free.manageService defaults to true). If nothing answers /healthz when DSH boots, the
REM plugin spawns bin\opencode2api.exe itself ??and that lane's /inference pool currently
REM answers 429 "Free usage limit reached". Starting this server first makes the plugin
REM reuse it instead, which is the only lane that still serves free models.
REM
REM Usage:
REM   install-cli-autostart.cmd           register
REM   install-cli-autostart.cmd remove    unregister
cd /d "%~dp0"

set "ENTRY=%~dp0start-cli-server-hidden.vbs"
set "RUNKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "VALUE=opencode-cli-server"

if /i "%~1"=="remove" goto remove

if not exist "%ENTRY%" (
  echo Missing launcher: %ENTRY%
  exit /b 1
)
reg add "%RUNKEY%" /v "%VALUE%" /t REG_SZ /d "\"%ENTRY%\"" /f >nul
if errorlevel 1 (
  echo Failed to write %RUNKEY%
  exit /b 1
)
echo Registered autostart: %VALUE% -^> %ENTRY%
echo It will listen on 127.0.0.1:18080 at next logon.
exit /b 0

:remove
reg delete "%RUNKEY%" /v "%VALUE%" /f >nul 2>nul
echo Removed autostart entry: %VALUE%
exit /b 0
