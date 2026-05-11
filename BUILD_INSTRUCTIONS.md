# Sentinel Browser Windows 构建说明

## 一键安装包特性

新的 Windows 安装包具有以下特性：

1. **自动安装依赖** - 安装程序会自动检测并安装 Visual C++ Redistributable
2. **无需管理员权限** - 默认安装到用户目录，不需要管理员权限
3. **一键安装** - 点击"下一步"即可完成所有安装
4. **自动启动** - 安装完成后自动启动应用程序

## 构建步骤

### 1. 安装依赖

```bash
cd .trae/skills/sentinel-browser
npm install
```

### 2. 构建 Windows 安装包

```bash
npm run build:win
```

构建完成后，安装包位于：
```
dist/Sentinel-Browser-Setup-2.0.0.exe
```

## 安装包行为

### 安装过程

1. **检查依赖** - 自动检查是否已安装 VC++ Redistributable
2. **下载安装** - 如果未安装，自动下载（约 24MB）并静默安装
3. **安装应用** - 安装 Sentinel Browser 到用户目录
4. **创建快捷方式** - 在桌面和开始菜单创建快捷方式
5. **启动应用** - 安装完成后自动启动

### 安装目录

默认安装到：
```
C:\Users\<用户名>\AppData\Local\SentinelBrowser
```

### 卸载

通过 Windows 设置 → 应用 → 卸载，或运行安装目录中的 `uninstall.exe`

卸载时会询问是否删除用户数据。

## 故障排除

如果安装后仍无法启动，请参考 [WINDOWS_TROUBLESHOOTING.md](./WINDOWS_TROUBLESHOOTING.md)

## 技术细节

### NSIS 脚本

安装程序使用自定义 NSIS 脚本 (`build/installer.nsh`)：
- 自动检测 VC++ Redistributable
- 使用 NSISdl 插件下载依赖
- 静默安装，无需用户干预

### 启动检测

应用程序启动时会：
1. 检测 VC++ Redistributable 是否安装
2. 如果未安装，显示友好提示并提供下载链接
3. 捕获启动错误并显示详细错误信息

## 发布新版本

1. 更新 `package.json` 中的版本号
2. 运行 `npm run build:win`
3. 上传 `dist/Sentinel-Browser-Setup-<version>.exe` 到 GitHub Releases
4. 在 Release 说明中注明："此版本自动安装所有依赖，一键即可使用"
