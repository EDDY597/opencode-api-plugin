' Start the free-lane supervisor with no console window.
'
' This is what the HKCU Run entry points at. It is the single entry point at logon:
'   Run key -> this script (hidden) -> free-lane-supervisor.cmd -> start-cli-server-hidden.vbs
' so the CLI server is listening on 18080 before DeepSeek Harness loads the plugin, and is
' restarted if it ever goes away.
'
' A scheduled task would be tidier, but creating one needs elevation and this profile runs
' without it; the Run key achieves the same thing without a console window.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' 0 = hidden window, False = do not wait for completion.
shell.Run "cmd /c " & scriptDir & "\free-lane-supervisor.cmd", 0, False
