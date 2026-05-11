; NSIS Installer Script for Sentinel Browser
; 自动安装 VC++ Redistributable 和其他依赖

!include "LogicLib.nsh"

; 宏：自定义安装页面初始化
!macro customInit
  ; 检查 VC++ Redistributable
  Call CheckAndInstallVCRedist
!macroend

; 宏：自定义安装
!macro customInstall
  ; 创建必要的目录
  CreateDirectory "$INSTDIR\userdata"
  CreateDirectory "$INSTDIR\output"
  CreateDirectory "$INSTDIR\logs"
!macroend

; 宏：自定义卸载
!macro customUnInstall
  ; 卸载时询问是否删除用户数据
  MessageBox MB_YESNO "是否删除用户数据目录？这将会删除所有已保存的任务数据。" IDNO skipDeleteData
    RMDir /r "$INSTDIR\userdata"
    RMDir /r "$INSTDIR\output"
  skipDeleteData:
!macroend

; 函数：检查并安装 VC++ Redistributable
Function CheckAndInstallVCRedist
  ; 检查是否已安装 VC++ Redistributable
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  IfErrors 0 VCRedistInstalled
  
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  IfErrors 0 VCRedistInstalled
  
  ; 未安装，需要安装
  DetailPrint "需要安装 Visual C++ Redistributable..."
  
  ; 创建临时目录
  CreateDirectory "$TEMP\SentinelBrowserInstaller"
  
  ; 下载 VC++ Redistributable
  DetailPrint "正在下载 Visual C++ Redistributable (约 24MB)..."
  NSISdl::download /TIMEOUT=60000 "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\SentinelBrowserInstaller\vc_redist.x64.exe"
  Pop $0
  
  ${If} $0 == "success"
    DetailPrint "下载完成，正在安装 Visual C++ Redistributable..."
    ; 静默安装，不显示界面
    ExecWait '"$TEMP\SentinelBrowserInstaller\vc_redist.x64.exe" /install /quiet /norestart' $1
    
    ${If} $1 == "0"
      DetailPrint "Visual C++ Redistributable 安装成功"
    ${ElseIf} $1 == "3010"
      DetailPrint "Visual C++ Redistributable 安装成功（需要重启）"
      MessageBox MB_OK "Visual C++ Redistributable 已安装，但可能需要重启计算机才能生效。"
    ${Else}
      DetailPrint "Visual C++ Redistributable 安装失败，错误码: $1"
      MessageBox MB_OK "警告：Visual C++ Redistributable 自动安装失败。请手动下载安装。"
    ${EndIf}
  ${Else}
    DetailPrint "下载失败: $0"
    MessageBox MB_OK "警告：无法自动下载 Visual C++ Redistributable。如果启动失败，请手动下载安装。"
  ${EndIf}
  
  ; 清理临时文件
  Delete "$TEMP\SentinelBrowserInstaller\vc_redist.x64.exe"
  RMDir "$TEMP\SentinelBrowserInstaller"
  
  Goto VCRedistDone
  
VCRedistInstalled:
  DetailPrint "Visual C++ Redistributable 已安装"
  
VCRedistDone:
FunctionEnd
