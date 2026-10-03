Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
node = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  node = """C:\Program Files\nodejs\node.exe"""
End If
shell.Run node & " """ & here & "\src\standalone.ts""", 0, False
