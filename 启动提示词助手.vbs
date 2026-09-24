' 双击本脚本即可后台启动「提示词助手」（无控制台窗口）
' 使用脚本自身所在目录，拷贝到任何位置均可运行
Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = dir
ws.Run """" & dir & "\node_modules\.bin\electron.cmd"" """ & dir & """", 0, False
