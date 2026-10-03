@echo off
cd /d "%~dp0"
REM Node >= 22 is required to run TypeScript natively.
REM Prefer the machine-wide install so an old Node on PATH does not break the start.
set "PATH=C:\Program Files\nodejs;%PATH%"
node "%~dp0src\standalone.ts"
pause
