; Sentinel Browser NSIS Installer Script
; 自动安装 VC++ Redistributable 和所有依赖

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; 应用程序信息
!define APP_NAME "Sentinel Browser"
!define APP_VERSION "2.0.0"
!define APP_PUBLISHER "Sentinel Team"
!define APP_WEBSITE "https://github.com/408943233/sentinel-browser"
!define VC_REDIST_URL "https://aka.ms/vs/17/release/vc_redist.x64.exe"
!define VC_REDIST_EXE "vc_redist.x64.exe"

; 安装程序配置
Name "${APP_NAME}"
OutFile "Sentinel-Browser-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\SentinelBrowser"
InstallDirRegKey HKCU "Software\SentinelBrowser" "InstallDir"
RequestExecutionLevel user  ; 不需要管理员权限

; 界面配置
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

; 页面
!insertmacro MUI_PAGE_WELCOME
; License page removed - using default electron-builder configuration
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; 语言
!insertmacro MUI_LANGUAGE "SimpChinese"

; 变量
Var VCInstalled
Var DownloadResult

; 检查 VC++ Redistributable 是否已安装
Function CheckVCRedist
    ; 检查注册表
    ClearErrors
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    IfErrors 0 VCInstalled
    
    ClearErrors
    ReadRegDWORD $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    IfErrors 0 VCInstalled
    
    ; 也检查 2015-2022 版本
    ClearErrors
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
    IfErrors 0 VCInstalled
    
    StrCpy $VCInstalled "0"
    Return
    
VCInstalled:
    StrCpy $VCInstalled "1"
FunctionEnd

; 下载并安装 VC++ Redistributable
Function InstallVCRedist
    DetailPrint "正在下载 Visual C++ Redistributable..."
    
    ; 创建临时目录
    CreateDirectory "$TEMP\SentinelBrowserInstaller"
    
    ; 下载 VC++ Redistributable
    nsisdl::download /TIMEOUT=30000 "${VC_REDIST_URL}" "$TEMP\SentinelBrowserInstaller\${VC_REDIST_EXE}"
    Pop $DownloadResult
    
    ${If} $DownloadResult == "success"
        DetailPrint "下载完成，正在安装 Visual C++ Redistributable..."
        
        ; 静默安装 VC++ Redistributable
        ExecWait '"$TEMP\SentinelBrowserInstaller\${VC_REDIST_EXE}" /install /quiet /norestart' $0
        
        ${If} $0 == "0"
            DetailPrint "Visual C++ Redistributable 安装成功"
        ${Else}
            DetailPrint "Visual C++ Redistributable 安装失败，错误码: $0"
            MessageBox MB_OK "Visual C++ Redistributable 安装失败。$
$
应用程序可能无法正常运行。$
$
请手动下载安装：$
${VC_REDIST_URL}"
        ${EndIf}
    ${Else}
        DetailPrint "下载失败: $DownloadResult"
        MessageBox MB_OK "无法自动下载 Visual C++ Redistributable。$
$
请手动下载安装：$
${VC_REDIST_URL}$
$
否则应用程序可能无法启动。"
    ${EndIf}
    
    ; 清理临时文件
    Delete "$TEMP\SentinelBrowserInstaller\${VC_REDIST_EXE}"
    RMDir "$TEMP\SentinelBrowserInstaller"
FunctionEnd

; 安装部分
Section "Install" SecInstall
    SectionIn RO
    
    ; 检查并安装 VC++ Redistributable
    Call CheckVCRedist
    ${If} $VCInstalled == "0"
        DetailPrint "需要安装 Visual C++ Redistributable"
        Call InstallVCRedist
    ${Else}
        DetailPrint "Visual C++ Redistributable 已安装"
    ${EndIf}
    
    ; 设置输出路径
    SetOutPath "$INSTDIR"
    
    ; 创建目录
    CreateDirectory "$INSTDIR\userdata"
    CreateDirectory "$INSTDIR\output"
    CreateDirectory "$INSTDIR\logs"
    
    ; 这里应该包含所有应用文件
    ; 实际文件由 electron-builder 打包时注入
    ; File /r "..\dist\win-unpacked\*.*"
    
    ; 创建快捷方式
    CreateDirectory "$SMPROGRAMS\Sentinel Browser"
    CreateShortcut "$SMPROGRAMS\Sentinel Browser\Sentinel Browser.lnk" "$INSTDIR\Sentinel Browser.exe"
    CreateShortcut "$DESKTOP\Sentinel Browser.lnk" "$INSTDIR\Sentinel Browser.exe"
    
    ; 写入注册表
    WriteRegStr HKCU "Software\SentinelBrowser" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\SentinelBrowser" "Version" "${APP_VERSION}"
    
    ; 写入卸载信息
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SentinelBrowser" \
        "DisplayName" "${APP_NAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SentinelBrowser" \
        "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SentinelBrowser" \
        "DisplayIcon" "$INSTDIR\Sentinel Browser.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SentinelBrowser" \
        "Publisher" "${APP_PUBLISHER}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SentinelBrowser" \
        "DisplayVersion" "${APP_VERSION}"
    
    ; 创建卸载程序
    WriteUninstaller "$INSTDIR\uninstall.exe"
    
SectionEnd

; 卸载部分
Section "Uninstall"
    ; 删除文件
    Delete "$INSTDIR\uninstall.exe"
    
    ; 删除快捷方式
    Delete "$SMPROGRAMS\Sentinel Browser\Sentinel Browser.lnk"
    Delete "$DESKTOP\Sentinel Browser.lnk"
    RMDir "$SMPROGRAMS\Sentinel Browser"
    
    ; 询问是否删除用户数据
    MessageBox MB_YESNO "是否删除用户数据目录？这将会删除所有已保存的任务数据。" IDNO SkipDataDelete
        RMDir /r "$INSTDIR\userdata"
        RMDir /r "$INSTDIR\output"
        RMDir /r "$INSTDIR\logs"
    SkipDataDelete:
    
    ; 删除安装目录
    RMDir /r "$INSTDIR"
    
    ; 删除注册表项
    DeleteRegKey HKCU "Software\SentinelBrowser"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SentinelBrowser"
    
SectionEnd
