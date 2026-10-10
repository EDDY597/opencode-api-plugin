' Launches the LLM Gateway tray supervisor hidden (no console window).
' The tray attaches to a running gateway or spawns one - unlike
' start-gateway-hidden.vbs, which runs the gateway bare with no supervision.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
' Node's fetch ignores HTTP(S)_PROXY unless set before the process starts; the
' gateway inherits the environment from the tray.
shell.Environment("Process")("NODE_USE_ENV_PROXY") = "1"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\tray\tray.ps1""", 0, False
