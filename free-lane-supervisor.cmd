@echo off
REM Keep the CLI free-lane server alive on 127.0.0.1:18080.
REM
REM Why a supervisor instead of a one-shot start: the DSH plugin auto-manages port 18080
REM (free.mode "service", free.serviceUrl http://127.0.0.1:18080, manageService true). If
REM nothing answers /healthz when the harness boots, the plugin tries to manage that port
REM itself. An autostart entry alone loses that race, so this loop makes sure the CLI server
REM is the one holding it.
REM
REM QUOTA SAFETY: this loop only ever calls /healthz on 127.0.0.1 and /v1/models is never
REM touched. The CLI server answers /healthz from a static JSON body without invoking a
REM model, and nothing here runs on a timer that reaches upstream. Free quota is spent only
REM when a real chat request arrives.
REM
REM Once the lane is healthy the loop sleeps for 5 minutes instead of seconds, so the
REM steady-state cost is two local probes per 5 minutes ?no upstream traffic at all.
REM
REM It only stops a listener whose command line is opencode2api.exe, and that binary has
REM been deleted; the check stays as a guard against an old copy being started manually.
cd /d "%~dp0"

set "PROBE_INTERVAL_OK=60"
set "PROBE_INTERVAL_DOWN=10"

:loop
REM Is the CLI server already serving? /healthz reports backend "opencode-cli".
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18080/healthz' -TimeoutSec 3 -UseBasicParsing; if ($r.Content -match 'opencode-cli') { exit 0 } else { exit 2 } } catch { exit 1 }"
if %errorlevel%==0 goto healthy

REM Something else owns the port. Displace it only when it is the old Go opencode2api.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 18080 -State Listen -ErrorAction SilentlyContinue; if (-not $c) { exit 0 }; foreach ($p in ($c | Select-Object -ExpandProperty OwningProcess -Unique)) { $ci = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p) -ErrorAction SilentlyContinue; if ($ci -and $ci.CommandLine -match 'opencode2api\.exe') { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }"
ping -n 2 127.0.0.1 >nul

REM Start the server through the hidden launcher: a WinScript host with window style 0
REM creates no console at all, whereas `cmd /c start /min` still flashes a window.
REM Routing through `cmd /c` inside that VBS is required ??WScript.Shell.Run cannot start a
REM .cmd directly on this machine.
wscript "%~dp0start-cli-server-hidden.vbs"
ping -n %PROBE_INTERVAL_DOWN% 127.0.0.1 >nul
goto loop

:healthy
ping -n %PROBE_INTERVAL_OK% 127.0.0.1 >nul
goto loop
