Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' Node's fetch ignores HTTP(S)_PROXY unless this is set before the process starts.
shell.Environment("Process")("NODE_USE_ENV_PROXY") = "1"
' DIRECT, NOT PROXIED (2026-10-31). This launcher used to pull HTTP(S)_PROXY from
' HKCU\Environment. Measured since: zen/go/v1 answers direct 200 / 1s and every go/
' call in gateway-debug.log returned 200 in 2-7s over a direct connection, while a
' proxy variable only leaked into oc2api's /ip probe -- which then reported the PROXY
' exit (66.90.98.34) instead of the real egress and made the free tier look pinned
' to an address it never used. Clear the variables for the gateway and everything it
' spawns so /ip always reports the true direct egress.
For Each name In Array("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy")
  shell.Environment("Process").Remove name
Next
node = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  node = """C:\Program Files\nodejs\node.exe"""
End If
' Free lane: the gateway owns every local lane itself now (src\standalone.ts starts
' bin\oc2api.exe on 18090 and src\cli-server.ts on 18080; see "lanes" in
' gateway.config.json). Start nothing here. This script used to launch
' bin\opencode2api.exe, which no longer exists, so that step could only fail
' silently right before the gateway started the real lane anyway.
shell.Run node & " """ & here & "\src\standalone.ts""", 0, False
