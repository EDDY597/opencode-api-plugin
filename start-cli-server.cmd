@echo off
REM Start the opencode CLI backing server (OpenAI-compatible) on 127.0.0.1:18080.
REM
REM OpenCode's free models are gated on the official client: they cannot be reached over
REM HTTP with an API key (a valid oc_sk_ key gets FreeUsageLimitError), but `opencode run`
REM works even with no credentials at all. This server drives that CLI, so the DSH plugin
REM (which talks to 18080 by default) and the gateway's `free` upstream both get real free
REM models again.
REM
REM Port 18080 is deliberate: it is the plugin's default `free.serviceUrl`. Whichever
REM service holds that port wins, so start THIS before DeepSeek Harness, otherwise the
REM plugin manages the Go opencode2api on the same port and its /inference pool answers 429.
REM
REM   start-cli-server.cmd            interactive (keeps the window open on exit)
REM   start-cli-server.cmd --quiet    no pause, for the hidden launcher / autostart
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
REM KEEP the proxy variables. Clearing HTTP(S)_PROXY makes every request fail on this
REM machine: reaching opencode.ai needs the local proxy, and without it the CLI dies with a
REM misleading "Unknown: FileSystem.open (...\log\opencode.log)" instead of a network error.
REM If this shell lacks them, read them from the registry user environment.
for %%n in (HTTPS_PROXY HTTP_PROXY NO_PROXY) do if not defined %%n call :fromreg %%n
REM --config reuses bin\config.json's server_keys: the DSH plugin reads server_keys[0] and
REM sends it as a Bearer token, so both sides agree without extra configuration.
REM
REM --models mirrors the DSH plugin's free.models menu (bare ids, no "opencode/" prefix).
REM The plugin feeds /v1/models straight into its menu, so the advertised ids must match
REM what it configured or the card reports an empty model list.
set "CLI_MODELS=big-pickle,deepseek-v4.1-flash-free,glm-5.3-flash-free,mimo-v2.6-flash-free,nemotron-3.5-super-vl-free"
node "%~dp0src\cli-server.ts" --port 18080 --config "%~dp0bin\config.json" --model "opencode/big-pickle" --models "%CLI_MODELS%" --opencode-path "E:\STUDY\IT\nodejs\node_global\opencode.cmd"
if /i not "%~1"=="--quiet" pause
goto :eof

:fromreg
for /f "tokens=2*" %%a in ('reg query HKCU\Environment /v %1 2^>nul') do if /i "%%a"=="REG_SZ" set "%1=%%b"
goto :eof
