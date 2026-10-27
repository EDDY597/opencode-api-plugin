' Start the CLI free-lane server with no console window at all.
'
' This is what a logon scheduled task runs. Two constraints shaped it:
'
' 1. `WScript.Shell.Run` cannot start a .cmd directly here — the call returns without
'    anything happening. Routing through `cmd /c` is what actually executes it.
' 2. The repo path has no spaces, so no quoting is needed after `cmd /c`. Earlier versions
'    wrapped it in escaped quotes that cmd.exe then parsed into an invalid command.
'
' Why the CLI server must hold 18080 before DeepSeek Harness boots: the DSH plugin
' registers its free-tier provider only once its loopback listener is up, and that waits on
' the service at 18080 being healthy. Starting this at logon wins that race.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' 0 = hidden window, False = do not wait for completion.
shell.Run "cmd /c " & scriptDir & "\start-cli-server.cmd --quiet", 0, False
