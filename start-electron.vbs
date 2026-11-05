' ============================================================
'  Artflow desktop launcher (no console window at all)
'  Double-click this file to start the desktop app.
'
'  Pair: start-electron.cmd is the same launcher *with* a visible console
'  (debug entry point: shows Electron main-process logs live).
'  This .vbs is the silent one. The desktop shortcut points HERE.
'
'  NAMING IS LOAD-BEARING: this file name is exactly 18 characters, the same
'  length as "start-electron.cmd". The desktop shortcut is a Shell Link whose
'  target lives in FOUR places (IDList ANSI + IDList UTF-16 + LinkInfo
'  LocalBasePath + StringData RELATIVE_PATH); it was retargeted with an
'  equal-length byte patch so that no length field had to be rewritten.
'  Rename this file to a different length and the shortcut breaks silently.
'  (See scratch/2026-10-09_launch-ux/patch-shortcut.cjs.)
'
'  Chain:
'    this .vbs (wscript, no console)
'      -> node scripts\launch-desktop.cjs (console hidden by window style 0)
'           -> Vite dev server on port 4002 (console hidden, logs\vite.log)
'           -> Electron main window (GUI process, no console, logs\electron.log)
'
'  ENCODING: keep this file ASCII-only AND CRLF. wscript parses .vbs with the
'  system ANSI code page, so UTF-8 Chinese here shows up as mojibake; and while
'  the parser happens to tolerate bare LF, CRLF is what every Windows tool
'  expects. Both were wrong once and the shortcut silently did nothing.
' ============================================================
Option Explicit


Dim sh, fso, root, launcher, nodeExe, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = root & "\scripts\launch-desktop.cjs"

If Not fso.FileExists(launcher) Then
  MsgBox "Launcher not found:" & vbCrLf & launcher, vbCritical, "Artflow"
  WScript.Quit 1
End If

nodeExe = FindNode()
If nodeExe = "" Then
  MsgBox "Node.js (>= 22.5) was not found on this machine." & vbCrLf & _
         "Install Node.js, then double-click this file again.", vbCritical, "Artflow"
  WScript.Quit 1
End If

' window style 0 = hidden console for node.exe (a console app).
' It does NOT hide the Electron window: verified that Electron starts a
' visible main window even when its parent runs with a hidden console.
code = sh.Run("""" & nodeExe & """ """ & launcher & """", 0, True)

If code <> 0 Then
  MsgBox "Artflow failed to start (exit code " & code & ")." & vbCrLf & vbCrLf & _
         "See logs\launcher.log for details.", vbExclamation, "Artflow"
End If

WScript.Quit code

' Prefer the standard install locations, then fall back to scanning PATH.
Function FindNode()
  Dim candidates, parts, i
  FindNode = ""

  candidates = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
    sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node.exe", _
    "C:\Program Files\nodejs\node.exe")

  For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
      FindNode = candidates(i)
      Exit Function
    End If
  Next

  parts = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  For i = 0 To UBound(parts)
    If Len(Trim(parts(i))) > 0 Then
      If fso.FileExists(Trim(parts(i)) & "\node.exe") Then
        FindNode = Trim(parts(i)) & "\node.exe"
        Exit Function
      End If
    End If
  Next
End Function
