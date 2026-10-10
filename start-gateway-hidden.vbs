Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' Node's fetch ignores HTTP(S)_PROXY unless this is set before the process starts.
shell.Environment("Process")("NODE_USE_ENV_PROXY") = "1"
' The gateway and its backend only reach their upstreams through the user's
' proxy (poisoned LAN DNS); if this launcher's parent shell lacks the vars,
' pull them from the registry user environment.
For Each name In Array("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY")
  If shell.Environment("Process")(name) = "" Then
    value = ""
    On Error Resume Next
    value = shell.RegRead("HKCU\Environment\" & name)
    On Error Goto 0
    If value <> "" Then shell.Environment("Process")(name) = value
  End If
Next
node = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  node = """C:\Program Files\nodejs\node.exe"""
End If
shell.Run node & " """ & here & "\src\standalone.ts""", 0, False
