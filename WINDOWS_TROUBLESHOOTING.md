# Windows 启动问题排查指南

## 问题描述
双击安装包或应用后没有任何反应。

## 常见原因和解决方案

### 1. 缺少 Visual C++ Redistributable ⭐最常见

**症状**: 双击后无任何反应，或闪现黑框后消失

**解决方案**:
1. 下载并安装 Visual C++ Redistributable：
   - 访问：https://aka.ms/vs/17/release/vc_redist.x64.exe
   - 或搜索 "Visual C++ Redistributable for Visual Studio 2015-2022"

2. 安装后重启电脑，再次尝试运行

### 2. 杀毒软件/Windows Defender 拦截

**症状**: 双击后无任何反应，或提示"Windows 已保护你的电脑"

**解决方案**:
1. 暂时关闭 Windows Defender 实时保护：
   - 设置 → 更新和安全 → Windows 安全中心 → 病毒和威胁防护 → 管理设置
   - 关闭"实时保护"

2. 或将应用添加到排除项：
   - 病毒和威胁防护 → 排除项 → 添加排除项 → 文件夹
   - 选择应用安装目录

3. 如果显示"Windows 已保护你的电脑"：
   - 点击"更多信息" → "仍要运行"

### 3. 权限不足

**症状**: 双击后无任何反应

**解决方案**:
1. 右键点击应用图标 → "以管理员身份运行"
2. 或右键 → 属性 → 兼容性 → 勾选"以管理员身份运行此程序"

### 4. 检查错误日志

如果上述方法无效，请检查错误日志：

**日志位置**:
- 临时目录：`C:\Users\<用户名>\AppData\Local\Temp\sentinel-browser-error.log`
- 应用日志：`C:\Users\<用户名>\AppData\Roaming\SentinelBrowser\logs\`

**查看方法**:
1. 按 `Win + R`，输入 `%temp%`，回车
2. 查找 `sentinel-browser-error.log` 文件
3. 用记事本打开查看错误信息

### 5. 命令行启动查看错误

1. 打开命令提示符（CMD）或 PowerShell
2. 进入应用目录：
   ```cmd
   cd "C:\Program Files\Sentinel Browser"
   ```
   或便携版目录
3. 运行应用：
   ```cmd
   "Sentinel Browser.exe" --enable-logging
   ```
4. 查看控制台输出的错误信息

### 6. 便携版 vs 安装版

如果安装版无法运行，尝试使用便携版（Portable）：
- 便携版无需安装，解压后直接运行
- 不会写入注册表，权限要求更低

### 7. 兼容模式

对于 Windows 10 22H2：
1. 右键应用图标 → 属性 → 兼容性
2. 勾选"以兼容模式运行这个程序"
3. 选择 "Windows 8" 或 "Windows 7"
4. 勾选"以管理员身份运行此程序"
5. 点击确定，再次尝试运行

### 8. 系统更新

确保 Windows 10 22H2 已安装最新更新：
1. 设置 → 更新和安全 → Windows 更新
2. 点击"检查更新"
3. 安装所有可用更新后重启

### 9. .NET Framework

确保已安装 .NET Framework 4.8 或更高版本：
- 控制面板 → 程序 → 启用或关闭 Windows 功能
- 确保 ".NET Framework 3.5" 和 ".NET Framework 4.8 Advanced Services" 已启用

### 10. 重新下载安装包

安装包可能在下载过程中损坏：
1. 删除当前安装包
2. 从 GitHub Releases 重新下载
3. 校验文件完整性（如有提供校验和）

## 如果以上方法都无效

请收集以下信息并提交 Issue：

1. **系统信息**：
   - Windows 版本（设置 → 系统 → 关于）
   - 系统类型（64位/32位）

2. **错误日志**：
   - `%temp%\sentinel-browser-error.log`
   - `%appdata%\SentinelBrowser\logs\`

3. **事件查看器**：
   - 右键开始菜单 → 事件查看器
   - Windows 日志 → 应用程序
   - 查找与 Sentinel Browser 相关的错误

4. **命令行输出**：
   - 使用命令行启动应用时的完整输出

## 快速诊断脚本

创建一个 `diagnose.bat` 文件，内容如下：

```batch
@echo off
echo ==========================================
echo Sentinel Browser 诊断脚本
echo ==========================================
echo.
echo 系统信息:
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type"
echo.
echo 检查 Visual C++ Redistributable...
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v Version 2>nul
if %errorlevel% == 0 (
    echo [OK] Visual C++ Redistributable 已安装
) else (
    echo [MISSING] Visual C++ Redistributable 未安装
)
echo.
echo 检查 .NET Framework...
reg query "HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" /v Version 2>nul
if %errorlevel% == 0 (
    echo [OK] .NET Framework 已安装
) else (
    echo [MISSING] .NET Framework 未安装
)
echo.
echo 检查错误日志...
if exist "%temp%\sentinel-browser-error.log" (
    echo [FOUND] 发现错误日志:
    type "%temp%\sentinel-browser-error.log"
) else (
    echo [NOT FOUND] 未找到错误日志
)
echo.
echo 按任意键退出...
pause >nul
```

双击运行此脚本，查看诊断结果。

## 联系支持

如果问题仍然无法解决，请提交 Issue 到：
https://github.com/408943233/sentinel-browser/issues

附上：
- 诊断脚本输出
- 错误日志文件
- 系统信息截图
